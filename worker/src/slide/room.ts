/**
 * SlideRoom, Durable Object du mode competitif de Slide.
 *
 * Un seul plateau partage. Chacun son tour, dans un ordre qui pivote a chaque
 * tour de table : le joueur actif prend une carte de la riviere, decale une
 * ligne ou une colonne, encaisse les groupes que son coup a formes (a sa
 * couleur), puis termine son tour. Premier a l'objectif : victoire.
 *
 * L'etat de jeu est en memoire ; seul `initialized` et `hostPseudo` sont
 * persistes (comme les autres jeux), pour survivre a une eviction du DO.
 */

import { ROOM_CONFIG } from "../shared/types";
import { validatePseudo, pseudosEqual } from "../shared/moderation";
import {
  Card,
  Group,
  makeBag,
  fillBoard,
  edgesOf,
  applyPush,
  litGroups,
  scoreOf,
} from "./engine";
import type {
  ClientMessage,
  ServerMessage,
  SlidePlayer,
  GameStateDTO,
  Phase,
  TurnPhase,
  SlideErrorCode,
} from "./messages";

interface Session {
  pseudo: string;
  ws: WebSocket | null;
  color: number;
  score: number;
  joinedAt: number;
}

const MIN_TARGET = 10;
const MAX_TARGET = 1_000_000_000;
const ALLOWED_SIZES = [4, 5, 6, 7];
const MIN_TURN_SECONDS = 10;
const MAX_TURN_SECONDS = 120;
const DEFAULT_TURN_SECONDS = 20;

export class SlideRoom {
  private state: DurableObjectState;
  private players: Map<string, Session>;
  private wsToPseudo: Map<WebSocket, string>;
  private hostPseudo: string | null;

  private phase: Phase;
  private gridSize: number;
  private target: number;

  // Etat de jeu
  private board: Card[][];
  private bag: number[];
  private river: Card[];
  private turnOrder: string[];
  private activeIndex: number;
  private round: number;
  private turnPhase: TurnPhase;
  private lit: Group[];
  private nextId: number;
  private turnSeconds: number;
  private turnEndsAt: number;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.players = new Map();
    this.wsToPseudo = new Map();
    this.hostPseudo = null;
    this.phase = "lobby";
    this.gridSize = 5;
    this.target = 50;
    this.board = [];
    this.bag = [];
    this.river = [];
    this.turnOrder = [];
    this.activeIndex = 0;
    this.round = 0;
    this.turnPhase = "push";
    this.lit = [];
    this.nextId = 1;
    this.turnSeconds = DEFAULT_TURN_SECONDS;
    this.turnEndsAt = 0;

    this.state.blockConcurrencyWhile(async () => {
      try {
        const h = await this.state.storage.get<string>("hostPseudo");
        if (typeof h === "string" && h.length > 0) this.hostPseudo = h;
      } catch {
        /* tolerant */
      }
    });
  }

  private async persistHost(): Promise<void> {
    try {
      if (this.hostPseudo) await this.state.storage.put("hostPseudo", this.hostPseudo);
      else await this.state.storage.delete("hostPseudo");
    } catch {
      /* ignore */
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/__internal/exists")) {
      const init = await this.state.storage.get<boolean>("initialized");
      return Response.json({ exists: init === true });
    }
    if (url.pathname.endsWith("/__internal/init")) {
      await this.state.storage.put("initialized", true);
      return Response.json({ ok: true });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    server.addEventListener("message", (e) => this.onMessage(server, e.data as string));
    server.addEventListener("close", () => this.onClose(server));
    server.addEventListener("error", () => this.onClose(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  // ========================= Routage messages =========================
  private onMessage(ws: WebSocket, raw: string): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      this.err(ws, "INVALID_MESSAGE", "Message non JSON.");
      return;
    }
    switch (msg.type) {
      case "join":
        return this.onJoin(ws, msg.pseudo);
      case "start":
        return this.onStart(ws, msg.gridSize, msg.target, msg.turnSeconds);
      case "push":
        return this.onPush(ws, msg.cardId, msg.kind, msg.index, msg.fromStart);
      case "claim":
        return this.onClaim(ws, msg.key);
      case "endTurn":
        return this.onEndTurn(ws);
      case "timeout":
        return this.onTimeout(ws);
      case "endGame":
        return this.onEndGame(ws);
      case "backToLobby":
        return this.onBackToLobby(ws);
      default:
        this.err(ws, "INVALID_MESSAGE", "Type inconnu.");
    }
  }

  private onJoin(ws: WebSocket, rawPseudo: string): void {
    const v = validatePseudo(rawPseudo);
    if (!v.ok) {
      this.err(ws, "PSEUDO_INVALID", v.error);
      ws.close();
      return;
    }
    const pseudo = v.normalized;

    // Reconnexion (exacte ou variante casse/accents)
    for (const [p, s] of this.players.entries()) {
      if (p !== pseudo && !pseudosEqual(p, pseudo)) continue;
      if (s.ws !== null) {
        this.err(ws, "PSEUDO_TAKEN", "Ce pseudo est deja pris.");
        ws.close();
        return;
      }
      s.ws = ws;
      this.wsToPseudo.set(ws, p);
      this.sendSnapshot(ws, p);
      this.broadcastRoom();
      return;
    }

    if (this.players.size >= ROOM_CONFIG.MAX_PLAYERS) {
      this.err(ws, "ROOM_FULL", "Room pleine.");
      ws.close();
      return;
    }
    // Nouveau joueur : on ne rejoint pas une partie deja lancee (v1).
    if (this.phase !== "lobby") {
      this.err(ws, "WRONG_PHASE", "Partie en cours, attends la prochaine.");
      ws.close();
      return;
    }

    const session: Session = {
      pseudo,
      ws,
      color: this.freeColor(),
      score: 0,
      joinedAt: Date.now(),
    };
    this.players.set(pseudo, session);
    this.wsToPseudo.set(ws, pseudo);

    const first = this.players.size === 1;
    if ((this.hostPseudo === null && first) || (this.hostPseudo !== null && pseudosEqual(pseudo, this.hostPseudo))) {
      this.hostPseudo = pseudo;
      void this.persistHost();
    }

    this.sendSnapshot(ws, pseudo);
    this.broadcastRoom();
  }

  private freeColor(): number {
    const used = new Set([...this.players.values()].map((p) => p.color));
    for (let i = 0; i < ROOM_CONFIG.MAX_PLAYERS; i++) if (!used.has(i)) return i;
    return 0;
  }

  // ========================= Cycle de jeu =========================
  private onStart(ws: WebSocket, gridSize: number, target: number, turnSeconds?: number): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (!pseudo || pseudo !== this.hostPseudo) return this.err(ws, "NOT_HOST", "Seul l'hote lance.");
    if (this.phase !== "lobby") return this.err(ws, "WRONG_PHASE", "Deja lancee.");
    const connected = this.connected();
    if (connected.length < ROOM_CONFIG.MIN_PLAYERS)
      return this.err(ws, "NOT_ENOUGH_PLAYERS", "Il faut au moins 2 joueurs.");

    this.gridSize = ALLOWED_SIZES.includes(gridSize) ? gridSize : 5;
    this.target = Math.max(MIN_TARGET, Math.min(MAX_TARGET, Math.round(target) || 50));
    this.turnSeconds = Math.max(
      MIN_TURN_SECONDS,
      Math.min(MAX_TURN_SECONDS, Math.round(turnSeconds ?? DEFAULT_TURN_SECONDS) || DEFAULT_TURN_SECONDS)
    );

    // reset scores
    for (const p of this.players.values()) p.score = 0;

    this.nextId = 1;
    this.bag = makeBag();
    this.ensureBag(this.gridSize * this.gridSize + this.riverSize() + 16);
    this.board = fillBoard(this.gridSize, this.bag, () => this.nextId++);
    this.turnOrder = this.shuffleArray(connected.map((p) => p.pseudo));
    this.activeIndex = 0;
    this.round = 1;
    this.river = [];
    this.refillRiver();
    this.turnPhase = "push";
    this.lit = [];
    this.phase = "playing";
    this.armTurnTimer();
    this.broadcastGame();
  }

  private onPush(ws: WebSocket, cardId: number, kind: "row" | "col", index: number, fromStart: boolean): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (this.phase !== "playing") return this.err(ws, "WRONG_PHASE", "Pas en jeu.");
    if (pseudo !== this.activePseudo()) return this.err(ws, "NOT_YOUR_TURN", "Ce n'est pas ton tour.");
    if (this.turnPhase !== "push") return this.err(ws, "WRONG_PHASE", "Tu as deja joue ta carte.");
    const ri = this.river.findIndex((c) => c.id === cardId);
    if (ri < 0) return this.err(ws, "INVALID_MOVE", "Carte absente de la riviere.");
    if (!Number.isInteger(index) || index < 0 || index >= this.gridSize || (kind !== "row" && kind !== "col"))
      return this.err(ws, "INVALID_MOVE", "Coup invalide.");

    const before = edgesOf(this.board, this.gridSize);
    const inserted = this.river.splice(ri, 1)[0];
    const fallen = applyPush(this.board, this.gridSize, kind, index, fromStart, inserted);
    this.bag.push(fallen.value);
    this.lit = litGroups(this.board, this.gridSize, before);
    this.turnPhase = "claim";
    this.broadcastGame();
  }

  private onClaim(ws: WebSocket, key: string): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (this.phase !== "playing") return this.err(ws, "WRONG_PHASE", "Pas en jeu.");
    if (pseudo !== this.activePseudo()) return this.err(ws, "NOT_YOUR_TURN", "Ce n'est pas ton tour.");
    if (this.turnPhase !== "claim") return this.err(ws, "WRONG_PHASE", "Rien a encaisser.");
    const gi = this.lit.findIndex((g) => g.key === key);
    if (gi < 0) return this.err(ws, "INVALID_MOVE", "Groupe non encaissable.");
    const g = this.lit[gi];
    const me = this.players.get(pseudo!)!;
    me.score += scoreOf(g);
    // Retire les cartes du groupe, recomble par du tirage au hasard
    this.ensureBag(g.cells.length + 4);
    for (const cell of g.cells) {
      this.bag.push(this.board[cell.r][cell.c].value);
      this.board[cell.r][cell.c] = { id: this.nextId++, value: this.bag.shift()! };
    }
    this.lit.splice(gi, 1);

    if (me.score >= this.target) {
      this.finish(me.pseudo);
      return;
    }
    this.broadcastGame();
  }

  private onEndTurn(ws: WebSocket): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (this.phase !== "playing") return this.err(ws, "WRONG_PHASE", "Pas en jeu.");
    if (pseudo !== this.activePseudo()) return this.err(ws, "NOT_YOUR_TURN", "Ce n'est pas ton tour.");
    if (this.turnPhase !== "claim") return this.err(ws, "WRONG_PHASE", "Joue d'abord ta carte.");
    this.advanceTurn();
  }

  private onBackToLobby(ws: WebSocket): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (pseudo !== this.hostPseudo) return this.err(ws, "NOT_HOST", "Seul l'hote peut relancer.");
    this.phase = "lobby";
    this.lit = [];
    this.turnEndsAt = 0;
    this.broadcastRoom();
  }

  // L'hote peut clore la partie a tout moment : le classement actuel fait foi,
  // le joueur en tete l'emporte. Utile quand l'objectif est haut/illimite.
  private onEndGame(ws: WebSocket): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (pseudo !== this.hostPseudo) return this.err(ws, "NOT_HOST", "Seul l'hote peut terminer la partie.");
    if (this.phase !== "playing") return this.err(ws, "WRONG_PHASE", "Pas en jeu.");
    const leader = this.snapshot().slice().sort((a, b) => b.score - a.score)[0];
    this.finish(leader ? leader.pseudo : "");
  }

  private advanceTurn(): void {
    const n = this.turnOrder.length;
    this.turnPhase = "push";
    this.lit = [];
    // On avance d'un joueur ; en bout de liste on repart au premier (nouvelle
    // manche) et on recharge la rivière. Pas de rotation de l'ordre : elle
    // faisait rejouer le dernier joueur en début de manche suivante.
    for (let step = 0; step < n; step++) {
      this.activeIndex++;
      if (this.activeIndex >= n) {
        this.activeIndex = 0;
        this.round++;
        this.refillRiver();
      }
      const p = this.players.get(this.turnOrder[this.activeIndex]);
      if (p && p.ws) break; // joueur connecte trouve
    }
    this.armTurnTimer();
    this.broadcastGame();
  }

  // Arme le minuteur du tour courant. Les clients affichent le décompte à
  // partir de turnEndsAt ; quand il expire, n'importe quel client peut
  // envoyer "timeout" pour débloquer la partie (voir onTimeout).
  private armTurnTimer(): void {
    this.turnEndsAt = this.turnSeconds > 0 ? Date.now() + this.turnSeconds * 1000 : 0;
  }

  private onTimeout(_ws: WebSocket): void {
    if (this.phase !== "playing") return;
    if (this.turnEndsAt <= 0) return;
    // Tolérance de 300 ms pour absorber la latence réseau / horloges.
    if (Date.now() < this.turnEndsAt - 300) return;
    this.advanceTurn();
  }

  private finish(winner: string): void {
    this.phase = "finished";
    this.lit = [];
    this.turnEndsAt = 0;
    const ranking = this.snapshot().sort((a, b) => b.score - a.score);
    this.broadcast({ type: "finished", players: this.snapshot(), ranking, winner });
  }

  // ========================= Helpers de jeu =========================
  private riverSize(): number {
    // La rivière contient exactement une carte par joueur (une carte piochée
    // par joueur et par tour de table).
    return Math.max(2, this.turnOrder.length || this.connected().length);
  }
  private ensureBag(min: number): void {
    while (this.bag.length < min) this.bag = this.bag.concat(makeBag());
  }
  private refillRiver(): void {
    const size = this.riverSize();
    this.ensureBag(size + 4);
    while (this.river.length < size) this.river.push({ id: this.nextId++, value: this.bag.shift()! });
  }
  private activePseudo(): string {
    return this.turnOrder[this.activeIndex] ?? "";
  }
  private shuffleArray<T>(a: T[]): T[] {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ========================= Connexions =========================
  private onClose(ws: WebSocket): void {
    const pseudo = this.wsToPseudo.get(ws);
    this.wsToPseudo.delete(ws);
    if (!pseudo) return;
    const s = this.players.get(pseudo);
    if (!s || s.ws !== ws) return;
    s.ws = null;

    if (this.phase === "lobby") {
      // En lobby on retire vraiment le joueur ; on transfere l'hote si besoin.
      this.players.delete(pseudo);
      if (pseudo === this.hostPseudo) {
        const next = this.connected()[0];
        this.hostPseudo = next ? next.pseudo : null;
        void this.persistHost();
      }
      this.broadcastRoom();
      return;
    }

    // En jeu : on garde le joueur (score conserve, reconnexion possible).
    if (this.phase === "playing" && pseudo === this.activePseudo()) {
      this.advanceTurn(); // on saute le tour du joueur parti
    } else {
      this.broadcastGame();
    }
  }

  private connected(): Session[] {
    return [...this.players.values()].filter((p) => p.ws !== null);
  }

  private snapshot(): SlidePlayer[] {
    return [...this.players.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({
        pseudo: p.pseudo,
        isHost: p.pseudo === this.hostPseudo,
        color: p.color,
        score: p.score,
        isConnected: p.ws !== null,
      }));
  }

  private gameDTO(): GameStateDTO {
    const active = this.players.get(this.activePseudo());
    return {
      gridSize: this.gridSize,
      target: this.target,
      board: this.board.map((row) => row.map((c) => ({ id: c.id, value: c.value }))),
      river: this.river.map((c) => ({ id: c.id, value: c.value })),
      turnOrder: [...this.turnOrder],
      activePseudo: this.activePseudo(),
      activeColor: active ? active.color : 0,
      turnPhase: this.turnPhase,
      lit: this.lit.map((g) => ({ key: g.key, value: g.value, cells: g.cells })),
      round: this.round,
      turnSeconds: this.turnSeconds,
      turnEndsAt: this.turnEndsAt,
    };
  }

  private sendSnapshot(ws: WebSocket, pseudo: string): void {
    this.send(ws, {
      type: "joined",
      pseudo,
      isHost: pseudo === this.hostPseudo,
      players: this.snapshot(),
      hostPseudo: this.hostPseudo ?? "",
      phase: this.phase,
      config: { gridSize: this.gridSize, target: this.target, turnSeconds: this.turnSeconds },
      game: this.phase === "lobby" ? null : this.gameDTO(),
    });
  }

  private broadcastRoom(): void {
    this.broadcast({
      type: "room_state",
      players: this.snapshot(),
      hostPseudo: this.hostPseudo ?? "",
      phase: this.phase,
    });
  }
  private broadcastGame(): void {
    this.broadcast({ type: "game_state", players: this.snapshot(), phase: this.phase, game: this.gameDTO() });
  }

  private broadcast(msg: ServerMessage, except?: WebSocket): void {
    for (const s of this.players.values()) {
      if (!s.ws || s.ws === except) continue;
      this.send(s.ws, msg);
    }
  }
  private send(ws: WebSocket, data: ServerMessage): void {
    try {
      ws.send(JSON.stringify(data));
    } catch {
      const p = this.wsToPseudo.get(ws);
      if (p) {
        const s = this.players.get(p);
        if (s) s.ws = null;
        this.wsToPseudo.delete(ws);
      }
    }
  }
  private err(ws: WebSocket, code: SlideErrorCode, message: string): void {
    this.send(ws, { type: "error", code, message });
  }
}

/**
 * MotsMelesRoom, Durable Object du mode competitif "grille commune".
 *
 * Une seule grille partagee, generee cote serveur (autoritaire). Chacun cherche
 * les mots caches en meme temps ; le premier a reperer un mot le verrouille a sa
 * couleur, il n'est plus disponible pour les autres. Score = nombre de mots
 * trouves. Quand la grille est videe, le finale mot mystere s'ouvre : premier a
 * le deviner gagne un point bonus et cloture. Departage au chrono (qui a
 * atteint son total le plus tot).
 *
 * Comme les autres jeux, seuls `initialized` et `hostPseudo` sont persistes.
 */

import { ROOM_CONFIG } from "../shared/types";
import { validatePseudo, pseudosEqual } from "../shared/moderation";
import { generate, LEVELS, type Cell, type PlacedWord } from "./generator";
import type {
  ClientMessage, ServerMessage, MmPlayer, GameStateDTO, FoundWord, Phase, MmErrorCode,
} from "./messages";

interface Session {
  pseudo: string;
  ws: WebSocket | null;
  color: number;
  score: number;
  lastFindAt: number; // ms du dernier mot trouve (departage)
  joinedAt: number;
}

interface WordState {
  word: string;
  cells: Cell[];
  key: string;   // cle canonique des cases (sens direct)
  rkey: string;  // cle canonique (sens inverse)
  found: boolean;
  byPseudo: string | null;
  color: number;
}

const ALLOWED_SIZES = [10, 12, 14];
const ALLOWED_LEVELS = ["facile", "moyen", "difficile"];

function cellKey(cells: Cell[]): string {
  return cells.map((c) => c.r + "," + c.c).join(";");
}

export class MotsMelesRoom {
  private state: DurableObjectState;
  private players: Map<string, Session>;
  private wsToPseudo: Map<WebSocket, string>;
  private hostPseudo: string | null;

  private phase: Phase;
  private gridSize: number;
  private level: string;

  // Etat de jeu
  private grid: string[][];
  private words: WordState[];

  constructor(state: DurableObjectState) {
    this.state = state;
    this.players = new Map();
    this.wsToPseudo = new Map();
    this.hostPseudo = null;
    this.phase = "lobby";
    this.gridSize = 12;
    this.level = "moyen";
    this.grid = [];
    this.words = [];

    this.state.blockConcurrencyWhile(async () => {
      try {
        const h = await this.state.storage.get<string>("hostPseudo");
        if (typeof h === "string" && h.length > 0) this.hostPseudo = h;
      } catch { /* tolerant */ }
    });
  }

  private async persistHost(): Promise<void> {
    try {
      if (this.hostPseudo) await this.state.storage.put("hostPseudo", this.hostPseudo);
      else await this.state.storage.delete("hostPseudo");
    } catch { /* ignore */ }
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
    const client = pair[0], server = pair[1];
    server.accept();
    server.addEventListener("message", (e) => this.onMessage(server, e.data as string));
    server.addEventListener("close", () => this.onClose(server));
    server.addEventListener("error", () => this.onClose(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  // ========================= Routage =========================
  private onMessage(ws: WebSocket, raw: string): void {
    let msg: ClientMessage;
    try { msg = JSON.parse(raw) as ClientMessage; }
    catch { return this.err(ws, "INVALID_MESSAGE", "Message non JSON."); }
    switch (msg.type) {
      case "join": return this.onJoin(ws, msg.pseudo);
      case "start": return this.onStart(ws, msg.gridSize, msg.level);
      case "claim": return this.onClaim(ws, msg.cells);
      case "endGame": return this.onEndGame(ws);
      case "backToLobby": return this.onBackToLobby(ws);
      default: this.err(ws, "INVALID_MESSAGE", "Type inconnu.");
    }
  }

  private onJoin(ws: WebSocket, rawPseudo: string): void {
    const v = validatePseudo(rawPseudo);
    if (!v.ok) { this.err(ws, "PSEUDO_INVALID", v.error); ws.close(); return; }
    const pseudo = v.normalized;

    for (const [p, s] of this.players.entries()) {
      if (p !== pseudo && !pseudosEqual(p, pseudo)) continue;
      if (s.ws !== null) { this.err(ws, "PSEUDO_TAKEN", "Ce pseudo est deja pris."); ws.close(); return; }
      s.ws = ws;
      this.wsToPseudo.set(ws, p);
      this.sendSnapshot(ws, p);
      this.broadcastRoom();
      return;
    }

    if (this.players.size >= ROOM_CONFIG.MAX_PLAYERS) {
      this.err(ws, "ROOM_FULL", "Room pleine."); ws.close(); return;
    }
    if (this.phase !== "lobby") {
      this.err(ws, "WRONG_PHASE", "Partie en cours, attends la prochaine."); ws.close(); return;
    }

    const session: Session = {
      pseudo, ws, color: this.freeColor(), score: 0, lastFindAt: 0, joinedAt: Date.now(),
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
  private onStart(ws: WebSocket, gridSize: number, level: string): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (!pseudo || pseudo !== this.hostPseudo) return this.err(ws, "NOT_HOST", "Seul l'hote lance.");
    if (this.phase !== "lobby") return this.err(ws, "WRONG_PHASE", "Deja lancee.");
    if (this.connected().length < ROOM_CONFIG.MIN_PLAYERS)
      return this.err(ws, "NOT_ENOUGH_PLAYERS", "Il faut au moins 2 joueurs.");

    this.gridSize = ALLOWED_SIZES.includes(gridSize) ? gridSize : 12;
    this.level = ALLOWED_LEVELS.includes(level) ? level : "moyen";

    let gen = null;
    for (let attempt = 0; attempt < 5 && !gen; attempt++) {
      gen = generate({ size: this.gridSize, dirKeys: LEVELS[this.level] });
    }
    if (!gen) return this.err(ws, "INVALID_MOVE", "Generation de grille impossible, reessaie.");

    this.grid = gen.grid;
    this.words = gen.placed.map((p: PlacedWord) => ({
      word: p.word, cells: p.cells,
      key: cellKey(p.cells), rkey: cellKey([...p.cells].reverse()),
      found: false, byPseudo: null, color: 0,
    }));

    for (const p of this.players.values()) { p.score = 0; p.lastFindAt = 0; }

    this.phase = "playing";
    this.broadcastGame();
  }

  private onClaim(ws: WebSocket, cells: Cell[]): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (!pseudo) return;
    if (this.phase !== "playing") return this.err(ws, "WRONG_PHASE", "Pas en jeu.");
    if (!this.validStraight(cells)) return this.err(ws, "INVALID_MOVE", "Selection invalide.");

    const key = cellKey(cells);
    for (const w of this.words) {
      if (w.found) continue;
      if (key === w.key || key === w.rkey) {
        const me = this.players.get(pseudo)!;
        w.found = true; w.byPseudo = pseudo; w.color = me.color;
        me.score++; me.lastFindAt = Date.now();
        const fw: FoundWord = { word: w.word, cells: w.cells, color: me.color, pseudo };
        const remaining = this.words.filter((x) => !x.found).length;
        this.broadcast({ type: "found", players: this.snapshot(), word: fw, remaining });
        // Grille videe : la partie se termine, le classement fait foi.
        if (remaining === 0) this.finish(this.leader());
        return;
      }
    }
    // Pas un mot attendu : si c'est un segment d'un mot plus long non trouve, on guide.
    for (const w of this.words) {
      if (w.found) continue;
      if (this.isSubRun(cells, w.cells) || this.isSubRun(cells, [...w.cells].reverse())) {
        return this.send(ws, { type: "hint", kind: "longer", message: "Plus long ! le mot ne s'arrete pas la." });
      }
    }
    this.send(ws, { type: "hint", kind: "nope", message: "Pas un mot cache ici." });
  }

  private onEndGame(ws: WebSocket): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (pseudo !== this.hostPseudo) return this.err(ws, "NOT_HOST", "Seul l'hote peut terminer.");
    if (this.phase !== "playing") return this.err(ws, "WRONG_PHASE", "Pas en jeu.");
    this.finish(this.leader());
  }

  private onBackToLobby(ws: WebSocket): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (pseudo !== this.hostPseudo) return this.err(ws, "NOT_HOST", "Seul l'hote peut relancer.");
    this.phase = "lobby";
    this.broadcastRoom();
  }

  private leader(): string {
    const r = this.rank();
    return r.length ? r[0].pseudo : "";
  }
  private rank(): MmPlayer[] {
    return this.snapshot().sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const la = this.players.get(a.pseudo)?.lastFindAt || Infinity;
      const lb = this.players.get(b.pseudo)?.lastFindAt || Infinity;
      return la - lb; // a atteint son total plus tot = mieux classe
    });
  }

  private finish(winner: string): void {
    this.phase = "finished";
    this.broadcast({
      type: "finished", players: this.snapshot(), ranking: this.rank(), winner,
    });
  }

  // ========================= Validation selection =========================
  private validStraight(cells: Cell[]): boolean {
    if (!Array.isArray(cells) || cells.length < 2) return false;
    const n = this.gridSize;
    for (const c of cells) {
      if (!c || !Number.isInteger(c.r) || !Number.isInteger(c.c)) return false;
      if (c.r < 0 || c.r >= n || c.c < 0 || c.c >= n) return false;
    }
    const dr = Math.sign(cells[1].r - cells[0].r);
    const dc = Math.sign(cells[1].c - cells[0].c);
    if (dr === 0 && dc === 0) return false;
    for (let i = 1; i < cells.length; i++) {
      if (cells[i].r - cells[i - 1].r !== dr || cells[i].c - cells[i - 1].c !== dc) return false;
    }
    return true;
  }

  private isSubRun(S: Cell[], W: Cell[]): boolean {
    if (S.length >= W.length) return false;
    for (let off = 0; off + S.length <= W.length; off++) {
      let ok = true;
      for (let i = 0; i < S.length; i++) {
        if (S[i].r !== W[off + i].r || S[i].c !== W[off + i].c) { ok = false; break; }
      }
      if (ok) return true;
    }
    return false;
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
    this.broadcastRoom();
  }

  private connected(): Session[] {
    return [...this.players.values()].filter((p) => p.ws !== null);
  }

  private snapshot(): MmPlayer[] {
    return [...this.players.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({
        pseudo: p.pseudo, isHost: p.pseudo === this.hostPseudo, color: p.color,
        score: p.score, isConnected: p.ws !== null,
      }));
  }

  private foundDTO(): FoundWord[] {
    return this.words.filter((w) => w.found).map((w) => ({
      word: w.word, cells: w.cells, color: w.color, pseudo: w.byPseudo || "",
    }));
  }

  private gameDTO(): GameStateDTO {
    return {
      gridSize: this.gridSize,
      grid: this.grid.map((row) => row.slice()),
      totalWords: this.words.length,
      found: this.foundDTO(),
      level: this.level,
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
      config: { gridSize: this.gridSize, level: this.level },
      game: this.phase === "lobby" ? null : this.gameDTO(),
    });
  }

  private broadcastRoom(): void {
    this.broadcast({ type: "room_state", players: this.snapshot(), hostPseudo: this.hostPseudo ?? "", phase: this.phase });
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
    try { ws.send(JSON.stringify(data)); }
    catch {
      const p = this.wsToPseudo.get(ws);
      if (p) { const s = this.players.get(p); if (s) s.ws = null; this.wsToPseudo.delete(ws); }
    }
  }
  private err(ws: WebSocket, code: MmErrorCode, message: string): void {
    this.send(ws, { type: "error", code, message });
  }
}

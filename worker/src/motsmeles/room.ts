/**
 * MotsMelesRoom, Durable Object des modes competitifs de Mots meles.
 * Deux modes choisis par l'hote dans le salon :
 *
 *  - "commune" : grille commune interactive, verrouillage aux couleurs, score au
 *                nombre de mots, fin quand la grille est videe. Pas de mystere.
 *  - "chacun"  : chacun sa grille (identique), en parallele, minuteur cote
 *                serveur (alarme DO). Score au nombre de mots + bonus mystere
 *                quand on vide sa grille. Classement a la fin du minuteur.
 *
 * En "chacun", l'etat (cases trouvees, mystere) est PROPRE a chaque joueur : le
 * serveur construit un game_state par destinataire.
 *
 * Seuls `initialized` et `hostPseudo` sont persistes.
 */

import { ROOM_CONFIG } from "../shared/types";
import { validatePseudo, pseudosEqual } from "../shared/moderation";
import { generate, LEVELS, type Cell, type FindableWord } from "./generator";
import type {
  ClientMessage, ServerMessage, MmPlayer, GameStateDTO, FoundWord, Phase, Mode, MmErrorCode,
} from "./messages";

interface Session {
  pseudo: string;
  ws: WebSocket | null;
  color: number;
  score: number;
  solvedMystery: boolean;
  lastFindAt: number;
  joinedAt: number;
  foundKeys: Set<string>; // "chacun" : cles des mots trouves par CE joueur
  teamId: number;         // 0 = sans equipe ; 1..4 = equipe
}

interface WordState {
  word: string;
  cells: Cell[];
  key: string;
  rkey: string;
  found: boolean;       // "commune" : verrouille globalement
  byPseudo: string | null;
  color: number;
}

const ALLOWED_SIZES = [10, 12, 14];
const ALLOWED_LEVELS = ["facile", "moyen", "difficile"];
const ALLOWED_DURATIONS = [180, 300, 420];
const MYSTERY_BONUS = 3;
const MAX_TEAMS = 4;

function cellKey(cells: Cell[]): string {
  return cells.map((c) => c.r + "," + c.c).join(";");
}

export class MotsMelesRoom {
  private state: DurableObjectState;
  private players: Map<string, Session>;
  private wsToPseudo: Map<WebSocket, string>;
  private hostPseudo: string | null;

  private phase: Phase;
  private mode: Mode;
  private teamsOn: boolean;
  private gridSize: number;
  private level: string;
  private durationSec: number;
  private endsAt: number | null;

  private grid: string[][];
  private words: WordState[];
  private mysteryWord: string;
  private mysteryDef: string;
  private mysteryCells: Cell[];

  constructor(state: DurableObjectState) {
    this.state = state;
    this.players = new Map();
    this.wsToPseudo = new Map();
    this.hostPseudo = null;
    this.phase = "lobby";
    this.mode = "commune";
    this.teamsOn = false;
    this.gridSize = 12;
    this.level = "moyen";
    this.durationSec = 300;
    this.endsAt = null;
    this.grid = [];
    this.words = [];
    this.mysteryWord = "";
    this.mysteryDef = "";
    this.mysteryCells = [];

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

  // Alarme DO : fin du minuteur en mode "chacun".
  async alarm(): Promise<void> {
    if (this.phase === "playing" && this.mode === "chacun") this.finish(this.leader());
  }

  // ========================= Routage =========================
  private onMessage(ws: WebSocket, raw: string): void {
    let msg: ClientMessage;
    try { msg = JSON.parse(raw) as ClientMessage; }
    catch { return this.err(ws, "INVALID_MESSAGE", "Message non JSON."); }
    switch (msg.type) {
      case "join": return this.onJoin(ws, msg.pseudo);
      case "setTeamsMode": return this.onSetTeamsMode(ws, msg.on);
      case "setTeam": return this.onSetTeam(ws, msg.pseudo, msg.teamId);
      case "start": return this.onStart(ws, msg.mode, msg.gridSize, msg.level, msg.duration);
      case "claim": return this.onClaim(ws, msg.cells);
      case "mysteryGuess": return this.onMysteryGuess(ws, msg.guess);
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
      // Meme pseudo deja present. Au lieu de refuser (ce qui casse le rafraichissement,
      // l'ancien socket n'etant pas encore ferme cote serveur), on prend la place :
      // dernier connecte gagne. On reassigne AVANT de fermer l'ancien et on le
      // retire de la table, pour que son evenement close (sync ou tardif) soit
      // sans effet (guard onClose).
      const old = s.ws;
      s.ws = ws;
      this.wsToPseudo.set(ws, p);
      if (old && old !== ws) {
        this.wsToPseudo.delete(old);
        try { old.close(4000, "reconnect"); } catch { /* ignore */ }
      }
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
      pseudo, ws, color: this.freeColor(), score: 0, solvedMystery: false,
      lastFindAt: 0, joinedAt: Date.now(), foundKeys: new Set(),
      teamId: this.teamsOn ? this.smallestTeam() : 0,
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

  // ========================= Equipes (salon) =========================
  private teamCounts(): Record<number, number> {
    const c: Record<number, number> = {};
    for (const p of this.players.values()) c[p.teamId] = (c[p.teamId] || 0) + 1;
    return c;
  }
  // Renvoie l'equipe (1..2 par defaut) la moins peuplee, pour une repartition
  // de depart equilibree quand on active le mode equipes ou qu'un joueur arrive.
  private smallestTeam(): number {
    const c = this.teamCounts();
    let best = 1, bestN = Infinity;
    for (let t = 1; t <= 2; t++) {
      const n = c[t] || 0;
      if (n < bestN) { bestN = n; best = t; }
    }
    return best;
  }
  private nonEmptyTeams(): number[] {
    const c = this.teamCounts();
    return Object.keys(c).map(Number).filter((t) => t >= 1 && c[t] > 0);
  }

  private onSetTeamsMode(ws: WebSocket, on: boolean): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (pseudo !== this.hostPseudo) return this.err(ws, "NOT_HOST", "Seul l'hote regle les equipes.");
    if (this.phase !== "lobby") return this.err(ws, "WRONG_PHASE", "Pas dans le salon.");
    this.teamsOn = !!on;
    if (this.teamsOn) {
      // Repartition de depart : alternance sur 2 equipes (l'hote ajuste ensuite).
      let i = 0;
      for (const p of this.players.values()) { p.teamId = (i % 2) + 1; i++; }
    } else {
      for (const p of this.players.values()) p.teamId = 0;
    }
    this.broadcastRoom();
  }

  private onSetTeam(ws: WebSocket, target: string, teamId: number): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (pseudo !== this.hostPseudo) return this.err(ws, "NOT_HOST", "Seul l'hote compose les equipes.");
    if (this.phase !== "lobby") return this.err(ws, "WRONG_PHASE", "Pas dans le salon.");
    if (!this.teamsOn) return;
    const t = Math.max(1, Math.min(MAX_TEAMS, Math.floor(teamId)));
    // Retrouve le joueur (comparaison insensible comme ailleurs).
    for (const [p, s] of this.players.entries()) {
      if (p === target || pseudosEqual(p, target)) { s.teamId = t; break; }
    }
    this.broadcastRoom();
  }

  private teamColor(teamId: number): number { return Math.max(0, teamId - 1); }

  // ========================= Lancement =========================
  private onStart(ws: WebSocket, mode: Mode, gridSize: number, level: string, duration: number): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (!pseudo || pseudo !== this.hostPseudo) return this.err(ws, "NOT_HOST", "Seul l'hote lance.");
    if (this.phase !== "lobby") return this.err(ws, "WRONG_PHASE", "Deja lancee.");
    if (this.connected().length < ROOM_CONFIG.MIN_PLAYERS)
      return this.err(ws, "NOT_ENOUGH_PLAYERS", "Il faut au moins 2 joueurs.");

    this.mode = mode === "chacun" ? "chacun" : "commune";
    this.gridSize = ALLOWED_SIZES.includes(gridSize) ? gridSize : 12;
    this.level = ALLOWED_LEVELS.includes(level) ? level : "moyen";
    this.durationSec = ALLOWED_DURATIONS.includes(duration) ? duration : 300;

    // Les equipes ne sont gerees qu'en grille commune pour l'instant.
    if (this.mode !== "commune") this.teamsOn = false;
    if (this.teamsOn && this.nonEmptyTeams().length < 2) {
      return this.err(ws, "NOT_ENOUGH_PLAYERS", "Il faut au moins 2 equipes non vides.");
    }

    const protectMystery = this.mode === "chacun";
    let gen = null;
    for (let attempt = 0; attempt < 6 && !gen; attempt++) {
      gen = generate({ size: this.gridSize, dirKeys: LEVELS[this.level], protectMystery });
    }
    if (!gen) return this.err(ws, "INVALID_MOVE", "Generation de grille impossible, reessaie.");

    this.grid = gen.grid;
    this.words = gen.findable.map((p: FindableWord) => ({
      word: p.word, cells: p.cells,
      key: cellKey(p.cells), rkey: cellKey([...p.cells].reverse()),
      found: false, byPseudo: null, color: 0,
    }));
    this.mysteryWord = gen.mystery.word;
    this.mysteryDef = gen.mystery.definition;
    this.mysteryCells = gen.mystery.cells;

    for (const p of this.players.values()) {
      p.score = 0; p.solvedMystery = false; p.lastFindAt = 0; p.foundKeys = new Set();
      // En equipes, la couleur represente l'equipe (coequipiers = meme couleur).
      if (this.teamsOn) p.color = this.teamColor(p.teamId);
    }

    this.phase = "playing";

    if (this.mode === "chacun") {
      this.endsAt = Date.now() + this.durationSec * 1000;
      void this.state.storage.setAlarm(this.endsAt);
      this.broadcastGamePerPlayer();
    } else {
      this.endsAt = null;
      this.broadcastGame();
    }
  }

  // ========================= Recherche =========================
  private onClaim(ws: WebSocket, cells: Cell[]): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (!pseudo) return;
    if (this.phase !== "playing") return this.err(ws, "WRONG_PHASE", "Pas en jeu.");
    if (!this.validStraight(cells)) return this.err(ws, "INVALID_MOVE", "Selection invalide.");
    const me = this.players.get(pseudo)!;
    const key = cellKey(cells);

    if (this.mode === "commune") {
      for (const w of this.words) {
        if (key === w.key || key === w.rkey) {
          if (w.found) return this.send(ws, { type: "hint", kind: "already", message: "Deja trouve par un autre." });
          w.found = true; w.byPseudo = pseudo; w.color = me.color;
          me.score++; me.lastFindAt = Date.now();
          const fw: FoundWord = { word: w.word, cells: w.cells, color: me.color, pseudo };
          const remaining = this.words.filter((x) => !x.found).length;
          this.broadcast({ type: "found", players: this.snapshot(), word: fw, remaining });
          if (remaining === 0) this.finish(this.leader());
          return;
        }
      }
    } else {
      // "chacun" : verrouillage propre au joueur, pas de blocage entre joueurs.
      for (const w of this.words) {
        if (key === w.key || key === w.rkey) {
          if (me.foundKeys.has(w.key)) return this.send(ws, { type: "hint", kind: "already", message: "Tu l'as deja." });
          me.foundKeys.add(w.key);
          me.score++; me.lastFindAt = Date.now();
          const fw: FoundWord = { word: w.word, cells: w.cells, color: me.color, pseudo };
          const remaining = this.words.length - me.foundKeys.size;
          this.send(ws, { type: "found", players: this.snapshot(), word: fw, remaining });
          this.broadcastScores();
          if (remaining === 0) this.send(ws, { type: "mystery_open", definition: this.mysteryDef, length: this.mysteryWord.length });
          return;
        }
      }
    }

    // Pas un mot attendu : segment d'un mot plus long non encore trouve -> on guide.
    for (const w of this.words) {
      const alreadyMine = this.mode === "chacun" ? me.foundKeys.has(w.key) : w.found;
      if (alreadyMine) continue;
      if (this.isSubRun(cells, w.cells) || this.isSubRun(cells, [...w.cells].reverse())) {
        return this.send(ws, { type: "hint", kind: "longer", message: "Ce mot fait partie d'un mot plus long." });
      }
    }
    this.send(ws, { type: "hint", kind: "nope", message: "Pas un mot cache ici." });
  }

  private onMysteryGuess(ws: WebSocket, guess: string): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (!pseudo) return;
    if (this.phase !== "playing" || this.mode !== "chacun") return this.err(ws, "WRONG_PHASE", "Indisponible ici.");
    const me = this.players.get(pseudo)!;
    if (me.foundKeys.size < this.words.length) return this.err(ws, "WRONG_PHASE", "Termine d'abord ta grille.");
    if (me.solvedMystery) return;
    const g = this.norm(String(guess || ""));
    if (!g) return;
    if (g === this.mysteryWord) {
      me.solvedMystery = true; me.score += MYSTERY_BONUS; me.lastFindAt = Date.now();
      this.broadcastScores();
    } else {
      this.send(ws, { type: "hint", kind: "nope", message: "Pas le bon mot mystere." });
    }
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
    this.endsAt = null;
    void this.state.storage.deleteAlarm();
    this.broadcastRoom();
  }

  private leader(): string {
    if (this.teamsOn) {
      const t = this.teamRanking();
      return t.length ? ("Équipe " + t[0].teamId) : "";
    }
    const r = this.rank();
    return r.length ? r[0].pseudo : "";
  }
  private rank(): MmPlayer[] {
    return this.snapshot().sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const la = this.players.get(a.pseudo)?.lastFindAt || Infinity;
      const lb = this.players.get(b.pseudo)?.lastFindAt || Infinity;
      return la - lb;
    });
  }
  // Classement par equipe : score cumule desc, puis equipe ayant atteint son
  // total le plus tot (dernier mot le plus ancien).
  private teamRanking(): Array<{ teamId: number; score: number; last: number }> {
    const agg: Record<number, { teamId: number; score: number; last: number }> = {};
    for (const p of this.players.values()) {
      if (p.teamId < 1) continue;
      const a = agg[p.teamId] || (agg[p.teamId] = { teamId: p.teamId, score: 0, last: 0 });
      a.score += p.score;
      a.last = Math.max(a.last, p.lastFindAt);
    }
    return Object.values(agg).sort((a, b) => (b.score - a.score) || (a.last - b.last));
  }

  private finish(winner: string): void {
    this.phase = "finished";
    this.endsAt = null;
    void this.state.storage.deleteAlarm();
    this.broadcast({
      type: "finished", players: this.snapshot(), ranking: this.rank(), winner,
      mode: this.mode, teamsOn: this.teamsOn, mysteryWord: this.mode === "chacun" ? this.mysteryWord : "",
    });
  }

  // ========================= Validation =========================
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

  private norm(s: string): string {
    return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z]/g, "");
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
    }
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
        score: p.score, solvedMystery: p.solvedMystery, isConnected: p.ws !== null,
        teamId: p.teamId,
      }));
  }

  // Mots trouves partages (commune).
  private foundShared(): FoundWord[] {
    return this.words.filter((w) => w.found).map((w) => ({
      word: w.word, cells: w.cells, color: w.color, pseudo: w.byPseudo || "",
    }));
  }
  // Mots trouves d'un joueur (chacun), a sa couleur.
  private foundForPlayer(p: Session): FoundWord[] {
    return this.words.filter((w) => p.foundKeys.has(w.key)).map((w) => ({
      word: w.word, cells: w.cells, color: p.color, pseudo: p.pseudo,
    }));
  }

  private gameDTO(forPseudo: string): GameStateDTO {
    const base = {
      mode: this.mode, teamsOn: this.teamsOn, gridSize: this.gridSize, grid: this.grid.map((row) => row.slice()),
      totalWords: this.words.length, level: this.level,
    };
    if (this.mode === "commune") {
      return { ...base, found: this.foundShared(), endsAt: null, mysteryOpen: false, mysteryDefinition: null };
    }
    const p = this.players.get(forPseudo);
    const done = p ? p.foundKeys.size >= this.words.length : false;
    return {
      ...base,
      found: p ? this.foundForPlayer(p) : [],
      endsAt: this.endsAt,
      mysteryOpen: done,
      mysteryDefinition: done ? this.mysteryDef : null,
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
      config: { mode: this.mode, teamsOn: this.teamsOn, gridSize: this.gridSize, level: this.level, duration: this.durationSec },
      game: this.phase === "lobby" ? null : this.gameDTO(pseudo),
    });
  }

  private broadcastRoom(): void {
    this.broadcast({ type: "room_state", players: this.snapshot(), hostPseudo: this.hostPseudo ?? "", phase: this.phase, teamsOn: this.teamsOn });
  }
  private broadcastGame(): void {
    // Mode commune : meme etat pour tous.
    const g = this.gameDTO("");
    for (const s of this.players.values()) {
      if (s.ws) this.send(s.ws, { type: "game_state", players: this.snapshot(), phase: this.phase, game: g });
    }
  }
  private broadcastGamePerPlayer(): void {
    for (const s of this.players.values()) {
      if (s.ws) this.send(s.ws, { type: "game_state", players: this.snapshot(), phase: this.phase, game: this.gameDTO(s.pseudo) });
    }
  }
  private broadcastScores(): void {
    this.broadcast({ type: "scores", players: this.snapshot() });
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

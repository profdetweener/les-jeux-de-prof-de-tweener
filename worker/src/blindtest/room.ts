/**
 * BlindtestRoom, Durable Object du Blind Test en navigateur (voir
 * messages.ts pour les regles et le protocole).
 *
 * Minuterie : une seule alarme, qui sert soit a la fin de l'ecoute, soit a
 * la fin de la revelation (passage a la manche suivante).
 *
 * Seuls `initialized` et `hostPseudo` sont persistes, comme les autres jeux.
 */

import { validatePseudo, pseudosEqual } from "../shared/moderation";
import { tracks, decadesOf, normalize, matchesAny, type Track, type Variant } from "./playlist";
import type {
  ClientMessage, ServerMessage, PlayerDTO, ScoreDTO, GameDTO, MeDTO, RevealDTO, HistoryDTO,
  Phase, Scoring, RoundStep, StartConfig, BtErrorCode,
} from "./messages";

interface Env {
  // Developpement local seulement : adresse d'un extrait a jouer a la place
  // de Deezer (injoignable depuis certaines machines de test).
  BT_FAKE_AUDIO?: string;
  // Developpement local seulement : envoie la reponse avec l'etat de jeu,
  // pour les tests automatiques. Jamais defini en production.
  BT_DEV_HINTS?: string;
}

interface Session {
  pseudo: string;
  ws: WebSocket | null;
  joinedAt: number;
  teamId: number;        // equipe (mode equipes), 1..teamCount
  tokens: number;        // anti-spam
  lastRefill: number;
  // Stats de fin
  titles: number;
  artists: number;
  points: number;
  best: number | null;   // reponse la plus rapide (s)
}

interface Find { t: number; pts: number; by: string; }
interface UnitFinds { title?: Find; artist?: Find; }

interface Round {
  n: number;
  track: Track | null;
  titles: Variant[];
  artists: Variant[];
  preview: string | null;
  cover: string | null;
  startAt: number;
  endsAt: number;
  step: RoundStep;
  revealUntil: number | null;
  pausedAt: number | null;         // heure de la mise en pause (null = en cours)
  finds: Map<string, UnitFinds>;   // par unite (joueur, ou equipe "t1")
  order: Array<{ by: string; unit: string; kind: "title" | "artist"; t: number; pts: number }>;
  gains: Map<string, number>;
}

const MAX_TEAMS = 8;
const PLAYERS_HARD_CAP = 200;
const COUNTDOWN_MS = 3000;      // annonce de la manche avant l'extrait
const REVEAL_MS = 8000;         // revelation avant la manche suivante
const LATE_MS = 400;            // reponse partie juste avant la fin : acceptee
const BURST = 8;                // anti-spam : 8 essais d'avance...
const REFILL_MS = 400;          // ...un jeton regagne toutes les 400 ms
const DEEZER_TRIES = 6;         // morceaux sans extrait a la suite avant d'abandonner
const TEAM_DEFAULT = (t: number) => `Équipe ${t}`;

function shuffle<T>(a: T[]): T[] {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = b[i]; b[i] = b[j]; b[j] = t;
  }
  return b;
}
function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}

export class BlindtestRoom {
  private state: DurableObjectState;
  private env: Env;
  private players: Map<string, Session>;
  private wsToPseudo: Map<WebSocket, string>;
  private hostPseudo: string | null;
  private lobbyTeamMemo: Map<string, number>;

  private phase: Phase;
  private solo: boolean;
  private teamCount: number;
  private teamNames: Record<number, string>;

  private cfg: StartConfig;
  private queue: Track[];
  private total: number;
  private round: Round | null;
  private seq: number;                // invalide les chargements Deezer d'une manche passee
  private scores: Map<string, number>;
  private history: HistoryDTO[];

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env || {};
    this.players = new Map();
    this.wsToPseudo = new Map();
    this.hostPseudo = null;
    this.lobbyTeamMemo = new Map();
    this.phase = "lobby";
    this.solo = true;
    this.teamCount = 2;
    this.teamNames = {};
    this.cfg = { rounds: 10, duration: 20, tolerance: 20, pop: 75, decades: [], scoring: "temps" };
    this.queue = [];
    this.total = 0;
    this.round = null;
    this.seq = 0;
    this.scores = new Map();
    this.history = [];

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

  // Alarme unique : fin de l'ecoute, ou fin de la revelation.
  async alarm(): Promise<void> {
    const r = this.round;
    if (this.phase !== "playing" || !r || r.pausedAt !== null) return;
    const now = Date.now();
    if (r.step === "listening") {
      if (now >= r.endsAt - 25) this.reveal();
      else this.schedule(r.endsAt);
    } else if (r.step === "reveal" && r.revealUntil !== null) {
      if (now >= r.revealUntil - 25) this.nextRound();
      else this.schedule(r.revealUntil);
    }
  }

  private schedule(at: number): void {
    void this.state.storage.setAlarm(at);
  }

  // ========================= Routage =========================
  private onMessage(ws: WebSocket, raw: string): void {
    let msg: ClientMessage;
    try { msg = JSON.parse(raw) as ClientMessage; }
    catch { return this.err(ws, "INVALID_MESSAGE", "Message non JSON."); }
    switch (msg.type) {
      case "join": return this.onJoin(ws, msg.pseudo);
      case "setSolo": return this.onSetSolo(ws, msg.solo);
      case "setTeamCount": return this.onSetTeamCount(ws, msg.n);
      case "setTeamName": return this.onSetTeamName(ws, msg.teamId, msg.name);
      case "setTeam": return this.onSetTeam(ws, msg.pseudo, msg.teamId);
      case "shuffleTeams": return this.onShuffleTeams(ws);
      case "start": return this.onStart(ws, msg.config);
      case "answer": return this.onAnswer(ws, msg.text);
      case "skip": return this.onSkip(ws);
      case "pause": return this.onPause(ws, msg.paused);
      case "endGame": return this.onEndGame(ws);
      case "backToLobby": return this.onBackToLobby(ws);
      default: this.err(ws, "INVALID_MESSAGE", "Type inconnu.");
    }
  }

  private isHostWs(ws: WebSocket): boolean {
    const p = this.wsToPseudo.get(ws);
    return !!p && p === this.hostPseudo;
  }

  private onJoin(ws: WebSocket, rawPseudo: string): void {
    const v = validatePseudo(rawPseudo);
    if (!v.ok) { this.err(ws, "PSEUDO_INVALID", v.error); ws.close(); return; }
    const pseudo = v.normalized;

    for (const [p, s] of this.players.entries()) {
      if (p !== pseudo && !pseudosEqual(p, pseudo)) continue;
      // Meme pseudo deja present (rafraichissement) : dernier connecte gagne.
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

    if (this.players.size >= PLAYERS_HARD_CAP) {
      this.err(ws, "ROOM_FULL", "La partie est complète."); ws.close(); return;
    }

    // Dans le salon, un nouveau joueur va dans l'equipe ou il etait
    // (rafraichissement), sinon dans la moins remplie. En cours de partie
    // aussi : il peut jouer tout de suite.
    const memo = this.lobbyTeamMemo.get(pseudo.toLowerCase()) || 0;
    const s: Session = {
      pseudo, ws, joinedAt: Date.now(),
      teamId: memo >= 1 && memo <= this.teamCount ? memo : this.smallestTeam(),
      tokens: BURST, lastRefill: Date.now(), titles: 0, artists: 0, points: 0, best: null,
    };
    this.players.set(pseudo, s);
    this.wsToPseudo.set(ws, pseudo);

    const first = this.players.size === 1;
    if ((this.hostPseudo === null && first) || (this.hostPseudo !== null && pseudosEqual(pseudo, this.hostPseudo))) {
      this.hostPseudo = pseudo;
      void this.persistHost();
    }

    this.sendSnapshot(ws, pseudo);
    this.broadcastRoom();
    if (this.phase === "playing") this.broadcastGame();
  }

  // ========================= Salon =========================
  private lobbyGuard(ws: WebSocket): boolean {
    if (!this.isHostWs(ws)) { this.err(ws, "NOT_HOST", "Seul l'hote regle la partie."); return false; }
    if (this.phase !== "lobby") { this.err(ws, "WRONG_PHASE", "Pas dans le salon."); return false; }
    return true;
  }
  private onSetSolo(ws: WebSocket, solo: boolean): void {
    if (!this.lobbyGuard(ws)) return;
    this.solo = solo !== false;
    this.broadcastRoom();
  }
  private onSetTeamCount(ws: WebSocket, n: number): void {
    if (!this.lobbyGuard(ws)) return;
    this.teamCount = clampInt(n, 2, MAX_TEAMS, 2);
    for (const s of this.players.values()) if (s.teamId > this.teamCount) s.teamId = 0;
    for (const s of this.players.values()) if (s.teamId === 0) s.teamId = this.smallestTeam();
    this.broadcastRoom();
  }
  private onSetTeamName(ws: WebSocket, teamId: number, name: string): void {
    if (!this.lobbyGuard(ws)) return;
    const t = clampInt(teamId, 1, MAX_TEAMS, 1);
    const clean = String(name || "").replace(/\s+/g, " ").trim().slice(0, 20);
    if (clean) this.teamNames[t] = clean; else delete this.teamNames[t];
    this.broadcastRoom();
  }
  private onSetTeam(ws: WebSocket, target: string, teamId: number): void {
    if (!this.lobbyGuard(ws)) return;
    const key = String(target || "").toLowerCase();
    const s = [...this.players.values()].find((p) => p.pseudo.toLowerCase() === key);
    if (s) s.teamId = clampInt(teamId, 1, this.teamCount, 1);
    this.broadcastRoom();
  }
  private onShuffleTeams(ws: WebSocket): void {
    if (!this.lobbyGuard(ws)) return;
    shuffle([...this.players.values()]).forEach((s, i) => { s.teamId = (i % this.teamCount) + 1; });
    this.broadcastRoom();
  }
  private teamCounts(): Record<number, number> {
    const c: Record<number, number> = {};
    for (const s of this.players.values()) if (s.teamId >= 1) c[s.teamId] = (c[s.teamId] || 0) + 1;
    return c;
  }
  private smallestTeam(): number {
    const c = this.teamCounts();
    let best = 1, n = Infinity;
    for (let t = 1; t <= this.teamCount; t++) if ((c[t] || 0) < n) { n = c[t] || 0; best = t; }
    return best;
  }
  private teamName(t: number): string { return this.teamNames[t] || TEAM_DEFAULT(t); }
  private teamNamesArr(): string[] {
    const out: string[] = [];
    for (let t = 1; t <= this.teamCount; t++) out.push(this.teamName(t));
    return out;
  }

  // ========================= Partie =========================
  private sanitize(c: Partial<StartConfig> | undefined): StartConfig {
    const pops = [0, 50, 75, 90];
    const pop = Math.floor(Number(c?.pop));
    return {
      rounds: clampInt(c?.rounds, 3, 50, 10),
      duration: clampInt(c?.duration, 10, 30, 20),
      tolerance: clampInt(c?.tolerance, 0, 40, 20),
      pop: pops.includes(pop) ? pop : 75,
      decades: Array.isArray(c?.decades) ? c!.decades.map((d) => Math.floor(Number(d))).filter((d) => Number.isFinite(d)) : [],
      scoring: c?.scoring === "rang" ? "rang" : "temps",
    };
  }

  private onStart(ws: WebSocket, config: StartConfig): void {
    if (!this.lobbyGuard(ws)) return;
    this.cfg = this.sanitize(config);
    const dec = new Set(this.cfg.decades);
    const list = tracks().filter((t) =>
      (t.pop === null || t.pop >= this.cfg.pop) &&
      (dec.size === 0 || (t.year !== null && dec.has(Math.floor(t.year / 10) * 10))));
    if (!list.length) return this.err(ws, "NO_TRACKS", "Aucun morceau pour ces réglages (époques, notoriété).");
    const online = [...this.players.values()].filter((s) => s.ws !== null);
    if (!this.solo) {
      const filled = new Set(online.map((s) => s.teamId).filter((t) => t >= 1));
      if (filled.size < 2) return this.err(ws, "NOT_ENOUGH_PLAYERS", "Il faut des joueurs dans au moins 2 équipes.");
    }
    this.queue = shuffle(list);
    this.total = Math.min(this.cfg.rounds, this.queue.length);
    this.scores = new Map();
    this.history = [];
    for (const s of this.players.values()) { s.titles = 0; s.artists = 0; s.points = 0; s.best = null; }
    this.phase = "playing";
    this.round = null;
    this.broadcastRoom();
    this.nextRound();
  }

  // Unite qui marque : le joueur, ou son equipe.
  private unitOf(s: Session): string { return this.solo ? s.pseudo : "t" + s.teamId; }

  private nextRound(): void {
    const n = (this.round ? this.round.n : 0) + 1;
    if (n > this.total) { this.finish(); return; }
    this.round = {
      n, track: null, titles: [], artists: [], preview: null, cover: null,
      startAt: 0, endsAt: 0, step: "loading", revealUntil: null, pausedAt: null,
      finds: new Map(), order: [], gains: new Map(),
    };
    const seq = ++this.seq;
    this.broadcastGame();
    void this.loadTrack(seq);
  }

  // Demande l'extrait a Deezer. Un morceau sans extrait est saute.
  private async loadTrack(seq: number): Promise<void> {
    for (let tries = 0; tries < DEEZER_TRIES; tries++) {
      const track = this.queue.shift();
      if (!track) break;
      const info = await this.fetchDeezer(track.id);
      if (seq !== this.seq || this.phase !== "playing" || !this.round) return;   // partie terminee ou manche passee
      if (!info) continue;
      const r = this.round;
      r.track = track;
      r.titles = track.titles;
      r.artists = track.artists.slice();
      // Tous les interpretes du morceau sont acceptes.
      const known = new Set(r.artists.map((a) => a.norm));
      for (const name of info.contributors) {
        const nrm = normalize(name);
        if (nrm && !known.has(nrm)) { r.artists.push({ orig: name, norm: nrm }); known.add(nrm); }
      }
      r.preview = info.preview;
      r.cover = info.cover;
      r.startAt = Date.now() + COUNTDOWN_MS;
      r.endsAt = r.startAt + this.cfg.duration * 1000;
      r.step = "listening";
      // Mis en pause pendant le chargement : le compte a rebours partira
      // de la reprise.
      if (r.pausedAt !== null) r.pausedAt = Date.now();
      else this.schedule(r.endsAt);
      this.broadcastGame();
      return;
    }
    if (seq !== this.seq || this.phase !== "playing") return;
    this.broadcastError("DEEZER", "Deezer ne fournit pas d'extrait en ce moment. Partie terminée.");
    this.finish();
  }

  private async fetchDeezer(id: string): Promise<{ preview: string; cover: string | null; contributors: string[] } | null> {
    if (this.env.BT_FAKE_AUDIO) return { preview: this.env.BT_FAKE_AUDIO, cover: null, contributors: [] };
    try {
      const res = await fetch(`https://api.deezer.com/track/${encodeURIComponent(id)}`);
      if (!res.ok) return null;
      const j = await res.json() as {
        preview?: string; album?: { cover_medium?: string }; contributors?: Array<{ name?: string }>;
      };
      if (!j || !j.preview) return null;
      return {
        preview: j.preview,
        cover: j.album?.cover_medium || null,
        contributors: (j.contributors || []).map((c) => c && c.name).filter((x): x is string => !!x),
      };
    } catch { return null; }
  }

  private points(kind: "title" | "artist", t: number, rank: number): number {
    if (this.cfg.scoring === "rang") {
      return kind === "title" ? Math.max(10 - 2 * (rank - 1), 2) : Math.max(5 - (rank - 1), 1);
    }
    // Au temps : de 100 (titre) / 50 (artiste) a la premiere seconde, jusqu'au
    // quart de ces valeurs a la fin de l'extrait.
    const max = kind === "title" ? 100 : 50;
    return Math.round(max * (1 - 0.75 * Math.min(1, t / this.cfg.duration)));
  }

  private onAnswer(ws: WebSocket, text: string): void {
    const r = this.round;
    if (this.phase !== "playing" || !r || r.step !== "listening" || r.pausedAt !== null) return;
    const now = Date.now();
    if (now < r.startAt || now > r.endsAt + LATE_MS) return;
    const p = this.wsToPseudo.get(ws);
    const s = p ? this.players.get(p) : undefined;
    if (!s) return;
    if (!this.solo && s.teamId < 1) return;
    const gained = (now - s.lastRefill) / REFILL_MS;
    if (gained > 0) { s.tokens = Math.min(BURST, s.tokens + gained); s.lastRefill = now; }
    if (s.tokens < 1) return;
    s.tokens -= 1;

    const msg = normalize(String(text || "").slice(0, 120));
    if (!msg) return;
    const unit = this.unitOf(s);
    const f = r.finds.get(unit) || {};
    const t = Math.round(Math.min(now - r.startAt, this.cfg.duration * 1000) / 100) / 10;
    const out: ServerMessage & { type: "answer_result" } = { type: "answer_result", ok: false };

    const tryKind = (kind: "title" | "artist", variants: Variant[]) => {
      if (!variants.length || f[kind] || !matchesAny(msg, variants, this.cfg.tolerance)) return;
      const rank = r.order.filter((o) => o.kind === kind).length + 1;
      const pts = this.points(kind, t, rank);
      f[kind] = { t, pts, by: s.pseudo };
      r.order.push({ by: s.pseudo, unit, kind, t, pts });
      r.gains.set(unit, (r.gains.get(unit) || 0) + pts);
      this.scores.set(unit, (this.scores.get(unit) || 0) + pts);
      if (kind === "title") s.titles++; else s.artists++;
      s.points += pts;
      s.best = s.best === null ? t : Math.min(s.best, t);
      out.ok = true;
      out[kind] = { text: variants[0].orig, t, pts };
    };
    tryKind("title", r.titles);
    tryKind("artist", r.artists);
    r.finds.set(unit, f);
    this.send(ws, out);
    if (!out.ok) return;

    // Tout le monde a tout trouve : on revele sans attendre la fin.
    if (this.everyoneDone()) this.reveal();
    else this.broadcastGame();
  }

  private everyoneDone(): boolean {
    const r = this.round;
    if (!r) return false;
    const units = new Set<string>();
    for (const s of this.players.values()) if (s.ws !== null && (this.solo || s.teamId >= 1)) units.add(this.unitOf(s));
    if (!units.size) return false;
    for (const u of units) {
      const f = r.finds.get(u) || {};
      if (r.titles.length && !f.title) return false;
      if (r.artists.length && !f.artist) return false;
    }
    return true;
  }

  private reveal(): void {
    const r = this.round;
    if (!r || r.step === "reveal") return;
    r.pausedAt = null;
    r.step = "reveal";
    r.revealUntil = Date.now() + REVEAL_MS;
    if (r.track) {
      this.history.unshift({
        n: r.n, title: r.titles[0]?.orig || "-", artist: r.track.artists[0]?.orig || "-",
        year: r.track.year, cover: r.cover,
      });
    }
    this.schedule(r.revealUntil);
    this.broadcastGame();
  }

  private onSkip(ws: WebSocket): void {
    if (!this.isHostWs(ws)) return this.err(ws, "NOT_HOST", "Seul l'hote peut passer un morceau.");
    const r = this.round;
    if (this.phase !== "playing" || !r) return;
    if (r.step === "reveal") { this.nextRound(); return; }
    if (r.step === "loading") return;
    this.reveal();
  }

  // Pause : l'extrait et les chronos s'arretent pour tout le monde. A la
  // reprise, toutes les echeances sont decalees de la duree de la pause,
  // donc le temps de reponse (et les points) ne compte pas la pause.
  private onPause(ws: WebSocket, paused: boolean): void {
    if (!this.isHostWs(ws)) return this.err(ws, "NOT_HOST", "Seul l'hote peut mettre en pause.");
    const r = this.round;
    if (this.phase !== "playing" || !r) return;
    const now = Date.now();
    if (paused) {
      if (r.pausedAt !== null) return;
      r.pausedAt = now;
      void this.state.storage.deleteAlarm();
    } else {
      if (r.pausedAt === null) return;
      const d = now - r.pausedAt;
      r.pausedAt = null;
      if (r.step !== "loading") {
        r.startAt += d;
        r.endsAt += d;
      }
      if (r.revealUntil !== null) r.revealUntil += d;
      if (r.step === "listening") this.schedule(r.endsAt);
      else if (r.step === "reveal" && r.revealUntil !== null) this.schedule(r.revealUntil);
    }
    this.broadcastGame();
  }

  private onEndGame(ws: WebSocket): void {
    if (!this.isHostWs(ws)) return this.err(ws, "NOT_HOST", "Seul l'hote peut terminer.");
    if (this.phase !== "playing") return this.err(ws, "WRONG_PHASE", "Pas en jeu.");
    this.finish();
  }

  private finish(): void {
    this.seq++;
    this.phase = "finished";
    void this.state.storage.deleteAlarm();
    const players = [...this.players.values()]
      .filter((s) => s.points > 0 || s.titles > 0 || s.artists > 0 || s.ws !== null)
      .map((s) => ({
        name: s.pseudo, teamId: this.solo ? 0 : s.teamId,
        titles: s.titles, artists: s.artists, points: s.points, best: s.best,
      }))
      .sort((a, b) => b.points - a.points);
    this.broadcast({
      type: "finished", solo: this.solo, scoring: this.cfg.scoring, scores: this.scoresDTO(true),
      players, history: this.history, hostPseudo: this.hostPseudo ?? "",
    });
    this.broadcastRoom();
  }

  private onBackToLobby(ws: WebSocket): void {
    if (!this.isHostWs(ws)) return this.err(ws, "NOT_HOST", "Seul l'hote peut relancer.");
    this.seq++;
    this.phase = "lobby";
    this.round = null;
    void this.state.storage.deleteAlarm();
    // Ceux qui sont partis pendant la partie quittent le salon.
    for (const [p, s] of this.players.entries()) {
      if (s.ws === null && p !== this.hostPseudo) this.players.delete(p);
    }
    this.broadcastRoom();
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
      this.lobbyTeamMemo.set(pseudo.toLowerCase(), s.teamId);
      this.players.delete(pseudo);
      if (pseudo === this.hostPseudo) {
        const next = [...this.players.values()].find((p) => p.ws !== null);
        this.hostPseudo = next ? next.pseudo : null;
        void this.persistHost();
      }
    }
    this.broadcastRoom();
    // Un absent ne doit pas empecher la revelation anticipee.
    if (this.phase === "playing" && this.round?.step === "listening" && this.round.pausedAt === null
      && this.everyoneDone()) this.reveal();
  }

  // ========================= DTO / envois =========================
  private playersDTO(): PlayerDTO[] {
    return [...this.players.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({
        pseudo: p.pseudo, isHost: p.pseudo === this.hostPseudo,
        isConnected: p.ws !== null, teamId: this.solo ? 0 : p.teamId,
      }));
  }

  private scoresDTO(final = false): ScoreDTO[] {
    const r = this.round;
    const line = (id: string, name: string, color: number, members: string[]): ScoreDTO => {
      const f = (!final && r && r.finds.get(id)) || {};
      return {
        id, name, color, members, score: this.scores.get(id) || 0,
        title: f.title ? f.title.t : null, artist: f.artist ? f.artist.t : null,
        gain: (!final && r && r.gains.get(id)) || 0,
      };
    };
    let rows: ScoreDTO[];
    if (this.solo) {
      rows = [...this.players.values()]
        .filter((s) => s.ws !== null || (this.scores.get(s.pseudo) || 0) > 0)
        .map((s) => line(s.pseudo, s.pseudo, -1, []));
    } else {
      const byTeam = new Map<number, string[]>();
      for (const s of [...this.players.values()].sort((a, b) => a.joinedAt - b.joinedAt)) {
        if (s.teamId < 1) continue;
        if (!byTeam.has(s.teamId)) byTeam.set(s.teamId, []);
        byTeam.get(s.teamId)!.push(s.pseudo);
      }
      rows = [...byTeam.entries()].sort((a, b) => a[0] - b[0])
        .map(([t, m]) => line("t" + t, this.teamName(t), t - 1, m));
    }
    return rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "fr"));
  }

  private meDTO(s: Session): MeDTO | null {
    const r = this.round;
    if (!r) return null;
    const f = r.finds.get(this.unitOf(s)) || {};
    return {
      title: f.title ? { text: r.titles[0]?.orig || "", t: f.title.t, pts: f.title.pts, by: f.title.by } : null,
      artist: f.artist ? { text: r.artists[0]?.orig || "", t: f.artist.t, pts: f.artist.pts, by: f.artist.by } : null,
    };
  }

  private gameDTO(s: Session | null): GameDTO {
    const r = this.round;
    let reveal: RevealDTO | null = null;
    if (r && r.step === "reveal" && r.track) {
      reveal = {
        title: r.titles[0]?.orig || "-", artist: r.track.artists[0]?.orig || r.artists[0]?.orig || "-",
        year: r.track.year, cover: r.cover,
        found: r.order.map((o) => ({ by: o.by, kind: o.kind, t: o.t, pts: o.pts })),
      };
    }
    return {
      solo: this.solo,
      scoring: this.cfg.scoring,
      round: r ? r.n : 0,
      total: this.total,
      step: r ? r.step : "loading",
      duration: this.cfg.duration,
      preview: r ? r.preview : null,
      startAt: r ? r.startAt : 0,
      endsAt: r ? r.endsAt : 0,
      revealUntil: r ? r.revealUntil : null,
      pausedAt: r ? r.pausedAt : null,
      serverNow: Date.now(),
      scores: this.scoresDTO(),
      reveal,
      history: this.history,
      me: s ? this.meDTO(s) : null,
      hostPseudo: this.hostPseudo ?? "",
      ...(this.env.BT_DEV_HINTS && r && r.track
        ? { devHint: { title: r.titles[0]?.orig || "", artist: r.artists[0]?.orig || "" } } : {}),
    };
  }

  private sendSnapshot(ws: WebSocket, pseudo: string): void {
    const s = this.players.get(pseudo) || null;
    this.send(ws, {
      type: "joined",
      pseudo,
      isHost: pseudo === this.hostPseudo,
      hostPseudo: this.hostPseudo ?? "",
      phase: this.phase,
      solo: this.solo,
      teamCount: this.teamCount,
      teamNames: this.teamNamesArr(),
      players: this.playersDTO(),
      decades: decadesOf(tracks()),
      game: this.phase === "playing" ? this.gameDTO(s) : null,
    });
  }

  private broadcastRoom(): void {
    this.broadcast({
      type: "room_state", players: this.playersDTO(), hostPseudo: this.hostPseudo ?? "",
      phase: this.phase, solo: this.solo, teamCount: this.teamCount, teamNames: this.teamNamesArr(),
    });
  }

  // L'etat de jeu est personnel (ce que j'ai trouve) : un envoi par joueur.
  private broadcastGame(): void {
    if (this.phase !== "playing") return;
    for (const s of this.players.values()) {
      if (s.ws) this.send(s.ws, { type: "game_state", game: this.gameDTO(s) });
    }
  }

  private broadcastError(code: BtErrorCode, message: string): void {
    this.broadcast({ type: "error", code, message });
  }

  private broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const s of this.players.values()) {
      if (!s.ws) continue;
      try { s.ws.send(data); }
      catch { this.wsToPseudo.delete(s.ws); s.ws = null; }
    }
  }
  private send(ws: WebSocket, data: ServerMessage): void {
    try { ws.send(JSON.stringify(data)); }
    catch {
      const p = this.wsToPseudo.get(ws);
      if (p) { const s = this.players.get(p); if (s) s.ws = null; this.wsToPseudo.delete(ws); }
    }
  }
  private err(ws: WebSocket, code: BtErrorCode, message: string): void {
    this.send(ws, { type: "error", code, message });
  }
}

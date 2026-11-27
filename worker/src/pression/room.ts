/**
 * PressionRoom, Durable Object de Pression (voir messages.ts pour les
 * regles et le protocole).
 *
 * Source "tchat" : les joueurs sont les viewers du tchat Twitch, sans
 * WebSocket. La page de l'hote lit le tchat et relaie (chatJoin / chatWord) ;
 * le serveur n'accepte ces relais que de l'hote. Les autres connectes
 * regardent.
 *
 * Source "navigateur" : les joueurs sont les connectes (lien d'invitation).
 * Chacun envoie ses mots lui-meme (word). L'hote compose les equipes ou
 * choisit "chacun pour soi".
 *
 * Minuterie : une seule alarme DO, qui sert soit a l'explosion de la caisse,
 * soit a la fin de la pause entre deux manches.
 *
 * Seuls `initialized`, `source` et `hostPseudo` sont persistes.
 */

import { validatePseudo, pseudosEqual } from "../shared/moderation";
import { norm, isWord, matchesRule, drawSyllable, startCount, CHAIN_MIN, warmUp } from "./dict";
import type {
  ClientMessage, ServerMessage, PlayerDTO, TeamDTO, GameDTO, GameEvent, PassInfo, ViewerStat,
  Phase, Mode, Source, Rule, Level, Timer, StartConfig, CtErrorCode, ChatDebugResult,
} from "./messages";

// Mots et lettres qui ont fait passer la caisse (stats de fin).
interface Stat { words: number; letters: number; }

interface Session extends Stat {
  pseudo: string;
  ws: WebSocket | null;
  joinedAt: number;
  // Navigateur uniquement.
  teamId: number;      // equipe dans le salon (1..teamCount)
  playTeam: number;    // equipe dans la partie en cours (0 = spectateur)
  tokens: number;      // seau a jetons anti-spam
  lastRefill: number;
}

// Un viewer du tchat. En "equipes", il n'existe qu'apres !join. En
// "streamer", il nait a son premier mot (pour le seau anti-spam et les stats).
interface Viewer {
  name: string;        // display-name Twitch
  joined: boolean;     // a fait !join (equipes)
  teamId: number;      // 0 = sans equipe
  tokens: number;      // seau a jetons anti-spam
  lastRefill: number;
  words: number;       // mots qui ont fait passer la caisse
  letters: number;
}

interface Team {
  id: number;
  name: string;
  lives: number;
  maxLives: number;
  charge: number;
  alive: boolean;
  out: number;         // ordre d'elimination (0 = en vie)
  clockMs: number;     // temps restant sur le minuteur de l'equipe
}

const MAX_TEAMS = 8;
const RULES: Rule[] = ["contient", "commence", "finit", "chaine"];
const LEVELS: Level[] = ["facile", "moyen", "difficile"];
// Anciennes plages du minuteur de depart (la page envoie maintenant un temps
// fixe, timer = "custom" avec timerMin = timerMax).
const TIMERS: Record<Exclude<Timer, "custom">, [number, number]> = {
  court: [15, 25],
  moyen: [25, 35],
  long: [35, 50],
};
// Minimum au tour suivant d'une equipe qui a valide (en s). Doit couvrir le
// retard du stream : le tchat voit la caisse arriver quelques secondes apres
// le serveur.
// L'hote peut aussi saisir ses propres valeurs, dans ces limites.
const TIMER_MIN = 5, TIMER_MAX = 120;
const FLOOR_MIN = 1, FLOOR_MAX = 60;
const CHARGE_MIN = 10, CHARGE_MAX = 500;
const LIVES_MIN = 1, LIVES_MAX = 6;
// La boite de chargement peut faire monter une equipe jusqu'a ses vies de
// depart + 2, pas au-dela (sinon une equipe en avance devient intouchable).
const LIVES_BONUS_CAP = 2;
const INTER_MS = 5000;   // pause entre deux manches
// Compte a rebours final (tic-tac + chiffres rouges) : les WARN_MS
// dernieres millisecondes du minuteur de l'equipe qui tient la caisse.
// Une equipe qui recoit la caisse au minimum (5 s) l'entend donc tout de suite.
const WARN_MS = 5000;
// Bonus de rapidite par paliers : [temps de reponse max, bonus], en ms. Le
// temps de reponse se compte a partir du demarrage du minuteur, donc APRES le
// temps de passage : le retard du stream est deja compense, les paliers
// mesurent bien la vitesse de reaction des viewers. Le bonus ne fait jamais
// depasser le temps de depart.
const QUICK_TIERS: Array<[number, number]> = [
  [3000, 3000],   // moins de 3 s : +3 s
  [5000, 2000],   // moins de 5 s : +2 s
  [8000, 1000],   // moins de 8 s : +1 s
];
// Temps de passage : quand la caisse change d'equipe, la syllabe s'affiche
// tout de suite mais le minuteur de l'equipe ne demarre qu'apres ce delai.
// Compense le retard du stream (2 a 5 s en faible latence). Les mots recus
// pendant ce temps comptent. Pas de temps de passage pour le streamer en
// mode streamer : il voit tout en direct.
const GRACE_MAX = 8;   // secondes, reglage de 0 a 8 (tchat uniquement)
const RECENT = 12;       // syllabes recentes evitees au tirage
// Garde-fou anti-bot par viewer (seau a jetons) : 10 essais d'avance, un jeton
// regagne toutes les 300 ms. Un humain qui enchaine les propositions apres un
// refus n'attend jamais ; seul un script qui inonde le tchat est freine.
// Seuls les essais faits quand c'est le tour de son equipe coutent, et la
// page de l'hote ne relaie deja que les mots conformes a la regle.
const CHAT_BURST = 10;
// Nombre de joueurs : pas de limite par defaut. En navigateur, l'hote peut en
// fixer une (2 a PLAYERS_SETTING_MAX). Garde-fou serveur dans tous les cas.
const PLAYERS_SETTING_MAX = 50;
const PLAYERS_HARD_CAP = 200;
const CHAT_REFILL_MS = 300;

function shuffleInPlace<T>(a: T[]): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
}
function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}

export class PressionRoom {
  private state: DurableObjectState;
  private players: Map<string, Session>;
  private wsToPseudo: Map<WebSocket, string>;
  private hostPseudo: string | null;
  // Fixee a la creation de la partie (corps de POST /pression/rooms).
  private source: Source;
  // Navigateur : chacun pour soi (une equipe par joueur).
  private solo: boolean;
  // Navigateur : nombre maximum de joueurs choisi par l'hote (0 = sans limite).
  private maxPlayers: number;
  // Navigateur : equipe de chaque pseudo dans le salon, pour la retrouver
  // apres un rafraichissement de page (la session est supprimee a la deconnexion).
  private lobbyTeamMemo: Map<string, number>;

  private phase: Phase;
  private mode: Mode;
  private teamCount: number;
  private teamNames: Record<number, string>;
  // Cle = display-name en minuscules.
  private viewers: Map<string, Viewer>;
  // Stats du streamer (mode streamer), hors table des viewers.
  private hostStat: { words: number; letters: number };

  // ----- Partie -----
  private cfg: StartConfig;
  private teams: Team[];
  private holder: number;
  private rule: Rule;
  private lastRule: Rule | null;
  private syllable: string;
  private recent: string[];
  private manche: number;
  private turnStartAt: number;
  private turnBudgetMs: number;
  private fullMs: number;
  private explodeAt: number;
  private warned: boolean;
  // Pause de l'hote : instant de la mise en pause (null = en jeu). Tout est
  // fige : alarme supprimee, mots ignores. A la reprise, toutes les echeances
  // sont decalees de la duree de la pause.
  private pausedAt: number | null;
  private interUntil: number | null;
  private nextHolder: number;
  private lastPass: PassInfo | null;
  private longest: PassInfo | null;
  private used: Set<string>;
  private outCounter: number;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.players = new Map();
    this.wsToPseudo = new Map();
    this.hostPseudo = null;
    this.source = "tchat";
    this.solo = false;
    this.maxPlayers = 0;
    this.lobbyTeamMemo = new Map();
    this.phase = "lobby";
    this.mode = "equipes";
    this.teamCount = 2;
    this.teamNames = {};
    this.viewers = new Map();
    this.hostStat = { words: 0, letters: 0 };

    this.cfg = {
      rules: ["contient"], level: "moyen", timer: "moyen", floorSec: 8, quickBonus: true, graceSec: 3,
      lives: 3, livesStreamer: 3, livesChat: 3, charge: 50,
    };
    this.teams = [];
    this.holder = 0;
    this.rule = "contient";
    this.lastRule = null;
    this.syllable = "";
    this.recent = [];
    this.manche = 0;
    this.turnStartAt = 0;
    this.turnBudgetMs = 0;
    this.fullMs = 0;
    this.explodeAt = 0;
    this.warned = false;
    this.pausedAt = null;
    this.interUntil = null;
    this.nextHolder = 0;
    this.lastPass = null;
    this.longest = null;
    this.used = new Set();
    this.outCounter = 0;

    this.state.blockConcurrencyWhile(async () => {
      try {
        const h = await this.state.storage.get<string>("hostPseudo");
        if (typeof h === "string" && h.length > 0) this.hostPseudo = h;
        const src = await this.state.storage.get<string>("source");
        if (src === "navigateur") this.source = "navigateur";
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
      // Corps facultatif : { source: "tchat" | "navigateur" } (tchat par defaut).
      let body: { source?: string } = {};
      try { body = await request.json(); } catch { /* pas de corps : tchat */ }
      this.source = body.source === "navigateur" ? "navigateur" : "tchat";
      await this.state.storage.put("source", this.source);
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

  // Alarme unique : explosion, ou fin de la pause entre deux manches.
  async alarm(): Promise<void> {
    if (this.phase !== "playing" || this.pausedAt !== null) return;
    const now = Date.now();
    if (this.interUntil !== null) {
      if (now >= this.interUntil - 25) this.startManche(this.nextHolder);
      else this.schedule(this.interUntil);
      return;
    }
    if (now >= this.explodeAt - 25) { this.explode(); return; }
    if (!this.warned && now >= this.explodeAt - WARN_MS - 25) {
      this.warned = true;
      this.broadcastGame({ kind: "whistle" });
    }
    this.scheduleFuse();
  }

  private schedule(at: number): void {
    void this.state.storage.setAlarm(at);
  }

  // Prochaine echeance : le compte a rebours final, puis l'explosion.
  private scheduleFuse(): void {
    this.schedule(this.warned ? this.explodeAt : this.explodeAt - WARN_MS);
  }

  // ========================= Routage =========================
  private onMessage(ws: WebSocket, raw: string): void {
    let msg: ClientMessage;
    try { msg = JSON.parse(raw) as ClientMessage; }
    catch { return this.err(ws, "INVALID_MESSAGE", "Message non JSON."); }
    switch (msg.type) {
      case "join": return this.onJoin(ws, msg.pseudo);
      case "setMode": return this.onSetMode(ws, msg.mode);
      case "setTeamCount": return this.onSetTeamCount(ws, msg.n);
      case "setTeamName": return this.onSetTeamName(ws, msg.teamId, msg.name);
      case "setTeam": return this.onSetTeam(ws, msg.pseudo, msg.teamId);
      case "shuffleTeams": return this.onShuffleTeams(ws);
      case "chatJoin": return this.onChatJoin(ws, msg.viewer, msg.team);
      case "chatWord": return this.onChatWord(ws, msg.viewer, msg.word);
      case "setSolo": return this.onSetSolo(ws, msg.solo);
      case "setMaxPlayers": return this.onSetMaxPlayers(ws, msg.max);
      case "word": return this.onWord(ws, msg.word);
      case "start": return this.onStart(ws, msg.mode, msg.config);
      case "endGame": return this.onEndGame(ws);
      case "pause": return this.onPause(ws, true);
      case "resume": return this.onPause(ws, false);
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

    // Pression ne reprend pas la limite commune aux autres jeux : sans limite
    // par defaut, ou celle de l'hote en navigateur.
    const limit = this.source === "navigateur" && this.maxPlayers > 0 ? this.maxPlayers : PLAYERS_HARD_CAP;
    if (this.players.size >= limit) {
      this.err(ws, "ROOM_FULL", limit === PLAYERS_HARD_CAP
        ? "La partie est complète."
        : `La partie est complète (${limit} joueurs maximum).`);
      ws.close(); return;
    }

    // Tchat : les connectes regardent, meme en cours de partie. L'hote, lui,
    // doit pouvoir revenir a tout moment.
    // Navigateur : dans le salon, un nouveau joueur va dans l'equipe ou il
    // etait (rafraichissement), sinon dans la moins remplie. En partie, il
    // rejoint l'equipe en vie la moins remplie, sauf en chacun pour soi ou il
    // regarde jusqu'a la partie suivante.
    const s: Session = {
      pseudo, ws, joinedAt: Date.now(), teamId: 0, playTeam: 0,
      tokens: CHAT_BURST, lastRefill: Date.now(), words: 0, letters: 0,
    };
    if (this.source === "navigateur") {
      const memo = this.lobbyTeamMemo.get(pseudo.toLowerCase()) || 0;
      s.teamId = memo >= 1 && memo <= this.teamCount ? memo : this.smallestLobbyTeam();
      if (this.phase === "playing" && !this.solo) s.playTeam = this.smallestAliveTeam();
    }
    this.players.set(pseudo, s);
    this.wsToPseudo.set(ws, pseudo);

    const first = this.players.size === 1;
    if ((this.hostPseudo === null && first) || (this.hostPseudo !== null && pseudosEqual(pseudo, this.hostPseudo))) {
      this.hostPseudo = pseudo;
      void this.persistHost();
    }

    this.sendSnapshot(ws, pseudo);
    this.broadcastRoom();
    if (s.playTeam) this.broadcastGame();
  }

  // ========================= Salon =========================
  private onSetMode(ws: WebSocket, mode: Mode): void {
    if (!this.isHostWs(ws)) return this.err(ws, "NOT_HOST", "Seul l'hote regle le mode.");
    if (this.phase !== "lobby") return this.err(ws, "WRONG_PHASE", "Pas dans le salon.");
    if (this.source === "navigateur") return;
    this.mode = mode === "streamer" ? "streamer" : "equipes";
    this.broadcastRoom();
  }

  // 0 = sans limite. Baisser la limite ne renvoie personne : elle ne joue
  // que pour les nouveaux arrivants.
  private onSetMaxPlayers(ws: WebSocket, max: number): void {
    if (!this.isHostWs(ws)) return this.err(ws, "NOT_HOST", "Seul l'hote regle le nombre de joueurs.");
    if (this.source !== "navigateur") return;
    const n = clampInt(max, 0, PLAYERS_SETTING_MAX, 0);
    this.maxPlayers = n === 0 ? 0 : Math.max(2, n);
    this.broadcastRoom();
  }

  private onSetSolo(ws: WebSocket, solo: boolean): void {
    if (!this.isHostWs(ws)) return this.err(ws, "NOT_HOST", "Seul l'hote regle les equipes.");
    if (this.phase !== "lobby") return this.err(ws, "WRONG_PHASE", "Pas dans le salon.");
    if (this.source !== "navigateur") return;
    this.solo = solo === true;
    this.broadcastRoom();
  }

  private onSetTeamCount(ws: WebSocket, n: number): void {
    if (!this.isHostWs(ws)) return this.err(ws, "NOT_HOST", "Seul l'hote regle les equipes.");
    if (this.phase !== "lobby") return this.err(ws, "WRONG_PHASE", "Pas dans le salon.");
    this.teamCount = clampInt(n, 2, MAX_TEAMS, 2);
    // Les membres d'une equipe supprimee sont replaces dans la moins peuplee.
    const list = this.lobbyMembers();
    for (const m of list) if (m.teamId > this.teamCount) m.teamId = 0;
    for (const m of list) if (m.teamId === 0) m.teamId = this.smallestLobbyTeam();
    this.broadcastRoom();
  }

  private onSetTeamName(ws: WebSocket, teamId: number, name: string): void {
    if (!this.isHostWs(ws)) return this.err(ws, "NOT_HOST", "Seul l'hote nomme les equipes.");
    if (this.phase !== "lobby") return this.err(ws, "WRONG_PHASE", "Pas dans le salon.");
    const t = Math.floor(teamId);
    if (t < 1 || t > MAX_TEAMS) return;
    const clean = String(name || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 18);
    if (clean) this.teamNames[t] = clean;
    else delete this.teamNames[t];
    this.broadcastRoom();
  }

  private onSetTeam(ws: WebSocket, target: string, teamId: number): void {
    if (!this.isHostWs(ws)) return this.err(ws, "NOT_HOST", "Seul l'hote compose les equipes.");
    if (this.phase !== "lobby") return this.err(ws, "WRONG_PHASE", "Pas dans le salon.");
    const key = String(target || "").toLowerCase();
    const m = this.lobbyMembers().find((x) => x.name.toLowerCase() === key);
    if (m) m.teamId = clampInt(teamId, 1, this.teamCount, 1);
    this.broadcastRoom();
  }

  // Tourniquet apres melange : les effectifs ne different jamais de plus d'un.
  private onShuffleTeams(ws: WebSocket): void {
    if (!this.isHostWs(ws)) return this.err(ws, "NOT_HOST", "Seul l'hote compose les equipes.");
    if (this.phase !== "lobby") return this.err(ws, "WRONG_PHASE", "Pas dans le salon.");
    const list = this.lobbyMembers();
    shuffleInPlace(list);
    list.forEach((m, i) => { m.teamId = (i % this.teamCount) + 1; });
    this.broadcastRoom();
  }

  // Membres d'equipe dans le salon : inscrits du tchat, ou connectes en
  // navigateur. On renvoie des proxys dont teamId ecrit dans l'objet d'origine.
  private lobbyMembers(): Array<{ name: string; teamId: number }> {
    if (this.source === "navigateur") {
      return [...this.players.values()].map((s) => ({
        name: s.pseudo,
        get teamId() { return s.teamId; },
        set teamId(t: number) { s.teamId = t; },
      }));
    }
    return [...this.viewers.values()].filter((v) => v.joined).map((v) => ({
      name: v.name,
      get teamId() { return v.teamId; },
      set teamId(t: number) { v.teamId = t; },
    }));
  }
  private lobbyCounts(): Record<number, number> {
    const c: Record<number, number> = {};
    for (const m of this.lobbyMembers()) if (m.teamId >= 1) c[m.teamId] = (c[m.teamId] || 0) + 1;
    return c;
  }
  // Effectif de chaque equipe de la partie en cours.
  private playCounts(): Record<number, number> {
    const c: Record<number, number> = {};
    if (this.source === "navigateur") {
      for (const s of this.players.values()) if (s.playTeam >= 1) c[s.playTeam] = (c[s.playTeam] || 0) + 1;
    } else {
      for (const v of this.viewers.values()) if (v.joined && v.teamId >= 1) c[v.teamId] = (c[v.teamId] || 0) + 1;
    }
    return c;
  }
  private smallestLobbyTeam(): number {
    const c = this.lobbyCounts();
    let best = 1, bestN = Infinity;
    for (let t = 1; t <= this.teamCount; t++) {
      const n = c[t] || 0;
      if (n < bestN) { bestN = n; best = t; }
    }
    return best;
  }
  // En partie : equipe en vie la moins peuplee, pour un retardataire.
  private smallestAliveTeam(): number {
    const c = this.playCounts();
    let best = 0, bestN = Infinity;
    for (const t of this.teams) {
      if (!t.alive) continue;
      const n = c[t.id] || 0;
      if (n < bestN) { bestN = n; best = t.id; }
    }
    return best;
  }

  private teamNameOf(t: number): string {
    const n = this.teamNames[t];
    return n && n.length ? n : "Équipe " + t;
  }
  private teamNamesArr(): string[] {
    const out: string[] = [];
    for (let t = 1; t <= this.teamCount; t++) out.push(this.teamNameOf(t));
    return out;
  }

  // "equipes" : inscription via !join. Acceptee dans le salon comme en cours
  // de partie (un retardataire rejoint une equipe encore en vie).
  private onChatJoin(ws: WebSocket, viewer: string, team: number): void {
    if (!this.isHostWs(ws)) return;
    if (this.source !== "tchat" || this.mode !== "equipes" || this.phase === "finished") return;
    const name = String(viewer || "").slice(0, 30).trim();
    if (!name) return;
    const key = name.toLowerCase();

    let v = this.viewers.get(key);
    if (!v) {
      v = { name, joined: false, teamId: 0, tokens: CHAT_BURST, lastRefill: Date.now(), words: 0, letters: 0 };
      this.viewers.set(key, v);
    }
    v.name = name;

    const t = Math.floor(team);
    if (this.phase === "lobby") {
      const wanted = t >= 1 && t <= this.teamCount ? t : 0;
      if (!v.joined) v.teamId = wanted || this.smallestLobbyTeam();
      else if (wanted) v.teamId = wanted;
      v.joined = true;
      this.broadcastRoom();
      return;
    }

    // En partie : on ne change pas d'equipe (sinon on fuit une equipe
    // condamnee). Un nouveau venu va ou il demande si l'equipe est en vie.
    if (v.joined) return;
    const target = this.teams.find((x) => x.id === t && x.alive);
    const id = target ? target.id : this.smallestAliveTeam();
    if (!id) return;
    v.teamId = id;
    v.joined = true;
    this.broadcastRoom();
    this.broadcastGame();
  }

  // ========================= Lancement =========================
  private sanitizeConfig(c: Partial<StartConfig> | undefined): StartConfig {
    const rules = Array.isArray(c?.rules) ? c!.rules.filter((r): r is Rule => RULES.includes(r as Rule)) : [];
    const level = LEVELS.includes(c?.level as Level) ? (c!.level as Level) : "moyen";
    let timer: Timer = c?.timer === "court" || c?.timer === "long" || c?.timer === "custom" ? c.timer : "moyen";
    let timerMin: number | undefined, timerMax: number | undefined;
    if (timer === "custom") {
      const a = clampInt(c?.timerMin, TIMER_MIN, TIMER_MAX, 0);
      const b = clampInt(c?.timerMax, TIMER_MIN, TIMER_MAX, 0);
      if (a && b) { timerMin = Math.min(a, b); timerMax = Math.max(a, b); }
      else timer = "moyen";
    }
    const streamerName = String(c?.streamerName || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 25);
    return {
      rules: rules.length ? [...new Set(rules)] : ["contient"],
      level, timer, timerMin, timerMax,
      floorSec: clampInt(c?.floorSec, FLOOR_MIN, FLOOR_MAX, 8),
      quickBonus: c?.quickBonus !== false,
      graceSec: clampInt(c?.graceSec, 0, GRACE_MAX, 3),
      streamerName,
      lives: clampInt(c?.lives, LIVES_MIN, LIVES_MAX, 3),
      livesStreamer: clampInt(c?.livesStreamer, LIVES_MIN, LIVES_MAX, 3),
      livesChat: clampInt(c?.livesChat, LIVES_MIN, LIVES_MAX, 3),
      charge: clampInt(c?.charge, CHARGE_MIN, CHARGE_MAX, 50),
    };
  }

  private onStart(ws: WebSocket, mode: Mode, config: StartConfig): void {
    if (!this.isHostWs(ws)) return this.err(ws, "NOT_HOST", "Seul l'hote lance.");
    if (this.phase !== "lobby") return this.err(ws, "WRONG_PHASE", "Deja lancee.");

    this.mode = mode === "streamer" && this.source === "tchat" ? "streamer" : "equipes";
    this.cfg = this.sanitizeConfig(config);
    // Pas de retard de stream en navigateur : pas de temps de passage.
    if (this.source === "navigateur") this.cfg.graceSec = 0;

    const mk = (id: number, name: string, lives: number): Team => ({
      id, name, lives, maxLives: lives + LIVES_BONUS_CAP, charge: 0, alive: true, out: 0, clockMs: 0,
    });

    if (this.source === "navigateur") {
      const list = [...this.players.values()].filter((s) => s.ws !== null).sort((a, b) => a.joinedAt - b.joinedAt);
      for (const s of this.players.values()) s.playTeam = 0;
      if (this.solo) {
        if (list.length < 2) return this.err(ws, "NOT_ENOUGH_PLAYERS", "Il faut au moins 2 joueurs.");
        this.teams = list.map((s, i) => { s.playTeam = i + 1; return mk(i + 1, s.pseudo, this.cfg.lives); });
      } else {
        const c: Record<number, number> = {};
        for (const s of list) if (s.teamId >= 1) c[s.teamId] = (c[s.teamId] || 0) + 1;
        const teams: Team[] = [];
        for (let t = 1; t <= this.teamCount; t++) {
          if ((c[t] || 0) > 0) teams.push(mk(t, this.teamNameOf(t), this.cfg.lives));
        }
        if (teams.length < 2) {
          return this.err(ws, "NOT_ENOUGH_PLAYERS", "Il faut des joueurs dans au moins 2 equipes.");
        }
        for (const s of list) s.playTeam = s.teamId;
        this.teams = teams;
      }
      for (const s of this.players.values()) {
        s.words = 0; s.letters = 0; s.tokens = CHAT_BURST; s.lastRefill = Date.now();
      }
    } else if (this.mode === "equipes") {
      const c = this.lobbyCounts();
      const teams: Team[] = [];
      for (let t = 1; t <= this.teamCount; t++) {
        if ((c[t] || 0) > 0) teams.push(mk(t, this.teamNameOf(t), this.cfg.lives));
      }
      if (teams.length < 2) {
        return this.err(ws, "NOT_ENOUGH_PLAYERS", "Il faut des inscrits (!join) dans au moins 2 equipes.");
      }
      this.teams = teams;
    } else {
      this.teams = [
        mk(1, this.cfg.streamerName || this.hostPseudo || "Streamer", this.cfg.livesStreamer),
        mk(2, "Tchat", this.cfg.livesChat),
      ];
      // En streamer, tout le tchat joue : on repart d'une table vide.
      this.viewers = new Map();
    }

    warmUp();
    for (const v of this.viewers.values()) {
      v.words = 0; v.letters = 0; v.tokens = CHAT_BURST; v.lastRefill = Date.now();
    }
    this.hostStat = { words: 0, letters: 0 };
    this.used = new Set();
    this.recent = [];
    this.manche = 0;
    this.lastRule = null;
    this.lastPass = null;
    this.longest = null;
    this.outCounter = 0;
    this.pausedAt = null;
    this.phase = "playing";

    const first = this.teams[Math.floor(Math.random() * this.teams.length)].id;
    this.broadcastRoom();
    this.startManche(first);
  }

  private pickRule(): Rule {
    const r = this.cfg.rules;
    if (r.length === 1) return r[0];
    const choices = r.filter((x) => x !== this.lastRule);
    return choices[Math.floor(Math.random() * choices.length)];
  }

  private pushRecent(s: string): void {
    this.recent.push(s);
    if (this.recent.length > RECENT) this.recent.shift();
  }

  private startManche(holder: number): void {
    const now = Date.now();
    this.manche++;
    // Chaque manche repart a zero : toutes les equipes recoivent le temps de
    // depart (tire dans la plage s'il y en a une ; fixe depuis la page).
    const [lo, hi] = this.cfg.timer === "custom"
      ? [this.cfg.timerMin ?? 25, this.cfg.timerMax ?? 35]
      : TIMERS[this.cfg.timer];
    this.fullMs = (lo + Math.floor(Math.random() * (hi - lo + 1))) * 1000;
    for (const t of this.teams) t.clockMs = this.fullMs;
    this.rule = this.pickRule();
    this.lastRule = this.rule;
    this.syllable = drawSyllable(this.rule, this.cfg.level, this.recent);
    this.pushRecent(this.syllable);
    this.holder = this.teams.some((t) => t.id === holder && t.alive) ? holder : this.nextAlive(holder);
    this.interUntil = null;
    this.lastPass = null;
    this.startTurn(now);
    this.broadcastGame({ kind: "manche" });
  }

  // Le minuteur de l'equipe qui tient la caisse se met a tourner.
  private startTurn(now: number): void {
    const team = this.teams.find((t) => t.id === this.holder);
    const live = this.source === "navigateur" || (this.mode === "streamer" && this.holder === 1);
    this.turnStartAt = now + (live ? 0 : this.cfg.graceSec * 1000);
    this.turnBudgetMs = team ? team.clockMs : this.fullMs;
    // Navigateur : si plus personne de l'equipe n'est connecte (page fermee),
    // on ne fait pas attendre les autres tout un minuteur : 5 s seulement.
    if (this.source === "navigateur" && !this.teamOnline(this.holder)) {
      this.turnBudgetMs = Math.min(this.turnBudgetMs, WARN_MS);
    }
    this.explodeAt = this.turnStartAt + this.turnBudgetMs;
    this.warned = this.turnBudgetMs <= WARN_MS;
    this.scheduleFuse();
  }

  private teamOnline(teamId: number): boolean {
    for (const s of this.players.values()) if (s.playTeam === teamId && s.ws !== null) return true;
    return false;
  }

  // Equipe en vie suivante, dans l'ordre des equipes, en bouclant.
  private nextAlive(from: number): number {
    const n = this.teams.length;
    const i = this.teams.findIndex((t) => t.id === from);
    for (let k = 1; k <= n; k++) {
      const t = this.teams[((i < 0 ? -1 : i) + k + n) % n];
      if (t.alive) return t.id;
    }
    return from;
  }

  // ========================= Mots =========================
  private onChatWord(ws: WebSocket, viewer: string, word: string): void {
    // Seul l'hote relaie : sa page est branchee sur l'IRC.
    if (!this.isHostWs(ws) || this.source !== "tchat") return;
    const name = String(viewer || "").slice(0, 30).trim();
    // Journal de diagnostic : l'hote recoit le sort de chaque mot relaye
    // (affiche seulement avec ?debug=1 sur sa page).
    const dbg = (result: ChatDebugResult, teamId = 0) => this.send(ws, {
      type: "chat_debug", by: name, word: String(word || "").slice(0, 40), result,
      teamId, holder: this.holder, rule: this.rule, syllable: this.syllable,
    });
    if (this.phase !== "playing" || this.interUntil !== null || this.pausedAt !== null) return dbg("pause");
    if (!name) return;
    const key = name.toLowerCase();

    // En streamer contre tchat, le streamer joue depuis le tchat comme les
    // viewers. Ses messages comptent pour son camp, et seulement a son tour.
    if (this.mode === "streamer" && this.cfg.streamerName && key === this.cfg.streamerName.toLowerCase()) {
      if (this.holder !== 1) return dbg("not_turn", 1);
      return dbg(this.tryWord(1, name, word, null), 1);
    }

    let v = this.viewers.get(key);
    let teamId: number;
    if (this.mode === "streamer") {
      if (!v) {
        v = { name, joined: true, teamId: 2, tokens: CHAT_BURST, lastRefill: Date.now(), words: 0, letters: 0 };
        this.viewers.set(key, v);
      }
      teamId = 2;
    } else {
      // En equipes, seuls les inscrits jouent : sinon on ne saurait pas pour
      // quelle equipe ils repondent. Un non-inscrit qui propose un mot
      // conforme a la regle est prevenu a l'ecran (sinon il ne comprend pas
      // pourquoi son mot ne compte pas).
      if (!v || !v.joined) {
        if (matchesRule(norm(word), this.rule, this.syllable)) {
          this.broadcast({ type: "reject", by: name, word: norm(word), teamId: 0, reason: "not_joined" });
        }
        return dbg("not_joined");
      }
      teamId = v.teamId;
    }
    v.name = name;

    // Hors de son tour, un message ne coute rien : il n'a aucun effet.
    if (teamId !== this.holder) return dbg("not_turn", teamId);

    const now = Date.now();
    const gained = (now - v.lastRefill) / CHAT_REFILL_MS;
    if (gained > 0) { v.tokens = Math.min(CHAT_BURST, v.tokens + gained); v.lastRefill = now; }
    if (v.tokens < 1) return dbg("spam", teamId);
    v.tokens -= 1;

    dbg(this.tryWord(teamId, v.name, word, v), teamId);
  }

  // Navigateur : mot tape sur la page par un joueur de l'equipe qui tient la
  // caisse. Les autres essais sont ignores (la case n'est active qu'a son tour).
  private onWord(ws: WebSocket, word: string): void {
    if (this.source !== "navigateur") return;
    if (this.phase !== "playing" || this.interUntil !== null || this.pausedAt !== null) return;
    const p = this.wsToPseudo.get(ws);
    const s = p ? this.players.get(p) : undefined;
    if (!s || !s.playTeam || s.playTeam !== this.holder) return;
    const now = Date.now();
    const gained = (now - s.lastRefill) / CHAT_REFILL_MS;
    if (gained > 0) { s.tokens = Math.min(CHAT_BURST, s.tokens + gained); s.lastRefill = now; }
    if (s.tokens < 1) return;
    s.tokens -= 1;
    this.tryWord(s.playTeam, s.pseudo, String(word || "").slice(0, 40), s);
  }

  private tryWord(teamId: number, by: string, raw: string, stat: Stat | null): ChatDebugResult {
    const now = Date.now();
    // Trop tard : l'alarme d'explosion n'a pas encore tourne, mais c'est fini.
    if (now >= this.explodeAt) return "late";
    const w = norm(raw);
    // Ce qui ne respecte pas la regle est du bruit de tchat : ignore en silence.
    // En navigateur, le mot a ete tape expres : on le signale.
    if (!matchesRule(w, this.rule, this.syllable)) {
      if (this.source === "navigateur" && w) this.broadcast({ type: "reject", by, word: w, teamId, reason: "rule" });
      return "rule";
    }
    if (this.used.has(w)) {
      this.broadcast({ type: "reject", by, word: w, teamId, reason: "used" });
      return "used";
    }
    if (!isWord(w)) {
      this.broadcast({ type: "reject", by, word: w, teamId, reason: "unknown" });
      return "unknown";
    }

    // ----- Mot valide -----
    this.used.add(w);
    if (stat) { stat.words++; stat.letters += w.length; }
    else { this.hostStat.words++; this.hostStat.letters += w.length; }
    const pass: PassInfo = { word: w, by, teamId };
    if (!this.longest || w.length > this.longest.word.length) this.longest = pass;
    this.lastPass = pass;

    // Boite de chargement : une lettre = un point. Pleine : +1 vie (sous le
    // plafond) et retour a zero.
    const team = this.teams.find((t) => t.id === teamId)!;
    let bonus = false;
    team.charge += w.length;
    if (team.charge >= this.cfg.charge) {
      team.charge = 0;
      if (team.lives < team.maxLives) { team.lives++; bonus = true; }
    }

    // Syllabe suivante.
    let chainBroken = false;
    if (this.rule === "chaine") {
      // Les 3 dernieres lettres (EROTIQUE -> QUE), sinon les 2 dernieres, si
      // assez de mots commencent ainsi. Sinon la chaine casse.
      const next = [3, 2].map((L) => w.slice(-L)).find((s) => startCount(s) >= CHAIN_MIN);
      if (next) this.syllable = next;
      else { this.syllable = drawSyllable("chaine", this.cfg.level, this.recent); chainBroken = true; }
    } else {
      this.syllable = drawSyllable(this.rule, this.cfg.level, this.recent);
    }
    this.pushRecent(this.syllable);

    // L'equipe garde le temps qui lui reste pour son prochain tour, sans
    // descendre sous le minimum. Puis le minuteur de la suivante demarre.
    // Mot trouve vite : bonus de temps.
    // Pendant le temps de passage, le minuteur n'a pas encore tourne : il
    // reste tout le budget, pas plus.
    const elapsed = now - this.turnStartAt;   // negatif pendant le temps de passage
    const tier = this.cfg.quickBonus ? QUICK_TIERS.find(([max]) => elapsed < max) : undefined;
    const quick = !!tier;
    const remaining = Math.min(this.turnBudgetMs, this.explodeAt - now);
    const left = remaining + (tier ? tier[1] : 0);
    team.clockMs = Math.min(this.fullMs, Math.max(left, this.cfg.floorSec * 1000));
    // Bonus reellement gagne (0 si le minuteur etait deja presque plein).
    // Arrondi par defaut (a 0,1 s pres) : un bonus rogne par le plafond a
    // 0,5 s ne s'affiche pas "+1 s".
    // Seul le bonus compte ici, pas le relevement au minimum.
    const timeBonusSec = quick ? Math.max(0, Math.floor((Math.min(this.fullMs, left) - remaining + 100) / 1000)) : 0;
    this.holder = this.nextAlive(teamId);
    this.startTurn(now);
    this.broadcastGame({ kind: "pass", word: w, by, teamId, bonus, chainBroken, timeBonusSec });
    return "ok";
  }

  // ========================= Explosion / fin =========================
  private explode(): void {
    const team = this.teams.find((t) => t.id === this.holder);
    if (!team) return;
    team.lives = Math.max(0, team.lives - 1);
    const eliminated = team.lives === 0;
    if (eliminated) { team.alive = false; team.out = ++this.outCounter; }

    const alive = this.teams.filter((t) => t.alive);
    if (alive.length <= 1) {
      this.finishGame(alive[0] || team);
      return;
    }
    // L'equipe qui a saute relance la manche suivante, si elle est encore en vie.
    this.nextHolder = team.alive ? team.id : this.nextAlive(team.id);
    this.interUntil = Date.now() + INTER_MS;
    this.schedule(this.interUntil);
    this.broadcastGame({ kind: "explode", teamId: team.id, eliminated });
  }

  private ranking(): Team[] {
    return this.teams.slice().sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      if (!a.alive && a.out !== b.out) return b.out - a.out;   // sorti plus tard = mieux classe
      if (b.lives !== a.lives) return b.lives - a.lives;
      return b.charge - a.charge;
    });
  }

  private finishGame(winner: Team | null): void {
    this.phase = "finished";
    this.interUntil = null;
    void this.state.storage.deleteAlarm();
    const ranked = this.ranking();
    const w = winner || ranked[0] || null;

    const stats: ViewerStat[] = this.source === "navigateur"
      ? [...this.players.values()].filter((s) => s.words > 0)
        .map((s) => ({ name: s.pseudo, teamId: s.playTeam, words: s.words, letters: s.letters }))
      : [...this.viewers.values()].filter((v) => v.words > 0)
        .map((v) => ({ name: v.name, teamId: v.teamId, words: v.words, letters: v.letters }));
    if (this.mode === "streamer" && this.hostStat.words > 0) {
      stats.push({ name: this.cfg.streamerName || this.hostPseudo || "Streamer", teamId: 1, words: this.hostStat.words, letters: this.hostStat.letters });
    }
    stats.sort((a, b) => (b.words - a.words) || (b.letters - a.letters));

    this.broadcast({
      type: "finished",
      mode: this.mode,
      source: this.source,
      solo: this.solo,
      winnerTeamId: w ? w.id : 0,
      winnerName: w ? w.name : "",
      teams: ranked.map((t) => this.teamDTO(t)),
      top: stats.slice(0, 5),
      longest: this.longest,
      totalWords: this.used.size,
      hostPseudo: this.hostPseudo ?? "",
    });
  }

  // Pause / reprise (hote). Pendant la pause, le minuteur de l'equipe et la
  // pause entre manches sont figes ; a la reprise, on repart d'ou on etait.
  private onPause(ws: WebSocket, pause: boolean): void {
    if (!this.isHostWs(ws)) return this.err(ws, "NOT_HOST", "Seul l'hote peut mettre en pause.");
    if (this.phase !== "playing") return this.err(ws, "WRONG_PHASE", "Pas en jeu.");
    const now = Date.now();
    if (pause) {
      if (this.pausedAt !== null) return;
      this.pausedAt = now;
      void this.state.storage.deleteAlarm();
    } else {
      if (this.pausedAt === null) return;
      const d = now - this.pausedAt;
      this.pausedAt = null;
      if (this.interUntil !== null) {
        this.interUntil += d;
        this.schedule(this.interUntil);
      } else {
        this.turnStartAt += d;
        this.explodeAt += d;
        this.scheduleFuse();
      }
    }
    this.broadcastGame();
  }

  private onEndGame(ws: WebSocket): void {
    if (!this.isHostWs(ws)) return this.err(ws, "NOT_HOST", "Seul l'hote peut terminer.");
    if (this.phase !== "playing") return this.err(ws, "WRONG_PHASE", "Pas en jeu.");
    this.finishGame(null);
  }

  private onBackToLobby(ws: WebSocket): void {
    if (!this.isHostWs(ws)) return this.err(ws, "NOT_HOST", "Seul l'hote peut relancer.");
    this.phase = "lobby";
    this.interUntil = null;
    this.pausedAt = null;
    this.teams = [];
    void this.state.storage.deleteAlarm();
    // En streamer, la table des viewers ne sert qu'a la partie.
    if (this.mode === "streamer") this.viewers = new Map();
    // Navigateur : ceux qui sont partis pendant la partie quittent le salon.
    for (const [p, s] of this.players.entries()) {
      if (s.ws === null && p !== this.hostPseudo) this.players.delete(p);
      s.playTeam = 0;
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
      if (this.source === "navigateur") this.lobbyTeamMemo.set(pseudo.toLowerCase(), s.teamId);
      this.players.delete(pseudo);
      if (pseudo === this.hostPseudo) {
        const next = [...this.players.values()].find((p) => p.ws !== null);
        this.hostPseudo = next ? next.pseudo : null;
        void this.persistHost();
      }
    }
    this.broadcastRoom();
  }

  // ========================= DTO / envois =========================
  private playersDTO(): PlayerDTO[] {
    const out: PlayerDTO[] = [...this.players.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({
        pseudo: p.pseudo, isHost: p.pseudo === this.hostPseudo,
        isConnected: p.ws !== null, isViewer: false,
        teamId: this.source !== "navigateur" ? 0 : this.phase === "lobby" ? p.teamId : p.playTeam,
      }));
    if (this.source === "tchat" && this.mode === "equipes") {
      for (const v of this.viewers.values()) {
        if (!v.joined) continue;
        out.push({ pseudo: v.name, isHost: false, isConnected: true, isViewer: true, teamId: v.teamId });
      }
    }
    return out;
  }

  private teamDTO(t: Team): TeamDTO {
    let members = 0;
    if (this.mode === "equipes") {
      members = this.playCounts()[t.id] || 0;
    } else {
      members = t.id === 1 ? 1 : this.viewers.size;
    }
    return {
      id: t.id, name: t.name, color: t.id - 1, lives: t.lives, maxLives: t.maxLives,
      charge: t.charge, alive: t.alive, members,
    };
  }

  private gameDTO(): GameDTO {
    return {
      mode: this.mode,
      source: this.source,
      solo: this.solo,
      level: this.cfg.level,
      teams: this.teams.map((t) => this.teamDTO(t)),
      chargeMax: this.cfg.charge,
      holder: this.holder,
      rule: this.rule,
      syllable: this.syllable,
      manche: this.manche,
      turnStartAt: this.turnStartAt,
      turnBudgetMs: this.turnBudgetMs,
      fullMs: this.fullMs,
      serverNow: Date.now(),
      interUntil: this.interUntil,
      lastPass: this.lastPass,
      usedCount: this.used.size,
      whistling: this.warned && this.interUntil === null && this.pausedAt === null,
      pausedAt: this.pausedAt,
      hostPseudo: this.hostPseudo ?? "",
    };
  }

  private sendSnapshot(ws: WebSocket, pseudo: string): void {
    this.send(ws, {
      type: "joined",
      pseudo,
      isHost: pseudo === this.hostPseudo,
      hostPseudo: this.hostPseudo ?? "",
      phase: this.phase,
      mode: this.mode,
      source: this.source,
      solo: this.solo,
      maxPlayers: this.maxPlayers,
      teamCount: this.teamCount,
      teamNames: this.teamNamesArr(),
      players: this.playersDTO(),
      game: this.phase === "playing" ? this.gameDTO() : null,
    });
  }

  private broadcastRoom(): void {
    this.broadcast({
      type: "room_state", players: this.playersDTO(), hostPseudo: this.hostPseudo ?? "",
      phase: this.phase, mode: this.mode, source: this.source, solo: this.solo,
      maxPlayers: this.maxPlayers, teamCount: this.teamCount, teamNames: this.teamNamesArr(),
    });
  }

  private broadcastGame(event?: GameEvent): void {
    if (this.phase !== "playing") return;
    this.broadcast({ type: "game_state", game: this.gameDTO(), event });
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
  private err(ws: WebSocket, code: CtErrorCode, message: string): void {
    this.send(ws, { type: "error", code, message });
  }
}

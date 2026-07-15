/**
 * MotsMelesRoom, Durable Object des modes competitifs de Mots meles.
 * Deux modes choisis par l'hote dans le salon :
 *
 *  - "commune" : grille commune interactive, verrouillage aux couleurs, score au
 *                nombre de mots, fin quand la grille est videe. Pas de mystere.
 *  - "chacun"  : chacun sa grille (identique), en parallele, minuteur cote
 *                serveur (alarme DO). Score au nombre de mots + bonus mystere.
 *                Le mystere est ouvert a tous des le lancement, avec un nombre
 *                d'essais limite : plus on a trouve de mots, plus les cases
 *                restantes de sa grille sont lisibles, donc le mystere se
 *                merite sans jamais etre hors d'atteinte. Classement a la fin
 *                du minuteur, departage au chrono (lastFindAt).
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

// Etat du mot mystere. Objet a part (et non des champs de Session) pour pouvoir
// etre PARTAGE par reference entre coequipiers en "chacun sa grille" : une
// equipe = un mystere, 3 essais, un bonus.
interface MysteryState {
  solved: boolean;
  tries: number;
}

// Un spectateur qui joue via le tchat Twitch. Ce n'est pas une Session : pas de
// WebSocket, pas de reconnexion, pas d'exclusion, et le pseudo vient de Twitch
// (validatePseudo n'a pas a s'appliquer). L'entree nait au premier message (pour
// le garde-fou anti-spam) mais la couleur n'est attribuee qu'au premier point,
// et seuls ceux qui ont marque apparaissent au tableau.
interface Viewer {
  name: string;       // display-name Twitch, tel qu'affiche
  color: number;      // -1 tant qu'aucun point
  score: number;
  lastFindAt: number;
  tokens: number;     // seau a jetons anti-spam
  lastRefill: number;
}

interface Session {
  pseudo: string;
  ws: WebSocket | null;
  color: number;
  score: number;
  // Partage par reference avec les coequipiers en "chacun" + equipes.
  myst: MysteryState;
  lastFindAt: number;
  joinedAt: number;
  // "chacun" : mots trouves sur MA grille, ou sur celle de mon equipe (Set
  // partage par reference entre coequipiers).
  foundKeys: Set<string>;
  teamId: number;         // 0 = sans equipe ; 1..8 = equipe
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
// Capacite propre a Mots meles, dependante du mode d'equipe. Sans equipes,
// 20 joueurs saturent le bandeau de score et la grille commune part en
// quelques secondes : on reste a 12. Avec equipes, 20 tient (5 equipes de 4).
// On ne touche pas a ROOM_CONFIG.MAX_PLAYERS, partage avec les autres jeux.
const MM_MAX_INDIV = 12;
const MM_MAX_TEAMS = 20;
const MYSTERY_BONUS = 3;
// "chat" : seau a jetons par viewer. Chaque essai coute un jeton, on en regagne
// un par seconde, et on peut en avoir 5 d'avance.
//
// Un simple delai fixe ne marchait pas : un tchat crache des emotes en continu
// ("LUL", "KEKW"), que le relais ne peut pas distinguer d'un mot sans embarquer
// le dictionnaire. Avec un delai, l'emote armait le compteur et le viewer perdait
// le vrai mot qu'il ecrivait juste apres. Le burst absorbe ca.
// Exempter les reussites du quota ne marchait pas non plus : un viewer scripte
// aurait deroule le dictionnaire et vide la grille, ses trouvailles n'etant
// jamais freinees. D'ou : tout essai coute, mais on a de l'avance.
// A 5 minutes de partie, cela plafonne un bot a ~305 essais.
const CHAT_BURST = 5;
const CHAT_REFILL_MS = 1000;
// Essais de mot mystere par joueur. Le mystere etant ouvert des le lancement, la
// limite est ce qui empeche de mitrailler des mots plausibles jusqu'a tomber
// juste : tenter tot devient un pari. Passera par equipe en "chacun" + equipes.
const MYSTERY_TRIES = 3;
const MAX_TEAMS = 8;

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
  // "chat" : cle = display-name normalise, pour retrouver un viewer d'un message
  // a l'autre malgre la casse.
  private viewers: Map<string, Viewer>;
  private teamsOn: boolean;
  private teamCount: number;
  private teamNames: Record<number, string>; // noms personnalises par l'hote (sinon defaut)
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
    this.viewers = new Map();
    this.teamsOn = false;
    this.teamCount = 2;
    this.teamNames = {};
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
      case "setTeamCount": return this.onSetTeamCount(ws, msg.n);
      case "setTeamName": return this.onSetTeamName(ws, msg.teamId, msg.name);
      case "setTeam": return this.onSetTeam(ws, msg.pseudo, msg.teamId);
      case "start": return this.onStart(ws, msg.mode, msg.gridSize, msg.level, msg.duration);
      case "chatWord": return this.onChatWord(ws, msg.viewer, msg.word);
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

    if (this.players.size >= this.capacity()) {
      this.err(ws, "ROOM_FULL", "Room pleine."); ws.close(); return;
    }
    if (this.phase !== "lobby") {
      this.err(ws, "WRONG_PHASE", "Partie en cours, attends la prochaine."); ws.close(); return;
    }

    const session: Session = {
      pseudo, ws, color: this.freeColor(), score: 0,
      myst: { solved: false, tries: 0 },
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

  private capacity(): number { return this.teamsOn ? MM_MAX_TEAMS : MM_MAX_INDIV; }

  private freeColor(): number {
    const used = new Set([...this.players.values()].map((p) => p.color));
    for (let i = 0; i < MM_MAX_TEAMS; i++) if (!used.has(i)) return i;
    return 0;
  }

  // ========================= Equipes (salon) =========================
  private teamCounts(): Record<number, number> {
    const c: Record<number, number> = {};
    for (const p of this.players.values()) c[p.teamId] = (c[p.teamId] || 0) + 1;
    return c;
  }
  // Equipe la moins peuplee (parmi 1..teamCount), pour une repartition de depart.
  private smallestTeam(): number {
    const c = this.teamCounts();
    let best = 1, bestN = Infinity;
    for (let t = 1; t <= this.teamCount; t++) {
      const n = c[t] || 0;
      if (n < bestN) { bestN = n; best = t; }
    }
    return best;
  }
  private nonEmptyTeams(): number[] {
    const c = this.teamCounts();
    return Object.keys(c).map(Number).filter((t) => t >= 1 && c[t] > 0);
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

  private onSetTeamsMode(ws: WebSocket, on: boolean): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (pseudo !== this.hostPseudo) return this.err(ws, "NOT_HOST", "Seul l'hote regle les equipes.");
    if (this.phase !== "lobby") return this.err(ws, "WRONG_PHASE", "Pas dans le salon.");
    // La capacite depend de ce reglage : on ne peut pas revenir en individuel
    // avec plus de monde que le mode n'en autorise. Plutot que d'ejecter des
    // joueurs, on refuse la bascule et on laisse l'hote decider.
    if (!on && this.players.size > MM_MAX_INDIV) {
      return this.err(ws, "ROOM_FULL",
        "Trop de joueurs pour l'individuel (" + MM_MAX_INDIV + " max, " + this.players.size + " connectes). Reste en equipes ou exclus des joueurs.");
    }
    this.teamsOn = !!on;
    if (this.teamsOn) {
      // Repartition de depart : alternance sur teamCount equipes (l'hote ajuste ensuite).
      let i = 0;
      for (const p of this.players.values()) { p.teamId = (i % this.teamCount) + 1; i++; }
    } else {
      for (const p of this.players.values()) p.teamId = 0;
    }
    this.broadcastRoom();
  }

  private onSetTeamCount(ws: WebSocket, n: number): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (pseudo !== this.hostPseudo) return this.err(ws, "NOT_HOST", "Seul l'hote regle les equipes.");
    if (this.phase !== "lobby") return this.err(ws, "WRONG_PHASE", "Pas dans le salon.");
    this.teamCount = Math.max(2, Math.min(MAX_TEAMS, Math.floor(n) || 2));
    // Les joueurs dans une equipe devenue hors limite reviennent en equipe 1.
    for (const p of this.players.values()) if (p.teamId > this.teamCount) p.teamId = 1;
    this.broadcastRoom();
  }

  private onSetTeamName(ws: WebSocket, teamId: number, name: string): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (pseudo !== this.hostPseudo) return this.err(ws, "NOT_HOST", "Seul l'hote nomme les equipes.");
    if (this.phase !== "lobby") return this.err(ws, "WRONG_PHASE", "Pas dans le salon.");
    const t = Math.floor(teamId);
    if (t < 1 || t > MAX_TEAMS) return;
    const clean = String(name || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 18);
    if (clean) this.teamNames[t] = clean;
    else delete this.teamNames[t];
    this.broadcastRoom();
  }

  private onSetTeam(ws: WebSocket, target: string, teamId: number): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (pseudo !== this.hostPseudo) return this.err(ws, "NOT_HOST", "Seul l'hote compose les equipes.");
    if (this.phase !== "lobby") return this.err(ws, "WRONG_PHASE", "Pas dans le salon.");
    if (!this.teamsOn) return;
    const t = Math.max(1, Math.min(this.teamCount, Math.floor(teamId)));
    for (const [p, s] of this.players.entries()) {
      if (p === target || pseudosEqual(p, target)) { s.teamId = t; break; }
    }
    this.broadcastRoom();
  }

  private teamColor(teamId: number): number { return Math.max(0, teamId - 1); }

  // Vrai si le joueur joue en equipe (et non chacun pour soi).
  private inTeam(p: Session): boolean { return this.teamsOn && p.teamId >= 1; }

  // Les joueurs qui partagent la grille de `p`, lui compris. Hors equipes, c'est
  // lui seul : les envois "prives" du mode chacun passent naturellement par la.
  private mates(p: Session): Session[] {
    if (!this.inTeam(p)) return [p];
    return [...this.players.values()].filter((x) => x.teamId === p.teamId);
  }

  // ========================= Lancement =========================
  private onStart(ws: WebSocket, mode: Mode, gridSize: number, level: string, duration: number): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (!pseudo || pseudo !== this.hostPseudo) return this.err(ws, "NOT_HOST", "Seul l'hote lance.");
    if (this.phase !== "lobby") return this.err(ws, "WRONG_PHASE", "Deja lancee.");

    this.mode = mode === "chacun" ? "chacun" : mode === "chat" ? "chat" : "commune";

    // En "chat", les joueurs sont les viewers Twitch : l'hote est seul devant sa
    // grille et arbitre. La regle des 2 joueurs connectes n'a donc pas de sens.
    if (this.mode !== "chat" && this.connected().length < ROOM_CONFIG.MIN_PLAYERS)
      return this.err(ws, "NOT_ENOUGH_PLAYERS", "Il faut au moins 2 joueurs.");

    // Les equipes du tchat viendront plus tard : pour l'instant chacun pour soi.
    if (this.mode === "chat") this.teamsOn = false;
    this.viewers = new Map();


    this.gridSize = ALLOWED_SIZES.includes(gridSize) ? gridSize : 12;
    this.level = ALLOWED_LEVELS.includes(level) ? level : "moyen";
    this.durationSec = ALLOWED_DURATIONS.includes(duration) ? duration : 300;

    // Les equipes valent pour les deux modes. En "commune" elles se partagent
    // la grille unique ; en "chacun" chaque equipe a SA grille, partagee entre
    // coequipiers et independante de celle des autres equipes.
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

    // Etat de jeu remis a zero. En equipes, les coequipiers pointent vers le
    // MEME Set de mots trouves et le MEME etat de mystere : c'est ce partage par
    // reference qui fait la grille commune a l'equipe, sans dupliquer d'etat.
    // Le score, lui, reste individuel (celui qui trouve marque) et s'additionne
    // par equipe au classement : un mot ne peut etre trouve qu'une fois par
    // equipe, donc la somme vaut bien le nombre de mots de l'equipe.
    const teamKeys = new Map<number, Set<string>>();
    const teamMyst = new Map<number, MysteryState>();
    for (const p of this.players.values()) {
      p.score = 0;
      p.lastFindAt = 0;
      if (this.teamsOn && p.teamId >= 1) {
        // En equipes, la couleur represente l'equipe (coequipiers = meme couleur).
        p.color = this.teamColor(p.teamId);
        if (!teamKeys.has(p.teamId)) {
          teamKeys.set(p.teamId, new Set());
          teamMyst.set(p.teamId, { solved: false, tries: 0 });
        }
        p.foundKeys = teamKeys.get(p.teamId)!;
        p.myst = teamMyst.get(p.teamId)!;
      } else {
        p.foundKeys = new Set();
        p.myst = { solved: false, tries: 0 };
      }
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
  // ========================= Tchat Twitch =========================
  // Un viewer ne clique pas des cases : il ecrit un mot. On valide donc par le
  // TEXTE, contre les mots pas encore trouves. Si le meme mot figure deux fois
  // dans la grille, la premiere occurrence libre est prise.
  private onChatWord(ws: WebSocket, viewer: string, word: string): void {
    const pseudo = this.wsToPseudo.get(ws);
    // Seul l'hote relaie : c'est sa page qui est branchee sur l'IRC. Sinon
    // n'importe quel client pourrait s'inventer des points au nom d'un viewer.
    if (!pseudo || pseudo !== this.hostPseudo) return;
    if (this.phase !== "playing" || this.mode !== "chat") return;

    const name = String(viewer || "").slice(0, 30).trim();
    if (!name) return;
    const key = name.toLowerCase();
    const g = this.norm(String(word || ""));
    if (!g || g.length < 2) return;

    const now = Date.now();
    let v = this.viewers.get(key);
    if (!v) {
      v = { name, color: -1, score: 0, lastFindAt: 0, tokens: CHAT_BURST, lastRefill: now };
      this.viewers.set(key, v);
    } else {
      v.name = name;
    }

    // Recharge du seau au prorata du temps ecoule, puis paiement de l'essai.
    const gained = (now - v.lastRefill) / CHAT_REFILL_MS;
    if (gained > 0) {
      v.tokens = Math.min(CHAT_BURST, v.tokens + gained);
      v.lastRefill = now;
    }
    if (v.tokens < 1) return;
    v.tokens -= 1;

    const w = this.words.find((x) => !x.found && x.word === g);
    if (!w) return;

    // Premier point : le viewer recoit sa couleur et entre au tableau.
    if (v.color < 0) v.color = this.freeViewerColor();
    w.found = true; w.byPseudo = v.name; w.color = v.color;
    v.score++; v.lastFindAt = now;

    const fw: FoundWord = { word: w.word, cells: w.cells, color: v.color, pseudo: v.name };
    const remaining = this.words.filter((x) => !x.found).length;
    this.broadcast({ type: "found", players: this.snapshot(), word: fw, remaining });
    if (remaining === 0) this.finish(this.leader());
  }

  // Les viewers puisent dans les memes index que les joueurs. Au-dela de la
  // palette de base, le front genere la teinte a la volee : pas de plafond.
  private freeViewerColor(): number {
    const used = new Set<number>();
    for (const p of this.players.values()) used.add(p.color);
    for (const v of this.viewers.values()) if (v.color >= 0) used.add(v.color);
    for (let i = 0; ; i++) if (!used.has(i)) return i;
  }

  private onClaim(ws: WebSocket, cells: Cell[]): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (!pseudo) return;
    if (this.phase !== "playing") return this.err(ws, "WRONG_PHASE", "Pas en jeu.");
    // En "chat", seul le tchat marque : l'hote affiche la grille, il ne joue pas.
    if (this.mode === "chat") return this.err(ws, "WRONG_PHASE", "C'est le tchat qui joue.");
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
      // "chacun" : verrouillage propre au joueur (ou a son equipe), pas de
      // blocage entre joueurs ou equipes adverses.
      for (const w of this.words) {
        if (key === w.key || key === w.rkey) {
          if (me.foundKeys.has(w.key)) {
            return this.send(ws, { type: "hint", kind: "already",
              message: this.inTeam(me) ? "Ton equipe l'a deja." : "Tu l'as deja." });
          }
          me.foundKeys.add(w.key);
          me.score++; me.lastFindAt = Date.now();
          const fw: FoundWord = { word: w.word, cells: w.cells, color: me.color, pseudo };
          const remaining = this.words.length - me.foundKeys.size;
          // La grille est partagee au sein de l'equipe : les coequipiers voient
          // le mot se barrer chez eux aussi.
          for (const m of this.mates(me)) {
            if (m.ws) this.send(m.ws, { type: "found", players: this.snapshot(), word: fw, remaining });
          }
          this.broadcastScores();
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

  // Le mystere est ouvert des le lancement : plus de verrou sur la completion de
  // la grille. Ce qui borne, c'est le nombre d'essais. En equipes, l'etat est
  // partage : 3 essais pour l'equipe, et le bonus ne tombe qu'une fois (sinon
  // une equipe de 4 encaisserait +12 face a un solo a +3).
  private onMysteryGuess(ws: WebSocket, guess: string): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (!pseudo) return;
    if (this.phase !== "playing" || this.mode !== "chacun") return this.err(ws, "WRONG_PHASE", "Indisponible ici.");
    const me = this.players.get(pseudo)!;
    const myst = me.myst;
    if (myst.solved) return;
    if (myst.tries >= MYSTERY_TRIES) {
      return this.send(ws, { type: "mystery_result", ok: false, triesLeft: 0, message: "Plus d'essais." });
    }
    const g = this.norm(String(guess || ""));
    if (!g) return;

    if (g === this.mysteryWord) {
      // Un essai reussi ne consomme rien : seuls les ratages coutent.
      myst.solved = true;
      // Le bonus va au joueur qui devine ; par sommation, l'equipe le touche une
      // seule fois.
      me.score += MYSTERY_BONUS;
      me.lastFindAt = Date.now();
      const left = MYSTERY_TRIES - myst.tries;
      for (const m of this.mates(me)) {
        if (!m.ws) continue;
        this.send(m.ws, {
          type: "mystery_result", ok: true, triesLeft: left,
          message: m.pseudo === pseudo
            ? "Mot mystere trouve ! +" + MYSTERY_BONUS + " points."
            : pseudo + " a trouve le mot mystere ! +" + MYSTERY_BONUS + " pour l'equipe.",
        });
      }
      this.broadcastScores();
      return;
    }

    myst.tries++;
    const left = MYSTERY_TRIES - myst.tries;
    const tail = left > 0
      ? left + (left > 1 ? " essais restants." : " essai restant.")
      : "Plus d'essais.";
    for (const m of this.mates(me)) {
      if (!m.ws) continue;
      this.send(m.ws, {
        type: "mystery_result", ok: false, triesLeft: left,
        message: m.pseudo === pseudo
          ? "Pas le bon mot. " + tail
          : pseudo + " a tente " + g + ". " + tail,
      });
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
      return t.length ? this.teamNameOf(t[0].teamId) : "";
    }
    const r = this.rank();
    return r.length ? r[0].pseudo : "";
  }
  private rank(): MmPlayer[] {
    return this.snapshot().sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return this.lastFindOf(a.pseudo) - this.lastFindOf(b.pseudo);
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
      mode: this.mode, teamsOn: this.teamsOn, teamNames: this.teamNamesArr(),
      mysteryWord: this.mode === "chacun" ? this.mysteryWord : "",
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
    // En "chat", les joueurs sont les viewers : l'hote n'est qu'un afficheur et
    // n'a pas sa place au tableau. Dans le salon en revanche, on montre les
    // connectes comme partout ailleurs (l'hote doit se voir avant de lancer).
    if (this.mode === "chat" && this.phase !== "lobby") return this.viewerSnapshot();
    return [...this.players.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({
        pseudo: p.pseudo, isHost: p.pseudo === this.hostPseudo, color: p.color,
        score: p.score, solvedMystery: p.myst.solved, isConnected: p.ws !== null,
        teamId: p.teamId,
      }));
  }

  // Seuls les viewers ayant marque entrent au tableau : sinon le moindre message
  // de tchat y ferait apparaitre son auteur a zero point.
  private viewerSnapshot(): MmPlayer[] {
    return [...this.viewers.values()]
      .filter((v) => v.score > 0)
      .sort((a, b) => (b.score - a.score) || (a.lastFindAt - b.lastFindAt))
      .map((v) => ({
        pseudo: v.name, isHost: false, color: v.color, score: v.score,
        solvedMystery: false, isConnected: true, teamId: 0, isViewer: true,
      }));
  }

  // Chrono de departage, que le pseudo soit un joueur connecte ou un viewer.
  private lastFindOf(pseudo: string): number {
    const p = this.players.get(pseudo);
    if (p) return p.lastFindAt || Infinity;
    const v = this.viewers.get(pseudo.toLowerCase());
    return v ? (v.lastFindAt || Infinity) : Infinity;
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
      mode: this.mode, teamsOn: this.teamsOn, teamNames: this.teamNamesArr(),
      gridSize: this.gridSize, grid: this.grid.map((row) => row.slice()),
      totalWords: this.words.length, level: this.level,
    };
    // "commune" et "chat" partagent une grille unique et n'ont pas de mystere :
    // personne n'y decouvre la grille entiere seul, donc personne ne le merite.
    if (this.mode === "commune" || this.mode === "chat") {
      return {
        ...base, found: this.foundShared(), endsAt: null,
        mysteryOpen: false, mysteryDefinition: null, mysteryLength: null, mysteryTriesLeft: 0,
      };
    }
    // "chacun" : le mystere est ouvert a tous des que la partie tourne. Ce sont
    // les cases restantes de chacun qui font la difficulte, pas un verrou.
    const p = this.players.get(forPseudo);
    const open = this.phase === "playing";
    return {
      ...base,
      found: p ? this.foundForPlayer(p) : [],
      endsAt: this.endsAt,
      mysteryOpen: open,
      mysteryDefinition: open ? this.mysteryDef : null,
      mysteryLength: open ? this.mysteryWord.length : null,
      mysteryTriesLeft: p ? Math.max(0, MYSTERY_TRIES - p.myst.tries) : MYSTERY_TRIES,
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
      config: { mode: this.mode, teamsOn: this.teamsOn, teamCount: this.teamCount, teamNames: this.teamNamesArr(), gridSize: this.gridSize, level: this.level, duration: this.durationSec },
      game: this.phase === "lobby" ? null : this.gameDTO(pseudo),
    });
  }

  private broadcastRoom(): void {
    this.broadcast({
      type: "room_state", players: this.snapshot(), hostPseudo: this.hostPseudo ?? "",
      phase: this.phase, teamsOn: this.teamsOn, teamCount: this.teamCount, teamNames: this.teamNamesArr(),
    });
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

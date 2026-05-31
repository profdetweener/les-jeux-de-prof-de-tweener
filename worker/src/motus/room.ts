/**
 * MotusRoom — Durable Object pour les parties de Motus.
 *
 * Une instance par room. Maintient en memoire :
 *   - la liste des joueurs connectes (avec pseudo, host status, score)
 *   - l'etat de la partie (phase, config, mot en cours)
 *   - les WebSockets ouvertes
 *
 * Modes de jeu (Livraison 2) :
 *   - "coop_stream" : seul l'hote saisit, tout le monde voit la meme grille.
 *     Pas de score, pas de timer, on enchaine les mots tant que l'hote veut.
 *
 * Les modes competitifs et le scoring arrivent en Livraison 3.
 */

import type {
  Attempt,
  ClientMessage,
  CompPreset,
  EndCondition,
  ErrorCode,
  GameFormat,
  GameMode,
  GameStats,
  MotusConfig,
  OpponentState,
  PlayerGameStats,
  PlayerInfo,
  PlayerRoundStatus,
  RoomPhase,
  RoundResult,
  ScoringMode,
  ServerMessage,
  WordState,
} from "./messages";
import { COMP_CONFIG, COMP_PRESETS, MOTUS_CONFIG, ROOM_CONFIG } from "./messages";
import { pseudosEqual, validatePseudo } from "../shared/moderation";
import {
  colorize,
  drawablePoolSize,
  isPlayableWord,
  normalizeGuess,
  pickRandomWord,
} from "./words";

interface PlayerSession {
  pseudo: string;
  ws: WebSocket | null;
  joinedAt: number;
  totalScore: number;
  isHost: boolean;
}

const DEFAULT_CONFIG: MotusConfig = {
  wordLength: MOTUS_CONFIG.DEFAULT_WORD_LEN,
  maxAttempts: MOTUS_CONFIG.DEFAULT_ATTEMPTS,
  mode: "coop_stream",
};

/**
 * Config par defaut pour une room en mode competitive (preset Speed,
 * appliquee tant que l'hote n'a pas pousse sa propre config).
 */
const DEFAULT_COMP_CONFIG: MotusConfig = {
  wordLength: MOTUS_CONFIG.DEFAULT_WORD_LEN,
  maxAttempts: MOTUS_CONFIG.DEFAULT_ATTEMPTS,
  mode: "competitive",
  preset: "speed",
  ...COMP_PRESETS.speed,
};

export class MotusRoom {
  private state: DurableObjectState;
  private players: Map<string, PlayerSession>;
  private wsToPseudo: Map<WebSocket, string>;
  private hostPseudo: string | null;

  /**
   * Mode gele a la creation de la room. Determine le default config et la
   * branche logique de la partie (coop_stream vs competitive). Lu au premier
   * acces depuis state.storage et garde en cache.
   *
   * `null` tant que la room n'est pas encore initialisee (boot avant /init).
   */
  private initialMode: GameMode | null;

  // Etat de partie
  private phase: RoomPhase;
  private config: MotusConfig;
  // Mot en cours (in_game ou between_words) — mode coop
  private targetWord: string | null;
  private attempts: Attempt[];
  private wordStatus: "in_progress" | "found" | "exhausted";
  private foundBy: string | null;

  // ===== Etat mode COMPETITIVE =====
  // Tout en memoire : une manche est courte et le DO reste actif tant qu'il y
  // a des connexions. La reconnexion d'un joueur retrouve son etat.
  private compRoundIndex: number;          // 1-based, 0 = pas encore commence
  private compWord: string | null;         // mot de la manche en cours
  private compDeadlineTs: number | null;   // fin de manche (ms)
  /** Etat par joueur pour la manche en cours : pseudo -> data. */
  private compPlayers: Map<
    string,
    {
      attempts: Attempt[];
      status: "playing" | "found" | "exhausted";
      foundAtMs: number | null;            // pour l'ordre d'arrivee
    }
  >;
  /** Ordre d'arrivee (pseudos qui ont trouve, dans l'ordre). */
  private compFinishOrder: string[];
  /** Score cumule par joueur sur la partie. pseudo -> points. */
  private compScores: Map<string, number>;
  /** Timestamp de debut de la manche en cours (Date.now()), pour calcul des temps de trouvaille. */
  private compRoundStartedAtMs: number | null;
  /**
   * Historique de toutes les manches jouees dans la partie courante, pour
   * generer les stats de fin de partie (gameStats). Push a chaque
   * endCompRound. Reset au demarrage d'une nouvelle partie comp et a
   * end_game.
   */
  private compRoundHistory: Array<{
    roundIndex: number;
    word: string;
    startedAtMs: number;
    endedAtMs: number;
    players: Array<{
      playerId: string;
      found: boolean;
      attemptsUsed: number;
      finishRank: number | null;
      foundAtMs: number | null;   // pour calcul du temps (foundAtMs - startedAtMs)
    }>;
  }>;
  /**
   * Historique des premieres lettres tirees recemment, pour reduire la
   * repetition d'une meme initiale sur plusieurs manches d'affilee. Fenetre
   * glissante : on retient jusqu'a 20 entrees, on en evite les 5 dernieres
   * au prochain tirage (cf. pickWord). Persiste tant que la DurableObject
   * vit (donc tout au long de la vie du salon).
   */
  private recentFirstLetters: string[];

  constructor(state: DurableObjectState) {
    this.state = state;
    this.players = new Map();
    this.wsToPseudo = new Map();
    this.hostPseudo = null;
    this.initialMode = null;
    this.phase = "lobby";
    this.config = { ...DEFAULT_CONFIG }; // sera ecrase au 1er fetch via loadInitialMode
    this.targetWord = null;
    this.attempts = [];
    this.wordStatus = "in_progress";
    this.foundBy = null;
    this.compRoundIndex = 0;
    this.compWord = null;
    this.compDeadlineTs = null;
    this.compPlayers = new Map();
    this.compFinishOrder = [];
    this.compScores = new Map();
    this.compRoundStartedAtMs = null;
    this.compRoundHistory = [];
    this.recentFirstLetters = [];

    // Charge l'identite de l'hote persistee en storage avant de traiter
    // toute requete (cf. persistHostPseudo). blockConcurrencyWhile garantit
    // que tout fetch entrant attend la fin de cette restauration. Sans ce
    // mecanisme, apres une eviction de la DurableObject (idle/memoire), le
    // 1er joueur a se reconnecter devenait host par defaut, peu importe son
    // role d'origine.
    this.state.blockConcurrencyWhile(async () => {
      try {
        const persistedHost = await this.state.storage.get<string>("hostPseudo");
        if (typeof persistedHost === "string" && persistedHost.length > 0) {
          this.hostPseudo = persistedHost;
        }
      } catch {
        /* tolerant aux echecs storage : on redemarre simplement sans host connu */
      }
    });
  }

  /**
   * Persiste le pseudo de l'hote courant en storage durable. Appele apres
   * toute mutation de this.hostPseudo (creation de room, kick, migration,
   * reset complet). Tolerant aux echecs : on log et on continue, la perte
   * de persistence ne doit jamais bloquer le jeu.
   */
  private async persistHostPseudo(): Promise<void> {
    try {
      if (this.hostPseudo) {
        await this.state.storage.put("hostPseudo", this.hostPseudo);
      } else {
        await this.state.storage.delete("hostPseudo");
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * Charge le mode persiste depuis storage (au premier acces). Le mode est
   * ecrit une seule fois, a la creation de la room (cf. __internal/init), et
   * ne change jamais ensuite — il est tout aussi immuable que le code de room.
   */
  private async loadInitialMode(): Promise<GameMode | null> {
    if (this.initialMode !== null) return this.initialMode;
    const stored = await this.state.storage.get<GameMode>("initialMode");
    if (stored === "coop_stream" || stored === "competitive") {
      this.initialMode = stored;
      // Aligne la config par defaut sur le mode (la 1ere config envoyee par
      // l'hote viendra l'ecraser, mais avant qu'il l'envoie c'est ce qu'on
      // expose dans le `joined`).
      this.config = stored === "competitive"
        ? { ...DEFAULT_COMP_CONFIG }
        : { ...DEFAULT_CONFIG };
      return stored;
    }
    return null;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Endpoints internes (utilises par le routeur)
    if (url.pathname === "/__internal/exists") {
      const mode = await this.loadInitialMode();
      return new Response(JSON.stringify({ exists: mode !== null }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/__internal/init") {
      // Body : { mode: "coop_stream" | "competitive" }. Si absent ou invalide,
      // on assume coop_stream (compat avec l'ancien client qui n'envoyait rien).
      let body: { mode?: string } = {};
      try {
        body = await request.json();
      } catch {
        /* body vide -> defaut coop_stream */
      }
      const mode: GameMode = body.mode === "competitive" ? "competitive" : "coop_stream";
      await this.state.storage.put("initialMode", mode);
      this.initialMode = mode;
      this.config = mode === "competitive"
        ? { ...DEFAULT_COMP_CONFIG }
        : { ...DEFAULT_CONFIG };
      return new Response(JSON.stringify({ ok: true, mode }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Upgrade WebSocket
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    // S'assure que le mode est charge avant d'accepter le WS (au cas ou la room
    // serait re-bootee suite a une eviction Cloudflare).
    const mode = await this.loadInitialMode();
    if (mode === null) {
      // Cas pathologique : WS sans __internal/init prealable. On accepte
      // quand meme et on persiste en coop_stream par defaut.
      await this.state.storage.put("initialMode", "coop_stream");
      this.initialMode = "coop_stream";
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    server.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      this.handleMessage(server, raw);
    });
    server.addEventListener("close", () => this.handleClose(server));
    server.addEventListener("error", () => this.handleClose(server));

    return new Response(null, { status: 101, webSocket: client });
  }

  // =========================================================================
  // Routing des messages clients
  // =========================================================================

  private handleMessage(ws: WebSocket, raw: string): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.sendError(ws, "INVALID_MESSAGE", "Message JSON invalide.");
      return;
    }
    if (!msg || typeof msg !== "object" || typeof (msg as any).type !== "string") {
      this.sendError(ws, "INVALID_MESSAGE", "Message sans champ 'type'.");
      return;
    }

    switch (msg.type) {
      case "ping":
        this.sendMessage(ws, { type: "pong" });
        // Safety net : si on est en manche comp et que la deadline est
        // depassee mais que l'alarme du DO n'a pas (encore) tire pour une
        // raison quelconque (retard plateforme, redeploiement...), on force
        // la fin de manche ici. Idempotent : endCompRound verifie la phase.
        if (
          this.phase === "in_round" &&
          this.config.mode === "competitive" &&
          this.compDeadlineTs !== null &&
          Date.now() >= this.compDeadlineTs
        ) {
          for (const st of this.compPlayers.values()) {
            if (st.status === "playing") st.status = "exhausted";
          }
          this.endCompRound();
        }
        return;
      case "join":
        this.handleJoin(ws, msg.pseudo);
        return;
      case "kick":
        this.handleKick(ws, msg.targetPseudo);
        return;
      case "config_update":
        this.handleConfigUpdate(ws, msg.config);
        return;
      case "start_game":
        this.handleStartGame(ws, msg.config);
        return;
      case "submit_guess":
        this.handleSubmitGuess(ws, msg.guess);
        return;
      case "next_word":
        this.handleNextWord(ws);
        return;
      case "next_round":
        this.handleNextRound(ws);
        return;
      case "skip_to_final":
        this.handleSkipToFinal(ws);
        return;
      case "end_game":
        this.handleEndGame(ws);
        return;
      default:
        this.sendError(ws, "INVALID_MESSAGE", `Type inconnu: ${(msg as any).type}`);
    }
  }

  // =========================================================================
  // Lobby : join / kick / close
  // =========================================================================

  private handleJoin(ws: WebSocket, rawPseudo: string): void {
    // Si ce ws est deja associe a un pseudo, c'est un double-join
    if (this.wsToPseudo.has(ws)) {
      this.sendError(ws, "ALREADY_JOINED", "Cette connexion est deja associee a un joueur.");
      return;
    }

    const pseudoCheck = validatePseudo(rawPseudo);
    if (!pseudoCheck.ok) {
      this.sendError(ws, "PSEUDO_INVALID", pseudoCheck.error);
      return;
    }
    const pseudo = pseudoCheck.normalized;

    // Reconnexion : pseudo deja connu
    const existing = this.findPlayerByPseudo(pseudo);
    if (existing) {
      if (existing.ws && existing.ws !== ws) {
        // Connexion precedente active -> on remplace (multi-onglet, on garde le dernier)
        try {
          existing.ws.close(1000, "remplace par une nouvelle connexion");
        } catch {
          /* ignore */
        }
        this.wsToPseudo.delete(existing.ws);
      }
      existing.ws = ws;
      this.wsToPseudo.set(ws, pseudo);
      this.sendJoined(ws, existing);
      this.broadcastRoomState();
      return;
    }

    // Room pleine ?
    if (this.players.size >= ROOM_CONFIG.MAX_PLAYERS) {
      this.sendError(ws, "ROOM_FULL", "La room est complete.");
      return;
    }

    // Nouveau joueur. Decision "isHost" :
    //  - Si on a un hostPseudo persiste (cas typique : DO redemarree apres
    //    eviction) ET que ce nouveau joueur correspond a ce pseudo : il
    //    recupere ses droits d'hote.
    //  - Si on n'a aucun hostPseudo connu (vraie creation de salon) : le
    //    1er joueur prend la main.
    //  - Sinon (un autre joueur que l'hote d'origine arrive en 1er apres
    //    redemarrage) : il rejoint en simple joueur, on attend que l'hote
    //    d'origine revienne. Evite le bug du non-hote qui herite des droits
    //    apres une eviction.
    const isFirstPlayer = this.players.size === 0;
    let shouldBeHost = false;
    if (this.hostPseudo === null && isFirstPlayer) {
      shouldBeHost = true;
    } else if (this.hostPseudo !== null && pseudosEqual(pseudo, this.hostPseudo)) {
      shouldBeHost = true;
    }

    const session: PlayerSession = {
      pseudo,
      ws,
      joinedAt: Date.now(),
      totalScore: 0,
      isHost: shouldBeHost,
    };
    this.players.set(pseudo, session);
    this.wsToPseudo.set(ws, pseudo);

    if (shouldBeHost) {
      this.hostPseudo = pseudo;
      void this.persistHostPseudo();
    }
    this.sendJoined(ws, session);
    this.broadcastRoomState();
  }

  private sendJoined(ws: WebSocket, session: PlayerSession): void {
    this.sendMessage(ws, {
      type: "joined",
      pseudo: session.pseudo,
      isHost: session.isHost,
      players: this.snapshotPlayers(),
      hostPseudo: this.hostPseudo ?? "",
      roomCode: this.state.id.toString(),
      phase: this.phase,
      config: this.config,
      currentWord: this.snapshotCurrentWord(),
      compRound: this.snapshotCompRound(session.pseudo),
    });
  }

  /**
   * Construit l'etat de la manche comp pour un joueur donne (reconnexion).
   * Renvoie null si pas de manche comp en cours (in_round).
   */
  private snapshotCompRound(pseudo: string) {
    if (this.phase !== "in_round" || !this.compWord || this.compDeadlineTs === null) {
      return null;
    }
    const mine = this.compPlayers.get(pseudo);
    const opponentStates = [];
    for (const [p, st] of this.compPlayers) {
      if (p === pseudo) continue;
      opponentStates.push({
        playerId: p,
        rows: st.attempts.map((a) => ({
          feedback: a.feedback.map((f) => f.status),
          hasMore: a.feedback.map((f) => f.hasMore),
        })),
        status: st.status,
        attemptsUsed: st.attempts.length,
      });
    }
    const totalRounds =
      this.config.format === "fixed_rounds" ? (this.config.maxRounds ?? 0) : null;
    return {
      roundIndex: this.compRoundIndex,
      totalRounds,
      firstLetter: this.compWord[0],
      wordLength: this.compWord.length,
      maxAttempts: this.config.maxAttempts,
      timerSeconds: this.config.timerSeconds ?? 90,
      deadlineTs: this.compDeadlineTs,
      opponents: [...this.compPlayers.keys()].filter((p) => p !== pseudo),
      myAttempts: mine ? mine.attempts : [],
      myStatus: (mine ? mine.status : "playing") as PlayerRoundStatus,
      opponentStates,
    };
  }

  private handleKick(ws: WebSocket, targetPseudo: string): void {
    const me = this.pseudoOf(ws);
    if (!me) return;
    if (me !== this.hostPseudo) {
      this.sendError(ws, "NOT_HOST", "Seul l'hote peut kicker.");
      return;
    }
    if (pseudosEqual(targetPseudo, me)) {
      this.sendError(ws, "CANNOT_KICK_SELF", "Tu ne peux pas te kicker toi-meme.");
      return;
    }
    const target = this.findPlayerByPseudo(targetPseudo);
    if (!target) {
      this.sendError(ws, "TARGET_NOT_FOUND", "Joueur introuvable.");
      return;
    }
    if (target.ws) {
      try {
        target.ws.send(JSON.stringify({ type: "kicked", reason: "Kicke par l'hote." }));
        target.ws.close(1000, "kicked");
      } catch {
        /* ignore */
      }
    }
    this.removePlayer(target.pseudo);
    this.broadcastRoomState();
  }

  private handleClose(ws: WebSocket): void {
    const pseudo = this.wsToPseudo.get(ws);
    this.wsToPseudo.delete(ws);
    if (!pseudo) return;
    const session = this.players.get(pseudo);
    if (!session) return;
    if (session.ws === ws) session.ws = null;
    // Si tous les joueurs sont deconnectes pendant trop longtemps,
    // la room sera evictee par Cloudflare. Pas de menage manuel.
    this.broadcastRoomState();
  }

  /**
   * Suppression complete d'un joueur (apres kick). Si c'etait l'hote,
   * promeut le joueur le plus ancien restant.
   */
  private removePlayer(pseudo: string): void {
    const session = this.players.get(pseudo);
    if (!session) return;
    if (session.ws) this.wsToPseudo.delete(session.ws);
    this.players.delete(pseudo);

    if (pseudosEqual(pseudo, this.hostPseudo ?? "")) {
      // Migration d'hote : le plus ancien restant
      const remaining = [...this.players.values()].sort(
        (a, b) => a.joinedAt - b.joinedAt
      );
      if (remaining.length > 0) {
        const newHost = remaining[0];
        newHost.isHost = true;
        this.hostPseudo = newHost.pseudo;
      } else {
        this.hostPseudo = null;
      }
      // Persiste le nouveau host (ou son absence) pour survivre a une
      // eviction de la DurableObject.
      void this.persistHostPseudo();
    }

    // Mode comp : retire le joueur des structures et reverifie si la manche
    // peut se terminer (il bloquait peut-etre la condition everyone_done).
    this.compPlayers.delete(pseudo);
    this.compScores.delete(pseudo);
    this.compFinishOrder = this.compFinishOrder.filter((p) => p !== pseudo);
    if (this.phase === "in_round") {
      this.maybeEndCompRound();
    }
  }

  // =========================================================================
  // Config & demarrage de partie
  // =========================================================================

  private handleConfigUpdate(ws: WebSocket, config: MotusConfig): void {
    const me = this.pseudoOf(ws);
    if (!me || me !== this.hostPseudo) {
      this.sendError(ws, "NOT_HOST", "Seul l'hote peut modifier la config.");
      return;
    }
    if (this.phase !== "lobby" && this.phase !== "between_words") {
      this.sendError(ws, "WRONG_PHASE", "La config ne peut etre modifiee qu'au lobby.");
      return;
    }
    const norm = this.normalizeConfig(config);
    if (!norm.ok) {
      this.sendError(ws, "INVALID_CONFIG", norm.error);
      return;
    }
    this.config = norm.config;
    this.broadcast({ type: "config_update", config: this.config });
  }

  private handleStartGame(ws: WebSocket, config: MotusConfig): void {
    const me = this.pseudoOf(ws);
    if (!me || me !== this.hostPseudo) {
      this.sendError(ws, "NOT_HOST", "Seul l'hote peut lancer la partie.");
      return;
    }
    if (this.phase !== "lobby") {
      this.sendError(ws, "WRONG_PHASE", "Partie deja en cours.");
      return;
    }
    if (this.players.size < ROOM_CONFIG.MIN_PLAYERS) {
      this.sendError(
        ws,
        "NOT_ENOUGH_PLAYERS",
        `Il faut au moins ${ROOM_CONFIG.MIN_PLAYERS} joueurs.`
      );
      return;
    }
    const norm = this.normalizeConfig(config);
    if (!norm.ok) {
      this.sendError(ws, "INVALID_CONFIG", norm.error);
      return;
    }
    this.config = norm.config;
    this.broadcast({ type: "config_update", config: this.config });

    if (this.config.mode === "competitive") {
      // Demarrage de la partie competitive : reset des scores, manche 1.
      this.compScores = new Map();
      for (const p of this.players.keys()) this.compScores.set(p, 0);
      this.compRoundIndex = 0;
      this.compRoundHistory = []; // nouvelle partie : reset des stats accumulees
      this.startCompRound();
      return;
    }

    this.startNextWord();
  }

  /**
   * Demarre un nouveau mot. Suppose que this.config est valide.
   */
  private startNextWord(): void {
    const word = this.pickWordAvoidingRecent(this.config.wordLength);
    if (!word) {
      // Cas tres improbable : pool vide pour cette longueur
      this.broadcastError("INVALID_CONFIG", "Aucun mot disponible pour cette longueur.");
      return;
    }
    this.targetWord = word;
    this.attempts = [];
    this.wordStatus = "in_progress";
    this.foundBy = null;
    this.phase = "in_game";

    this.broadcast({
      type: "word_started",
      firstLetter: word[0],
      wordLength: word.length,
      maxAttempts: this.config.maxAttempts,
    });
  }

  /**
   * Tire un mot via pickRandomWord en evitant les premieres lettres tirees
   * recemment (5 dernieres), pour reduire la repetition d'une meme initiale
   * sur des manches consecutives. Met a jour l'historique apres tirage.
   * Fallback sur n'importe quel mot si toutes les premieres lettres sont
   * dans l'historique recent (pool tres restreint).
   */
  private pickWordAvoidingRecent(length: number): string | null {
    const avoid = new Set(this.recentFirstLetters.slice(-5));
    const word = pickRandomWord(length, avoid);
    if (word) {
      this.recentFirstLetters.push(word[0]);
      if (this.recentFirstLetters.length > 20) this.recentFirstLetters.shift();
    }
    return word;
  }

  // =========================================================================
  // Mode COMPETITIVE : manche, scoring, boucle
  // =========================================================================

  /**
   * Demarre une nouvelle manche competitive. Tire un mot (commun a tous),
   * reset l'etat par joueur, arme l'alarme du timer, diffuse round_started.
   */
  private startCompRound(): void {
    const word = this.pickWordAvoidingRecent(this.config.wordLength);
    if (!word) {
      this.broadcastError("INVALID_CONFIG", "Aucun mot disponible pour cette longueur.");
      return;
    }
    this.compRoundIndex += 1;
    this.compWord = word;
    this.compFinishOrder = [];
    this.compPlayers = new Map();
    for (const pseudo of this.players.keys()) {
      this.compPlayers.set(pseudo, { attempts: [], status: "playing", foundAtMs: null });
    }

    const timerSec = this.config.timerSeconds ?? 90;
    this.compDeadlineTs = Date.now() + timerSec * 1000;
    this.compRoundStartedAtMs = Date.now();
    this.phase = "in_round";

    // Arme l'alarme pour la fin de manche au timer
    this.state.storage.setAlarm(this.compDeadlineTs);

    const totalRounds =
      this.config.format === "fixed_rounds" ? (this.config.maxRounds ?? 0) : null;
    const allPseudos = [...this.players.keys()];

    // Chaque joueur reçoit la liste de SES adversaires (tous sauf lui)
    for (const [pseudo, session] of this.players) {
      if (!session.ws) continue;
      const opponents = allPseudos.filter((p) => p !== pseudo);
      this.sendMessage(session.ws, {
        type: "round_started",
        roundIndex: this.compRoundIndex,
        totalRounds,
        firstLetter: word[0],
        wordLength: word.length,
        maxAttempts: this.config.maxAttempts,
        timerSeconds: timerSec,
        deadlineTs: this.compDeadlineTs,
        opponents,
      });
    }
  }

  /**
   * Essai d'un joueur en mode competitive. Valide, colore, met a jour son etat,
   * lui renvoie sa ligne complete et diffuse aux autres les couleurs only.
   */
  private handleCompGuess(ws: WebSocket, me: string, rawGuess: string): void {
    if (this.phase !== "in_round" || !this.compWord) {
      this.sendError(ws, "WRONG_PHASE", "Aucune manche en cours.");
      return;
    }
    const mine = this.compPlayers.get(me);
    if (!mine || mine.status !== "playing") {
      this.sendError(ws, "WRONG_PHASE", "Tu as deja termine cette manche.");
      return;
    }

    const guess = normalizeGuess(rawGuess);
    if (guess.length !== this.compWord.length) {
      this.sendError(ws, "INVALID_GUESS_LENGTH", `Le mot doit faire ${this.compWord.length} lettres.`);
      return;
    }
    if (!/^[A-Z]+$/.test(guess)) {
      this.sendError(ws, "INVALID_GUESS_LETTERS", "Seules les lettres A-Z sont acceptees.");
      return;
    }
    if (guess[0] !== this.compWord[0]) {
      this.sendError(ws, "INVALID_GUESS_FIRST_LETTER", `Le mot doit commencer par ${this.compWord[0]}.`);
      return;
    }
    if (!isPlayableWord(guess)) {
      this.sendError(ws, "WORD_NOT_IN_DICTIONARY", `"${guess}" n'est pas dans le dictionnaire.`);
      return;
    }

    const attempt = colorize(this.compWord, guess);
    mine.attempts.push(attempt);
    const attemptIndex = mine.attempts.length - 1;

    const allGood = attempt.feedback.every((f) => f.status === "good");
    if (allGood) {
      mine.status = "found";
      mine.foundAtMs = Date.now();
      this.compFinishOrder.push(me);
    } else if (mine.attempts.length >= this.config.maxAttempts) {
      mine.status = "exhausted";
    }

    // Renvoie au joueur sa ligne complete (lettres + couleurs)
    this.sendMessage(ws, {
      type: "guess_result",
      attempt,
      attemptIndex,
      myStatus: mine.status,
    });

    // Diffuse aux autres : couleurs only
    const row = {
      feedback: attempt.feedback.map((f) => f.status),
      hasMore: attempt.feedback.map((f) => f.hasMore),
    };
    for (const [pseudo, session] of this.players) {
      if (pseudo === me || !session.ws) continue;
      this.sendMessage(session.ws, {
        type: "opponent_progress",
        playerId: me,
        row,
        rowIndex: attemptIndex,
        status: mine.status,
        attemptsUsed: mine.attempts.length,
      });
    }

    // La manche doit-elle se terminer ?
    this.maybeEndCompRound();
  }

  /**
   * Verifie si la manche doit se terminer selon endCondition, et le cas echeant
   * la termine. Appele apres chaque essai et a l'expiration du timer.
   */
  private maybeEndCompRound(): void {
    if (this.phase !== "in_round") return;
    const states = [...this.compPlayers.values()];
    const someoneFound = states.some((s) => s.status === "found");
    const allDone = states.every((s) => s.status !== "playing");

    let shouldEnd = false;
    switch (this.config.endCondition) {
      case "first_finds":
        shouldEnd = someoneFound || allDone;
        break;
      case "everyone_done":
        shouldEnd = allDone;
        break;
      case "timer_only":
        // Ne se termine que par le timer (ou si tout le monde a fini avant).
        shouldEnd = allDone;
        break;
    }
    if (shouldEnd) this.endCompRound();
  }

  /**
   * Termine la manche : calcule les scores, met a jour le cumul, diffuse
   * round_ended. Annule l'alarme. Passe en between_rounds ou finished.
   */
  private endCompRound(): void {
    if (this.phase !== "in_round" || !this.compWord) return;
    this.phase = "between_rounds";
    this.state.storage.deleteAlarm();

    const word = this.compWord;
    const scoring = this.config.scoring ?? "binary";
    const maxAttempts = this.config.maxAttempts;
    const nbFinders = this.compFinishOrder.length;

    // Calcule les points de la manche par joueur
    const results: RoundResult[] = [];
    for (const [pseudo, st] of this.compPlayers) {
      const found = st.status === "found";
      const rank = found ? this.compFinishOrder.indexOf(pseudo) + 1 : null;
      let pts = 0;
      let breakdown = "";
      // Helper d'affichage des points avec accord singulier/pluriel.
      const ptsLabel = (n: number) => `${n}${n === 1 ? "pt" : "pts"}`;
      if (found) {
        const attemptsLeft = Math.max(0, maxAttempts - st.attempts.length);
        const essaiNoun = attemptsLeft === 1 ? "essai restant" : "essais restants";
        const suffix = rank === 1 ? "er" : "e";
        switch (scoring) {
          case "binary":
            pts = rank === 1 ? 1 : 0;
            breakdown = rank === 1 ? "1er trouvé (1pt)" : "Pas 1er trouvé (0pt)";
            break;
          case "attempts_left":
            pts = attemptsLeft + 1;
            breakdown = `${attemptsLeft} ${essaiNoun} (${ptsLabel(attemptsLeft)}) + trouvé (1pt)`;
            break;
          case "position": {
            pts = rank ? Math.max(0, nbFinders - (rank - 1)) : 0;
            breakdown = `${rank}${suffix} place (${ptsLabel(pts)})`;
            break;
          }
          case "combo": {
            const posBonus = rank ? Math.max(0, nbFinders - (rank - 1)) : 0;
            pts = attemptsLeft + 1 + posBonus;
            breakdown = `${attemptsLeft} ${essaiNoun} (${ptsLabel(attemptsLeft)}) + trouvé (1pt) + ${rank}${suffix} place (${ptsLabel(posBonus)})`;
            break;
          }
        }
      } else {
        breakdown = "Pas trouvé (0pt)";
      }
      const prevTotal = this.compScores.get(pseudo) ?? 0;
      const newTotal = prevTotal + pts;
      this.compScores.set(pseudo, newTotal);
      results.push({
        playerId: pseudo,
        found,
        attemptsUsed: st.attempts.length,
        finishRank: rank,
        roundPoints: pts,
        totalPoints: newTotal,
        pointsBreakdown: breakdown,
      });
    }

    // Tri par score cumule decroissant
    results.sort((a, b) => b.totalPoints - a.totalPoints);

    // Push une entree dans l'historique de la partie pour le calcul des
    // stats finales. On capture le state par joueur de cette manche (found,
    // attemptsUsed, finishRank, foundAtMs) ainsi que le timing de la manche.
    const startedAtMs = this.compRoundStartedAtMs ?? Date.now();
    const endedAtMs = Date.now();
    const historyPlayers: Array<{
      playerId: string;
      found: boolean;
      attemptsUsed: number;
      finishRank: number | null;
      foundAtMs: number | null;
    }> = [];
    for (const [pseudo, st] of this.compPlayers) {
      const found = st.status === "found";
      const rank = found ? this.compFinishOrder.indexOf(pseudo) + 1 : null;
      historyPlayers.push({
        playerId: pseudo,
        found,
        attemptsUsed: st.attempts.length,
        finishRank: rank,
        foundAtMs: st.foundAtMs,
      });
    }
    this.compRoundHistory.push({
      roundIndex: this.compRoundIndex,
      word,
      startedAtMs,
      endedAtMs,
      players: historyPlayers,
    });

    // La partie est-elle finie ?
    const isLast = this.isCompGameOver();
    const totalRounds =
      this.config.format === "fixed_rounds" ? (this.config.maxRounds ?? 0) : null;

    this.broadcast({
      type: "round_ended",
      revealedWord: word,
      results,
      roundIndex: this.compRoundIndex,
      totalRounds,
      isLastRound: isLast,
    });

    if (isLast) {
      // On NE bascule PAS immediatement en "finished" : le client doit pouvoir
      // afficher le recap detaille de la derniere manche (qui a trouve, en
      // combien d'essais, breakdown des points) avant de voir le podium final.
      // L'hote enchaine via "skip_to_final" (= bouton "Voir le classement
      // final") ou "end_game" (= "Quitter la partie") depuis la vue recap.
      // La phase reste "between_rounds" jusque-la.
      this.phase = "between_rounds";
    }
  }
  /**
   * Calcule les stats finales de la partie comp a partir de l'historique des
   * manches. Retourne null si aucune manche jouee. Les highlights sont
   * optionnels : null si la donnee n'a pas de sens (ex: hardestWord = null
   * si tous les mots ont ete trouves par au moins un joueur).
   *
   * L'argument `finalResults` sert UNIQUEMENT a ordonner playerStats dans le
   * meme ordre que le classement final (= meme ordre que dans la table du
   * podium), pour que le frontend puisse mapper ligne a ligne sans relogique.
   */
  private computeGameStats(finalResults: RoundResult[]): GameStats | null {
    const history = this.compRoundHistory;
    if (history.length === 0) return null;

    // Collecte par joueur, sur toute la partie
    type Acc = {
      foundCount: number;
      firstCount: number;
      attemptsSum: number;
      timeSumMs: number;
      bestAttempts: number | null;
      bestWord: string | null;
      recordTimeMs: number | null;
      recordWord: string | null;
    };
    const accByPlayer = new Map<string, Acc>();

    // Aggregats globaux pour highlights
    let absoluteRecordTimeMs: number | null = null;
    let absoluteRecordPlayer: string | null = null;
    let absoluteRecordWord: string | null = null;
    let fastestRoundTimeMs: number | null = null;
    let fastestRoundWord: string | null = null;
    let inExtremisAttempts = 0;
    let inExtremisPlayer: string | null = null;
    let inExtremisWord: string | null = null;
    let hardestWord: string | null = null;
    let solidarityWord: string | null = null;
    let solidarityAttempts = 0;
    let wordsResolved = 0;
    let globalTimeSumMs = 0;
    let globalFoundCount = 0;

    for (const round of history) {
      // Premier trouveur de la manche (finishRank === 1)
      let firstFinderTimeMs: number | null = null;

      // Solidarity check : tous trouvent et meme attemptsUsed
      let allFound = round.players.length > 0;
      const allAttempts: number[] = [];
      let anyFound = false;

      for (const p of round.players) {
        let acc = accByPlayer.get(p.playerId);
        if (!acc) {
          acc = {
            foundCount: 0,
            firstCount: 0,
            attemptsSum: 0,
            timeSumMs: 0,
            bestAttempts: null,
            bestWord: null,
            recordTimeMs: null,
            recordWord: null,
          };
          accByPlayer.set(p.playerId, acc);
        }
        if (p.found) {
          anyFound = true;
          acc.foundCount += 1;
          acc.attemptsSum += p.attemptsUsed;
          if (acc.bestAttempts === null || p.attemptsUsed < acc.bestAttempts) {
            acc.bestAttempts = p.attemptsUsed;
            acc.bestWord = round.word;
          }
          if (p.foundAtMs !== null) {
            const t = p.foundAtMs - round.startedAtMs;
            if (t >= 0) {
              acc.timeSumMs += t;
              if (acc.recordTimeMs === null || t < acc.recordTimeMs) {
                acc.recordTimeMs = t;
                acc.recordWord = round.word;
              }
              globalTimeSumMs += t;
              globalFoundCount += 1;
              if (absoluteRecordTimeMs === null || t < absoluteRecordTimeMs) {
                absoluteRecordTimeMs = t;
                absoluteRecordPlayer = p.playerId;
                absoluteRecordWord = round.word;
              }
              if (p.finishRank === 1) {
                firstFinderTimeMs = t;
              }
            }
          }
          if (p.finishRank === 1) {
            acc.firstCount += 1;
          }
          // In extremis : joueur qui a trouve avec le plus d'essais sur l'ensemble
          if (p.attemptsUsed > inExtremisAttempts) {
            inExtremisAttempts = p.attemptsUsed;
            inExtremisPlayer = p.playerId;
            inExtremisWord = round.word;
          }
          allAttempts.push(p.attemptsUsed);
        } else {
          allFound = false;
        }
      }

      if (anyFound) wordsResolved += 1;

      // Mot du desespoir : on prend le PREMIER mot que personne n'a trouve
      // (si plusieurs, on garde le 1er rencontre — souvent le plus marquant
      // pour les joueurs qui se souviennent du debut de partie).
      if (!anyFound && hardestWord === null && round.players.length > 0) {
        hardestWord = round.word;
      }

      // Manche eclair : la manche ou le PREMIER a ete le plus rapide
      if (firstFinderTimeMs !== null) {
        if (fastestRoundTimeMs === null || firstFinderTimeMs < fastestRoundTimeMs) {
          fastestRoundTimeMs = firstFinderTimeMs;
          fastestRoundWord = round.word;
        }
      }

      // Manche solidaire : tout le monde a trouve avec le meme attemptsUsed
      if (allFound && allAttempts.length >= 2) {
        const same = allAttempts.every((v) => v === allAttempts[0]);
        if (same && solidarityWord === null) {
          solidarityWord = round.word;
          solidarityAttempts = allAttempts[0];
        }
      }
    }

    // Roi du 1er : joueur avec le firstCount le plus eleve (au moins 1).
    // Tie-break par ordre du classement final (1er entre dans le ranking arrive en premier).
    let firstKingPlayer: string | null = null;
    let firstKingCount = 0;
    for (const r of finalResults) {
      const acc = accByPlayer.get(r.playerId);
      if (!acc) continue;
      if (acc.firstCount > firstKingCount) {
        firstKingCount = acc.firstCount;
        firstKingPlayer = r.playerId;
      }
    }

    // Construit playerStats dans l'ordre du classement final
    const players: PlayerGameStats[] = finalResults.map((r) => {
      const acc = accByPlayer.get(r.playerId);
      if (!acc) {
        return {
          playerId: r.playerId,
          foundCount: 0,
          firstCount: 0,
          avgAttempts: null,
          bestAttempts: null,
          bestWord: null,
          avgTimeSec: null,
          recordTimeSec: null,
          recordWord: null,
        };
      }
      const avgAttempts = acc.foundCount > 0 ? acc.attemptsSum / acc.foundCount : null;
      // avgTimeSec uniquement sur les manches ou on a un foundAtMs valide
      // (peut etre < acc.foundCount si foundAtMs manquant, cas pathologique).
      const avgTimeSec = acc.foundCount > 0 && acc.timeSumMs > 0
        ? acc.timeSumMs / acc.foundCount / 1000
        : null;
      return {
        playerId: r.playerId,
        foundCount: acc.foundCount,
        firstCount: acc.firstCount,
        avgAttempts,
        bestAttempts: acc.bestAttempts,
        bestWord: acc.bestWord,
        avgTimeSec,
        recordTimeSec: acc.recordTimeMs !== null ? acc.recordTimeMs / 1000 : null,
        recordWord: acc.recordWord,
      };
    });

    // Duree totale = du debut de la 1ere manche a la fin de la derniere.
    const totalDurationSec = Math.max(
      0,
      (history[history.length - 1].endedAtMs - history[0].startedAtMs) / 1000
    );

    const avgTimeSec = globalFoundCount > 0 ? globalTimeSumMs / globalFoundCount / 1000 : null;

    return {
      totalRounds: history.length,
      totalDurationSec,
      wordsResolved,
      avgTimeSec,
      players,
      highlights: {
        hardestWord: hardestWord ? { word: hardestWord } : null,
        fastestRound:
          fastestRoundWord && fastestRoundTimeMs !== null
            ? { word: fastestRoundWord, timeSec: fastestRoundTimeMs / 1000 }
            : null,
        inExtremis:
          inExtremisPlayer && inExtremisWord
            ? {
                word: inExtremisWord,
                playerId: inExtremisPlayer,
                attemptsUsed: inExtremisAttempts,
              }
            : null,
        solidarityRound: solidarityWord
          ? { word: solidarityWord, attemptsUsed: solidarityAttempts }
          : null,
        firstFinderKing:
          firstKingPlayer && firstKingCount > 0
            ? { playerId: firstKingPlayer, count: firstKingCount, total: history.length }
            : null,
        absoluteRecord:
          absoluteRecordPlayer && absoluteRecordWord && absoluteRecordTimeMs !== null
            ? {
                playerId: absoluteRecordPlayer,
                word: absoluteRecordWord,
                timeSec: absoluteRecordTimeMs / 1000,
              }
            : null,
      },
    };
  }

  /**
   * Determine si la partie competitive est terminee selon le format.
   */
  private isCompGameOver(): boolean {
    switch (this.config.format) {
      case "fixed_rounds":
        return this.compRoundIndex >= (this.config.maxRounds ?? 0);
      case "first_to_points": {
        const target = this.config.pointsTarget ?? 0;
        for (const v of this.compScores.values()) {
          if (v >= target) return true;
        }
        return false;
      }
      case "unlimited":
      default:
        return false; // l'hote arrete via end_game
    }
  }

  private handleNextRound(ws: WebSocket): void {
    const me = this.pseudoOf(ws);
    if (!me || me !== this.hostPseudo) {
      this.sendError(ws, "NOT_HOST", "Seul l'hote peut lancer la manche suivante.");
      return;
    }
    if (this.phase !== "between_rounds") {
      this.sendError(ws, "WRONG_PHASE", "Pas en intermanche.");
      return;
    }
    this.startCompRound();
  }

  /**
   * "Voir le classement final" depuis le recap d'une manche : on saute toutes
   * les manches restantes et on bascule directement en finished + game_ended
   * avec les scores actuels.
   */
  private handleSkipToFinal(ws: WebSocket): void {
    const me = this.pseudoOf(ws);
    if (!me || me !== this.hostPseudo) {
      this.sendError(ws, "NOT_HOST", "Seul l'hote peut passer aux resultats finaux.");
      return;
    }
    if (this.phase !== "between_rounds") {
      this.sendError(ws, "WRONG_PHASE", "Action uniquement possible entre les manches.");
      return;
    }
    // Construit les results a partir des scores cumules
    const finalResults: RoundResult[] = [];
    for (const [pseudo, total] of this.compScores) {
      finalResults.push({
        playerId: pseudo,
        found: false,
        attemptsUsed: 0,
        finishRank: null,
        roundPoints: 0,
        totalPoints: total,
        pointsBreakdown: "",
      });
    }
    finalResults.sort((a, b) => b.totalPoints - a.totalPoints);
    this.phase = "finished";
    const gameStats = this.computeGameStats(finalResults);
    this.broadcast({
      type: "game_ended",
      results: finalResults,
      ...(gameStats ? { gameStats } : {}),
    });
  }

  /**
   * Handler d'alarme : declenche la fin de manche au timer (mode comp).
   */
  async alarm(): Promise<void> {
    if (this.phase === "in_round" && this.config.mode === "competitive") {
      // Marque tous les joueurs encore "playing" comme exhausted (temps ecoule)
      for (const st of this.compPlayers.values()) {
        if (st.status === "playing") st.status = "exhausted";
      }
      this.endCompRound();
    }
  }

  // =========================================================================
  // Saisie d'un essai (mode coop : host uniquement)
  // =========================================================================

  private handleSubmitGuess(ws: WebSocket, rawGuess: string): void {
    const me = this.pseudoOf(ws);
    if (!me) return;

    // Mode competitive : chaque joueur a sa propre grille
    if (this.config.mode === "competitive") {
      this.handleCompGuess(ws, me, rawGuess);
      return;
    }

    if (this.phase !== "in_game" || !this.targetWord) {
      this.sendError(ws, "WRONG_PHASE", "Aucune partie en cours.");
      return;
    }
    // Mode coop : seul l'hote peut tapper
    if (this.config.mode === "coop_stream" && me !== this.hostPseudo) {
      this.sendError(ws, "NOT_HOST", "Seul l'hote saisit les essais en mode coop.");
      return;
    }

    const guess = normalizeGuess(rawGuess);

    if (guess.length !== this.targetWord.length) {
      this.sendError(
        ws,
        "INVALID_GUESS_LENGTH",
        `Le mot doit faire ${this.targetWord.length} lettres.`
      );
      return;
    }
    if (!/^[A-Z]+$/.test(guess)) {
      this.sendError(ws, "INVALID_GUESS_LETTERS", "Seules les lettres A-Z sont acceptees.");
      return;
    }
    if (guess[0] !== this.targetWord[0]) {
      this.sendError(
        ws,
        "INVALID_GUESS_FIRST_LETTER",
        `Le mot doit commencer par ${this.targetWord[0]}.`
      );
      return;
    }
    if (!isPlayableWord(guess)) {
      this.sendError(
        ws,
        "WORD_NOT_IN_DICTIONARY",
        `"${guess}" n'est pas dans le dictionnaire.`
      );
      return;
    }

    const attempt = colorize(this.targetWord, guess);
    this.attempts.push(attempt);
    const attemptIndex = this.attempts.length - 1;

    // Mot trouve ?
    const allGood = attempt.feedback.every((f) => f.status === "good");
    let revealedWord: string | null = null;

    if (allGood) {
      this.wordStatus = "found";
      this.foundBy = me;
      this.phase = "between_words";
      revealedWord = this.targetWord;
    } else if (this.attempts.length >= this.config.maxAttempts) {
      this.wordStatus = "exhausted";
      this.foundBy = null;
      this.phase = "between_words";
      revealedWord = this.targetWord;
    }

    this.broadcast({
      type: "guess_resolved",
      attempt,
      attemptIndex,
      status: this.wordStatus,
      revealedWord,
      foundBy: this.foundBy,
    });
  }

  // =========================================================================
  // Transitions de fin de manche
  // =========================================================================

  private handleNextWord(ws: WebSocket): void {
    const me = this.pseudoOf(ws);
    if (!me || me !== this.hostPseudo) {
      this.sendError(ws, "NOT_HOST", "Seul l'hote peut demarrer le prochain mot.");
      return;
    }
    if (this.phase !== "between_words") {
      this.sendError(ws, "WRONG_PHASE", "Pas dans la phase de transition.");
      return;
    }
    this.startNextWord();
  }

  private handleEndGame(ws: WebSocket): void {
    const me = this.pseudoOf(ws);
    if (!me || me !== this.hostPseudo) {
      this.sendError(ws, "NOT_HOST", "Seul l'hote peut terminer la partie.");
      return;
    }

    // En mode comp : si la partie est EN COURS (pas deja finished apres
    // round_ended de la derniere manche), on cloture proprement avec le
    // classement final avant de revenir au lobby. Si elle est deja "finished",
    // game_ended a deja ete diffuse — on saute pour eviter le re-affichage
    // du podium apres "Retour au salon".
    if (
      this.config.mode === "competitive" &&
      this.compScores.size > 0 &&
      this.phase !== "finished"
    ) {
      const finalResults: RoundResult[] = [];
      for (const [pseudo, total] of this.compScores) {
        finalResults.push({
          playerId: pseudo,
          found: false,
          attemptsUsed: 0,
          finishRank: null,
          roundPoints: 0,
          totalPoints: total,
          pointsBreakdown: "",
        });
      }
      finalResults.sort((a, b) => b.totalPoints - a.totalPoints);
      const gameStats = this.computeGameStats(finalResults);
      this.broadcast({
        type: "game_ended",
        results: finalResults,
        ...(gameStats ? { gameStats } : {}),
      });
    }

    // Cleanup etat comp + alarme
    this.state.storage.deleteAlarm();
    this.compRoundIndex = 0;
    this.compWord = null;
    this.compDeadlineTs = null;
    this.compPlayers = new Map();
    this.compFinishOrder = [];
    this.compScores = new Map();
    this.compRoundStartedAtMs = null;
    this.compRoundHistory = [];

    // Retour au lobby pour une nouvelle partie
    this.phase = "lobby";
    this.targetWord = null;
    this.attempts = [];
    this.wordStatus = "in_progress";
    this.foundBy = null;
    this.broadcastRoomState();
  }

  // =========================================================================
  // Snapshots & broadcast
  // =========================================================================

  private snapshotPlayers(): PlayerInfo[] {
    const result: PlayerInfo[] = [];
    for (const p of this.players.values()) {
      result.push({
        pseudo: p.pseudo,
        isHost: p.isHost,
        totalScore: p.totalScore,
        isConnected: p.ws !== null,
      });
    }
    return result.sort((a, b) => {
      if (a.isHost !== b.isHost) return a.isHost ? -1 : 1;
      return a.pseudo.localeCompare(b.pseudo);
    });
  }

  private snapshotCurrentWord(): WordState | null {
    if (!this.targetWord) return null;
    return {
      firstLetter: this.targetWord[0],
      wordLength: this.targetWord.length,
      attempts: this.attempts,
      maxAttempts: this.config.maxAttempts,
      revealedWord:
        this.wordStatus === "in_progress" ? null : this.targetWord,
      status: this.wordStatus,
      foundBy: this.foundBy,
    };
  }

  private broadcastRoomState(): void {
    this.broadcast({
      type: "room_state",
      players: this.snapshotPlayers(),
      hostPseudo: this.hostPseudo ?? "",
      phase: this.phase,
    });
  }

  private broadcast(msg: ServerMessage): void {
    const raw = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.ws) {
        try {
          p.ws.send(raw);
        } catch {
          /* ignore : sera nettoye au prochain close */
        }
      }
    }
  }

  private broadcastError(code: ErrorCode, message: string): void {
    this.broadcast({ type: "error", code, message });
  }

  private sendMessage(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* ignore */
    }
  }

  private sendError(ws: WebSocket, code: ErrorCode, message: string): void {
    this.sendMessage(ws, { type: "error", code, message });
  }

  // =========================================================================
  // Utilitaires
  // =========================================================================

  private findPlayerByPseudo(pseudo: string): PlayerSession | undefined {
    for (const p of this.players.values()) {
      if (pseudosEqual(p.pseudo, pseudo)) return p;
    }
    return undefined;
  }

  private pseudoOf(ws: WebSocket): string | null {
    return this.wsToPseudo.get(ws) ?? null;
  }

  /**
   * Normalise et valide une MotusConfig.
   *
   * Verifie que le mode envoye correspond bien a celui gele a la creation
   * de la room (`this.initialMode`) — un client ne peut pas faire muter une
   * room coop en comp ou vice versa.
   *
   * En mode competitive, valide aussi tous les sous-parametres :
   *   - endCondition / scoring / format dans leurs enums respectifs
   *   - timerSeconds dans les bornes (obligatoire si endCondition === timer_only)
   *   - maxRounds dans les bornes (utilise si format === fixed_rounds)
   *   - pointsTarget dans les bornes (utilise si format === first_to_points)
   *   - si preset n'est pas "custom", verifie que les valeurs envoyees matchent
   *     bien le preset (defense contre client menteur). Sinon, accepte la
   *     config comme libre.
   */
  private normalizeConfig(
    raw: MotusConfig
  ): { ok: true; config: MotusConfig } | { ok: false; error: string } {
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: "Config absente." };
    }
    const wordLength = Number(raw.wordLength);
    const maxAttempts = Number(raw.maxAttempts);
    const mode = raw.mode;

    // Champs communs
    if (
      !Number.isInteger(wordLength) ||
      wordLength < MOTUS_CONFIG.MIN_WORD_LEN ||
      wordLength > MOTUS_CONFIG.MAX_WORD_LEN
    ) {
      return {
        ok: false,
        error: `Longueur de mot invalide (${MOTUS_CONFIG.MIN_WORD_LEN}-${MOTUS_CONFIG.MAX_WORD_LEN}).`,
      };
    }
    if (
      !Number.isInteger(maxAttempts) ||
      maxAttempts < MOTUS_CONFIG.MIN_ATTEMPTS ||
      maxAttempts > MOTUS_CONFIG.MAX_ATTEMPTS
    ) {
      return {
        ok: false,
        error: `Nombre d'essais invalide (${MOTUS_CONFIG.MIN_ATTEMPTS}-${MOTUS_CONFIG.MAX_ATTEMPTS}).`,
      };
    }

    // Le mode doit correspondre au mode gele de la room
    if (mode !== "coop_stream" && mode !== "competitive") {
      return { ok: false, error: "Mode de jeu inconnu." };
    }
    if (this.initialMode !== null && mode !== this.initialMode) {
      return {
        ok: false,
        error: `Cette room est en mode ${this.initialMode}, impossible de la changer en ${mode}.`,
      };
    }

    if (drawablePoolSize(wordLength) === 0) {
      return {
        ok: false,
        error: `Aucun mot disponible pour cette longueur (${wordLength}).`,
      };
    }

    // Coop : on s'arrete la, les autres champs sont ignores
    if (mode === "coop_stream") {
      return {
        ok: true,
        config: { wordLength, maxAttempts, mode },
      };
    }

    // ====== Validation des champs specifiques au mode competitive ======

    const preset = raw.preset;
    if (
      preset !== "speed" &&
      preset !== "chrono" &&
      preset !== "marathon" &&
      preset !== "custom"
    ) {
      return { ok: false, error: "Preset competitive inconnu." };
    }

    // endCondition. "everyone_done" est retire (un joueur AFK bloquait
    // toute la manche meme avec un timer). On garde "first_finds" et "timer_only".
    const endCondition = raw.endCondition;
    if (
      endCondition !== "first_finds" &&
      endCondition !== "timer_only"
    ) {
      return { ok: false, error: "Condition de fin de manche invalide." };
    }

    // scoring
    const scoring = raw.scoring;
    if (
      scoring !== "position" &&
      scoring !== "binary" &&
      scoring !== "attempts_left" &&
      scoring !== "combo"
    ) {
      return { ok: false, error: "Mode de score invalide." };
    }

    // Coherence endCondition <-> scoring : avec "premier trouve", on ne connait
    // que le gagnant, donc seuls binary et attempts_left ont du sens.
    const allowedScorings: Record<string, string[]> = {
      first_finds: ["binary", "attempts_left"],
      timer_only: ["position", "attempts_left", "combo", "binary"],
    };
    if (!allowedScorings[endCondition].includes(scoring)) {
      return {
        ok: false,
        error: `Le score "${scoring}" n'est pas compatible avec cette condition de fin de manche.`,
      };
    }

    // format
    const format = raw.format;
    if (
      format !== "fixed_rounds" &&
      format !== "unlimited" &&
      format !== "first_to_points"
    ) {
      return { ok: false, error: "Format de partie invalide." };
    }

    // timerSeconds : TOUJOURS obligatoire (un joueur AFK ne doit pas bloquer
    // la manche). On exige un entier dans les bornes.
    const t = Number(raw.timerSeconds);
    if (
      !Number.isInteger(t) ||
      t < COMP_CONFIG.MIN_TIMER_SEC ||
      t > COMP_CONFIG.MAX_TIMER_SEC
    ) {
      return {
        ok: false,
        error: `Timer obligatoire (${COMP_CONFIG.MIN_TIMER_SEC}-${COMP_CONFIG.MAX_TIMER_SEC}s).`,
      };
    }
    const timerSeconds: number = t;

    // maxRounds : pertinent uniquement si format === fixed_rounds
    let maxRounds = 0;
    if (format === "fixed_rounds") {
      const r = Number(raw.maxRounds);
      if (
        !Number.isInteger(r) ||
        r < COMP_CONFIG.MIN_ROUNDS ||
        r > COMP_CONFIG.MAX_ROUNDS
      ) {
        return {
          ok: false,
          error: `Nombre de manches invalide (${COMP_CONFIG.MIN_ROUNDS}-${COMP_CONFIG.MAX_ROUNDS}).`,
        };
      }
      maxRounds = r;
    }

    // pointsTarget : pertinent uniquement si format === first_to_points
    let pointsTarget = 0;
    if (format === "first_to_points") {
      const p = Number(raw.pointsTarget);
      if (
        !Number.isInteger(p) ||
        p < COMP_CONFIG.MIN_POINTS_TARGET ||
        p > COMP_CONFIG.MAX_POINTS_TARGET
      ) {
        return {
          ok: false,
          error: `Seuil de points invalide (${COMP_CONFIG.MIN_POINTS_TARGET}-${COMP_CONFIG.MAX_POINTS_TARGET}).`,
        };
      }
      pointsTarget = p;
    }

    // Si on est sur un preset non-custom, on verifie que les valeurs envoyees
    // correspondent bien au preset officiel. Si elles divergent, on REFUSE
    // (defense : empeche un client de pretendre "preset=speed" mais avec
    // timer=10s, ce qui creerait une confusion d'affichage des autres clients).
    if (preset !== "custom") {
      const expected = COMP_PRESETS[preset];
      if (
        expected.endCondition !== endCondition ||
        expected.scoring !== scoring ||
        expected.format !== format ||
        expected.timerSeconds !== timerSeconds ||
        (format === "fixed_rounds" && expected.maxRounds !== maxRounds)
      ) {
        return {
          ok: false,
          error: `Preset "${preset}" : parametres incoherents avec la definition officielle.`,
        };
      }
    }

    return {
      ok: true,
      config: {
        wordLength,
        maxAttempts,
        mode: "competitive",
        preset,
        endCondition,
        timerSeconds,
        scoring,
        format,
        maxRounds,
        pointsTarget,
      },
    };
  }
}

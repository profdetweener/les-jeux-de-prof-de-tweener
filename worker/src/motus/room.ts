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
  MotusConfig,
  PlayerInfo,
  RoomPhase,
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
  // Mot en cours (in_game ou between_words)
  private targetWord: string | null;
  private attempts: Attempt[];
  private wordStatus: "in_progress" | "found" | "exhausted";
  private foundBy: string | null;

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

    // Nouveau joueur
    const isFirstPlayer = this.players.size === 0;
    const session: PlayerSession = {
      pseudo,
      ws,
      joinedAt: Date.now(),
      totalScore: 0,
      isHost: isFirstPlayer,
    };
    this.players.set(pseudo, session);
    this.wsToPseudo.set(ws, pseudo);

    if (isFirstPlayer) {
      this.hostPseudo = pseudo;
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
    });
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

    // En mode comp, la mecanique de manche arrive en Livraison 2 — on refuse
    // poliment ici. Le lobby et la sync de config sont OK, tout est cable.
    if (this.config.mode === "competitive") {
      this.sendError(
        ws,
        "WRONG_PHASE",
        "Mode competitif : la mecanique de partie arrive bientot."
      );
      return;
    }

    this.startNextWord();
  }

  /**
   * Demarre un nouveau mot. Suppose que this.config est valide.
   */
  private startNextWord(): void {
    const word = pickRandomWord(this.config.wordLength);
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

  // =========================================================================
  // Saisie d'un essai (mode coop : host uniquement)
  // =========================================================================

  private handleSubmitGuess(ws: WebSocket, rawGuess: string): void {
    const me = this.pseudoOf(ws);
    if (!me) return;
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

    // endCondition
    const endCondition = raw.endCondition;
    if (
      endCondition !== "first_finds" &&
      endCondition !== "everyone_done" &&
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
      everyone_done: ["position", "attempts_left", "combo", "binary"],
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

    // timerSeconds : null autorise sauf si endCondition === timer_only
    let timerSeconds: number | null = null;
    if (raw.timerSeconds !== null && raw.timerSeconds !== undefined) {
      const t = Number(raw.timerSeconds);
      if (
        !Number.isInteger(t) ||
        t < COMP_CONFIG.MIN_TIMER_SEC ||
        t > COMP_CONFIG.MAX_TIMER_SEC
      ) {
        return {
          ok: false,
          error: `Timer invalide (${COMP_CONFIG.MIN_TIMER_SEC}-${COMP_CONFIG.MAX_TIMER_SEC}s).`,
        };
      }
      timerSeconds = t;
    }
    if (endCondition === "timer_only" && timerSeconds === null) {
      return { ok: false, error: "Le timer est obligatoire avec 'Fin par timer'." };
    }

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

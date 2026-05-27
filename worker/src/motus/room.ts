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
  ErrorCode,
  GameMode,
  MotusConfig,
  PlayerInfo,
  RoomPhase,
  ServerMessage,
  WordState,
} from "./messages";
import { MOTUS_CONFIG, ROOM_CONFIG } from "./messages";
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

export class MotusRoom {
  private state: DurableObjectState;
  private players: Map<string, PlayerSession>;
  private wsToPseudo: Map<WebSocket, string>;
  private hostPseudo: string | null;
  private initialized: boolean;

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
    this.initialized = false;
    this.phase = "lobby";
    this.config = { ...DEFAULT_CONFIG };
    this.targetWord = null;
    this.attempts = [];
    this.wordStatus = "in_progress";
    this.foundBy = null;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Endpoints internes (utilises par le routeur)
    if (url.pathname === "/__internal/exists") {
      return new Response(JSON.stringify({ exists: this.initialized }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/__internal/init") {
      this.initialized = true;
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Upgrade WebSocket
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    this.initialized = true;

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
    // En Livraison 2 on n'accepte que coop_stream
    if (mode !== "coop_stream") {
      return {
        ok: false,
        error: "Seul le mode coop est disponible pour le moment.",
      };
    }
    if (drawablePoolSize(wordLength) === 0) {
      return {
        ok: false,
        error: `Aucun mot disponible pour cette longueur (${wordLength}).`,
      };
    }
    return {
      ok: true,
      config: { wordLength, maxAttempts, mode: mode as GameMode },
    };
  }
}

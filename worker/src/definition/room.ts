/**
 * DefinitionRoom — Durable Object de la room du jeu "Definitions".
 *
 * Phases :
 *   - lobby     : on attend les joueurs, l'hote configure la partie
 *   - writing   : un mot est affiche, chacun ecrit sa proposition (a l'aveugle).
 *                 Fin sur timer OU quand tous les connectes ont verrouille.
 *   - voting    : la vraie definition + toutes les propositions sont revelees ;
 *                 chacun note les propositions des autres (0..1). Votes visibles.
 *   - scoring   : agregation des votes -> scores de la manche
 *   - finished  : classement final
 *
 * Modele calque sur PetitBacRoom (meme gestion host/reconnexion/persistence).
 */

import type {
  ClientMessage,
  ErrorCode,
  GameConfig,
  PlayerInfo,
  RoomPhase,
  RoundResult,
  ServerMessage,
  VoteMatrix,
} from "./messages";
import { ROOM_CONFIG, DEF_CONFIG } from "./messages";
import { pseudosEqual, validatePseudo } from "../shared/moderation";
import {
  computeRoundScores,
  isValidVoteValue,
  validateGameConfig,
} from "./scoring";
import { drawWord } from "./words";

interface PlayerSession {
  pseudo: string;
  ws: WebSocket | null; // null si deconnecte mais conserve dans la partie
  joinedAt: number;
  totalScore: number;
  hasLocked: boolean; // a verrouille sa definition pour la manche en cours
}

export class DefinitionRoom {
  private state: DurableObjectState;
  private players: Map<string, PlayerSession>;
  private wsToPseudo: Map<WebSocket, string>;
  private hostPseudo: string | null;

  private phase: RoomPhase;
  private config: GameConfig | null;
  private currentRound: number;
  private currentWord: string | null;
  private currentRealDef: string | null;
  private drawnIndices: number[];
  private roundEndsAt: number | null;
  private roundTimerId: ReturnType<typeof setTimeout> | null;
  private definitions: Record<string, string>; // author -> texte
  private votes: VoteMatrix; // voter -> author -> valeur
  private currentResult: RoundResult | null;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.players = new Map();
    this.wsToPseudo = new Map();
    this.hostPseudo = null;
    this.phase = "lobby";
    this.config = null;
    this.currentRound = 0;
    this.currentWord = null;
    this.currentRealDef = null;
    this.drawnIndices = [];
    this.roundEndsAt = null;
    this.roundTimerId = null;
    this.definitions = {};
    this.votes = {};
    this.currentResult = null;

    this.state.blockConcurrencyWhile(async () => {
      try {
        const persistedHost = await this.state.storage.get<string>("hostPseudo");
        if (typeof persistedHost === "string" && persistedHost.length > 0) {
          this.hostPseudo = persistedHost;
        }
      } catch {
        /* tolerant aux echecs storage */
      }
    });
  }

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

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/__internal/exists")) {
      const initialized = await this.state.storage.get<boolean>("initialized");
      return Response.json({ exists: initialized === true });
    }
    if (url.pathname.endsWith("/__internal/init")) {
      await this.state.storage.put("initialized", true);
      return Response.json({ ok: true });
    }

    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    server.addEventListener("message", (event) => {
      this.handleMessage(server, event.data as string);
    });
    server.addEventListener("close", () => this.handleClose(server));
    server.addEventListener("error", () => this.handleClose(server));

    return new Response(null, { status: 101, webSocket: client });
  }

  // ==========================================================================
  // ROUTAGE DES MESSAGES
  // ==========================================================================

  private handleMessage(ws: WebSocket, raw: string): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      this.sendError(ws, "INVALID_MESSAGE", "Message non JSON.");
      return;
    }

    switch (msg.type) {
      case "join":
        this.handleJoin(ws, msg.pseudo);
        break;
      case "kick":
        this.handleKick(ws, msg.targetPseudo);
        break;
      case "ping":
        this.send(ws, { type: "pong" });
        break;
      case "start_game":
        this.handleStartGame(ws, msg.config);
        break;
      case "config_update":
        this.handleConfigUpdate(ws, msg.config);
        break;
      case "submit_definition":
        this.handleSubmitDefinition(ws, msg.text);
        break;
      case "lock_definition":
        this.handleLockDefinition(ws);
        break;
      case "set_vote":
        this.handleSetVote(ws, msg.author, msg.value);
        break;
      case "host_override_vote":
        this.handleHostOverrideVote(ws, msg.voter, msg.author, msg.value);
        break;
      case "next_round":
        this.handleNextRound(ws);
        break;
      case "end_game":
        this.handleEndGame(ws);
        break;
      case "back_to_lobby":
        this.handleBackToLobby(ws);
        break;
      default:
        this.sendError(ws, "INVALID_MESSAGE", "Type de message inconnu.");
    }
  }

  // ==========================================================================
  // LOBBY (join, kick, deconnexion)
  // ==========================================================================

  private handleJoin(ws: WebSocket, rawPseudo: string): void {
    const v = validatePseudo(rawPseudo);
    if (!v.ok) {
      this.sendError(ws, "PSEUDO_INVALID", v.error);
      ws.close();
      return;
    }
    const pseudo = v.normalized;

    // Reconnexion exacte
    const existing = this.players.get(pseudo);
    if (existing) {
      if (existing.ws !== null) {
        this.sendError(ws, "PSEUDO_TAKEN", "Ce pseudo est deja pris.");
        ws.close();
        return;
      }
      existing.ws = ws;
      this.wsToPseudo.set(ws, pseudo);
      this.sendJoinedSnapshot(ws, pseudo);
      if (this.phase === "lobby" && this.config && pseudo !== this.hostPseudo) {
        this.send(ws, { type: "config_update", config: this.config });
      }
      this.broadcastRoomState();
      return;
    }

    // Reconnexion insensible casse/accents sur une session deconnectee
    for (const [existingPseudo, existingSession] of this.players.entries()) {
      if (!pseudosEqual(existingPseudo, pseudo)) continue;
      if (existingSession.ws !== null) {
        this.sendError(ws, "PSEUDO_TAKEN", "Pseudo deja pris (variante).");
        ws.close();
        return;
      }
      existingSession.ws = ws;
      this.wsToPseudo.set(ws, existingPseudo);
      this.sendJoinedSnapshot(ws, existingPseudo);
      if (this.phase === "lobby" && this.config && existingPseudo !== this.hostPseudo) {
        this.send(ws, { type: "config_update", config: this.config });
      }
      this.broadcastRoomState();
      return;
    }

    if (this.players.size >= ROOM_CONFIG.MAX_PLAYERS) {
      this.sendError(ws, "ROOM_FULL", "Room pleine.");
      ws.close();
      return;
    }

    const session: PlayerSession = {
      pseudo,
      ws,
      joinedAt: Date.now(),
      totalScore: 0,
      hasLocked: false,
    };
    this.players.set(pseudo, session);
    this.wsToPseudo.set(ws, pseudo);

    // Decision host (identique a PetitBac)
    const isFirstPlayer = this.players.size === 1;
    let shouldBecomeHost = false;
    if (this.hostPseudo === null && isFirstPlayer) {
      shouldBecomeHost = true;
    } else if (this.hostPseudo !== null && pseudosEqual(pseudo, this.hostPseudo)) {
      shouldBecomeHost = true;
    }
    if (shouldBecomeHost) {
      this.hostPseudo = pseudo;
      void this.persistHostPseudo();
    }

    // Rejoindre en cours de partie : initialiser les structures necessaires
    if (this.phase === "writing") {
      if (this.definitions[pseudo] === undefined) this.definitions[pseudo] = "";
    } else if (
      (this.phase === "voting" || this.phase === "scoring") &&
      this.currentResult
    ) {
      // Le nouveau venu devient un auteur avec une proposition vide (note 0),
      // et peut voter pour les autres. Coherent avec le "rejoindre mid-game"
      // de Petit Bac.
      if (this.definitions[pseudo] === undefined) {
        this.definitions[pseudo] = "";
        this.currentResult.definitions[pseudo] = "";
      }
    }

    this.sendJoinedSnapshot(ws, pseudo);
    if (this.phase === "lobby" && this.config && pseudo !== this.hostPseudo) {
      this.send(ws, { type: "config_update", config: this.config });
    }
    this.broadcastRoomState();
  }

  private handleKick(ws: WebSocket, targetPseudo: string): void {
    const myPseudo = this.wsToPseudo.get(ws);
    if (!myPseudo || myPseudo !== this.hostPseudo) {
      this.sendError(ws, "NOT_HOST", "Seul l'hote peut faire ca.");
      return;
    }
    if (myPseudo === targetPseudo) {
      this.sendError(ws, "CANNOT_KICK_SELF", "Tu ne peux pas t'exclure.");
      return;
    }
    const target = this.players.get(targetPseudo);
    if (!target) {
      this.sendError(ws, "TARGET_NOT_FOUND", "Joueur introuvable.");
      return;
    }
    if (target.ws) {
      this.send(target.ws, { type: "kicked", reason: "Exclu par l'hote." });
      try {
        target.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.removePlayer(targetPseudo);
    this.broadcastRoomState();
  }

  private handleClose(ws: WebSocket): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (!pseudo) return;
    this.wsToPseudo.delete(ws);

    const session = this.players.get(pseudo);
    if (!session) return;

    if (this.phase === "lobby" || this.phase === "finished") {
      this.removePlayer(pseudo);
    } else {
      session.ws = null;
    }

    this.broadcastRoomState();

    if (this.phase === "writing") {
      this.checkAllLocked();
    }
  }

  private removePlayer(pseudo: string): void {
    const session = this.players.get(pseudo);
    if (!session) return;
    if (session.ws) this.wsToPseudo.delete(session.ws);
    this.players.delete(pseudo);

    if (this.hostPseudo === pseudo) {
      const next = [...this.players.values()]
        .filter((p) => p.ws !== null)
        .sort((a, b) => a.joinedAt - b.joinedAt)[0];
      this.hostPseudo = next ? next.pseudo : null;
      void this.persistHostPseudo();
    }

    // Nettoyage d'etat : retire la proposition du joueur et tous les votes
    // qu'il a emis ou recus, pour qu'il disparaisse proprement de la matrice.
    delete this.definitions[pseudo];
    delete this.votes[pseudo];
    for (const voter of Object.keys(this.votes)) {
      delete this.votes[voter][pseudo];
    }
    if (this.currentResult) {
      delete this.currentResult.definitions[pseudo];
      delete this.currentResult.votes[pseudo];
      for (const voter of Object.keys(this.currentResult.votes)) {
        delete this.currentResult.votes[voter][pseudo];
      }
      delete this.currentResult.aggregateByAuthor[pseudo];
      delete this.currentResult.scoreByPlayer[pseudo];
    }

    if (this.phase === "writing") this.checkAllLocked();

    if (this.players.size === 0) this.resetGameState();
  }

  // ==========================================================================
  // DEMARRAGE DE PARTIE
  // ==========================================================================

  private handleConfigUpdate(ws: WebSocket, config: GameConfig): void {
    const myPseudo = this.wsToPseudo.get(ws);
    if (!myPseudo || myPseudo !== this.hostPseudo) return;
    if (this.phase !== "lobby" && this.phase !== "finished") return;
    if (!config || typeof config !== "object") return;
    this.config = config;
    for (const session of this.players.values()) {
      if (!session.ws) continue;
      if (session.pseudo === this.hostPseudo) continue;
      this.send(session.ws, { type: "config_update", config });
    }
  }

  private handleStartGame(ws: WebSocket, config: GameConfig): void {
    const myPseudo = this.wsToPseudo.get(ws);
    if (!myPseudo || myPseudo !== this.hostPseudo) {
      this.sendError(ws, "NOT_HOST", "Seul l'hote peut demarrer la partie.");
      return;
    }
    if (this.phase !== "lobby" && this.phase !== "finished") {
      this.sendError(ws, "WRONG_PHASE", "Une partie est deja en cours.");
      return;
    }
    const validation = validateGameConfig(config);
    if (!validation.ok) {
      this.sendError(ws, "INVALID_CONFIG", validation.error);
      return;
    }
    if (this.connectedPlayers().length < ROOM_CONFIG.MIN_PLAYERS) {
      this.sendError(
        ws,
        "NOT_ENOUGH_PLAYERS",
        `Il faut au moins ${ROOM_CONFIG.MIN_PLAYERS} joueurs connectes.`
      );
      return;
    }
    // En mode chill, on force l'illimite et on ignore le timer (gere ci-dessous)
    if (config.mode === "chill") {
      config = { ...config, totalRounds: 0 };
    }
    this.config = config;
    for (const p of this.players.values()) p.totalScore = 0;
    this.currentRound = 0;
    this.drawnIndices = [];
    this.startNextRound();
  }

  private startNextRound(): void {
    if (!this.config) return;
    this.currentRound += 1;
    const { index, entry } = drawWord(
      this.drawnIndices,
      this.config.minDifficulty ?? 1,
      this.config.maxDifficulty ?? 5
    );
    this.drawnIndices.push(index);
    this.currentWord = entry.word;
    this.currentRealDef = entry.definition;
    this.definitions = {};
    this.votes = {};
    this.currentResult = null;
    for (const p of this.players.values()) {
      p.hasLocked = false;
      // Tous les joueurs presents partent avec une proposition vide
      this.definitions[p.pseudo] = "";
    }
    this.phase = "writing";
    // En mode chill : pas de timer auto. La phase se termine quand tout le monde
    // a verrouille (ou si l'hote force). roundEndsAt = null pour l'indiquer au client.
    if (this.config.mode === "chill") {
      this.roundEndsAt = null;
      if (this.roundTimerId) {
        clearTimeout(this.roundTimerId);
        this.roundTimerId = null;
      }
    } else {
      const durationMs = this.config.timerSeconds * 1000;
      this.roundEndsAt = Date.now() + durationMs;
      if (this.roundTimerId) clearTimeout(this.roundTimerId);
      this.roundTimerId = setTimeout(() => {
        if (this.phase === "writing") this.endRound("timer");
      }, durationMs);
    }

    this.broadcast({
      type: "round_started",
      roundNumber: this.currentRound,
      totalRounds: this.config.totalRounds,
      word: this.currentWord,
      timerSeconds: this.config.timerSeconds,
      roundEndsAt: this.roundEndsAt,
    });
    this.broadcastRoomState();
  }

  // ==========================================================================
  // PHASE WRITING — saisie de la proposition
  // ==========================================================================

  private handleSubmitDefinition(ws: WebSocket, text: string): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (!pseudo) return;
    if (this.phase !== "writing") return;
    const player = this.players.get(pseudo);
    if (!player) return;
    // Sauvegarde continue : tant qu'on n'a pas verrouille, on peut reecrire.
    if (player.hasLocked) return;
    const cleaned =
      typeof text === "string" ? text.slice(0, DEF_CONFIG.MAX_DEFINITION_LEN) : "";
    this.definitions[pseudo] = cleaned;
  }

  private handleLockDefinition(ws: WebSocket): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (!pseudo) return;
    if (this.phase !== "writing") {
      this.sendError(ws, "WRONG_PHASE", "Pas de manche d'ecriture en cours.");
      return;
    }
    const player = this.players.get(pseudo);
    if (!player) return;
    player.hasLocked = true;
    this.broadcast({ type: "definition_locked", pseudo });
    this.checkAllLocked();
  }

  private checkAllLocked(): void {
    if (this.phase !== "writing") return;
    const connected = this.connectedPlayers();
    if (connected.length === 0) return;
    if (connected.every((p) => p.hasLocked)) {
      this.endRound("all_locked");
    }
  }

  // ==========================================================================
  // FIN DE MANCHE -> phase VOTING (revelation)
  // ==========================================================================

  private endRound(reason: "timer" | "all_locked"): void {
    if (!this.config || this.currentWord === null || this.currentRealDef === null) {
      return;
    }
    if (this.roundTimerId) {
      clearTimeout(this.roundTimerId);
      this.roundTimerId = null;
    }
    // S'assure que chaque joueur present a une entree (proposition vide sinon)
    for (const p of this.players.values()) {
      if (this.definitions[p.pseudo] === undefined) this.definitions[p.pseudo] = "";
    }

    const result: RoundResult = {
      roundNumber: this.currentRound,
      word: this.currentWord,
      realDefinition: this.currentRealDef,
      definitions: this.definitions,
      votes: {},
      aggregateByAuthor: {},
      scoreByPlayer: {},
    };
    this.votes = {};
    this.currentResult = result;
    this.phase = "voting";
    this.roundEndsAt = null;

    this.broadcast({
      type: "round_ended",
      reason,
      word: this.currentWord,
      realDefinition: this.currentRealDef,
      totalRounds: this.config.totalRounds,
      result,
    });
    this.broadcastRoomState();
  }

  // ==========================================================================
  // PHASE VOTING — notation des propositions
  // ==========================================================================

  private handleSetVote(ws: WebSocket, author: string, value: number): void {
    const voter = this.wsToPseudo.get(ws);
    if (!voter) return;
    if (this.phase !== "voting") {
      this.sendError(ws, "WRONG_PHASE", "Pas de phase de vote en cours.");
      return;
    }
    if (author === voter) {
      this.sendError(ws, "INVALID_VOTE", "On ne vote pas pour soi-meme.");
      return;
    }
    if (this.definitions[author] === undefined) {
      this.sendError(ws, "TARGET_NOT_FOUND", "Auteur inconnu.");
      return;
    }
    if (!isValidVoteValue(value)) {
      this.sendError(ws, "INVALID_VOTE", "Valeur de vote invalide.");
      return;
    }
    if (!this.votes[voter]) this.votes[voter] = {};
    this.votes[voter][author] = value;
    if (this.currentResult) this.currentResult.votes = this.votes;
    this.broadcast({ type: "vote_update", votes: this.votes });
  }

  /**
   * Override d'un vote par l'hote. Sert essentiellement aux parties a 3
   * joueurs face a un saboteur : la methode MAD anti-saboteur ne s'active
   * qu'a partir de 4 votes (cf. scoring.ts), donc en-dessous l'hote a la
   * possibilite de corriger un vote aberrant avant la fin de la phase de
   * vote. Le vote corrige est diffuse comme un vote normal.
   *
   * Regles :
   *   - Phase 'voting' uniquement (avant que next_round ne declenche le scoring).
   *   - Seul l'hote peut emettre.
   *   - On n'override pas un auto-vote (qui n'existe pas).
   *   - On peut override meme un vote inexistant : ca cree l'entree.
   */
  private handleHostOverrideVote(
    ws: WebSocket,
    voter: string,
    author: string,
    value: number
  ): void {
    const senderPseudo = this.wsToPseudo.get(ws);
    if (!senderPseudo || senderPseudo !== this.hostPseudo) {
      this.sendError(ws, "NOT_HOST", "Seul l'hote peut corriger un vote.");
      return;
    }
    if (this.phase !== "voting") {
      this.sendError(ws, "WRONG_PHASE", "Pas de phase de vote en cours.");
      return;
    }
    if (voter === author) {
      this.sendError(ws, "INVALID_VOTE", "On ne note pas une auto-proposition.");
      return;
    }
    if (this.definitions[author] === undefined) {
      this.sendError(ws, "TARGET_NOT_FOUND", "Auteur inconnu.");
      return;
    }
    if (this.definitions[voter] === undefined) {
      // Le voter doit etre un joueur reel de la manche
      this.sendError(ws, "TARGET_NOT_FOUND", "Votant inconnu.");
      return;
    }
    if (!isValidVoteValue(value)) {
      this.sendError(ws, "INVALID_VOTE", "Valeur de vote invalide.");
      return;
    }
    if (!this.votes[voter]) this.votes[voter] = {};
    this.votes[voter][author] = value;
    if (this.currentResult) this.currentResult.votes = this.votes;
    this.broadcast({ type: "vote_update", votes: this.votes });
  }

  // ==========================================================================
  // SCORING & MANCHE SUIVANTE
  // ==========================================================================

  private handleNextRound(ws: WebSocket): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (!pseudo || pseudo !== this.hostPseudo) {
      this.sendError(ws, "NOT_HOST", "Seul l'hote peut passer a la suite.");
      return;
    }
    if (!this.config) return;

    // Mode chill : l'hote peut forcer la fin de la phase d'ecriture (il n'y
    // a pas de timer auto et tous les joueurs n'ont pas necessairement valide).
    if (this.phase === "writing" && this.config.mode === "chill") {
      this.endRound("all_locked");
      return;
    }

    if (this.phase !== "voting" && this.phase !== "scoring") {
      this.sendError(ws, "WRONG_PHASE", "Pas la bonne phase pour cela.");
      return;
    }

    if (this.phase === "voting") {
      const authors = Object.keys(this.definitions);
      const { aggregateByAuthor, scoreByPlayer } = computeRoundScores(
        authors,
        this.votes,
        this.config
      );
      if (!this.currentResult) return;
      this.currentResult.aggregateByAuthor = aggregateByAuthor;
      this.currentResult.scoreByPlayer = scoreByPlayer;

      for (const [p, score] of Object.entries(scoreByPlayer)) {
        const session = this.players.get(p);
        if (session) {
          // Arrondi a 1 decimale pour eviter les derives flottantes
          // (7.7 + 0.1 != 7.8 en arithmetique IEEE754).
          session.totalScore = Math.round((session.totalScore + score) * 10) / 10;
        }
      }
      this.phase = "scoring";
      this.broadcast({
        type: "round_scored",
        totalRounds: this.config.totalRounds,
        result: this.currentResult,
        players: this.snapshotPlayers(),
      });
      this.broadcastRoomState();
      return;
    }

    // phase === "scoring"
    const isLastRound =
      this.config.totalRounds > 0 && this.currentRound >= this.config.totalRounds;
    if (isLastRound) {
      this.finishGame();
    } else {
      this.startNextRound();
    }
  }

  private finishGame(): void {
    this.phase = "finished";
    this.currentWord = null;
    this.currentRealDef = null;
    this.roundEndsAt = null;
    const ranking = this.snapshotPlayers().sort(
      (a, b) => b.totalScore - a.totalScore
    );
    this.broadcast({ type: "game_finished", ranking });
    this.broadcastRoomState();
  }

  private handleEndGame(ws: WebSocket): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (!pseudo || pseudo !== this.hostPseudo) {
      this.sendError(ws, "NOT_HOST", "Seul l'hote peut terminer la partie.");
      return;
    }
    if (
      this.phase !== "writing" &&
      this.phase !== "voting" &&
      this.phase !== "scoring"
    ) {
      this.sendError(ws, "WRONG_PHASE", "Pas de partie en cours a terminer.");
      return;
    }
    if (this.roundTimerId) {
      clearTimeout(this.roundTimerId);
      this.roundTimerId = null;
    }
    this.finishGame();
  }

  private handleBackToLobby(ws: WebSocket): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (!pseudo || pseudo !== this.hostPseudo) {
      this.sendError(ws, "NOT_HOST", "Seul l'hote peut faire ca.");
      return;
    }
    if (this.phase !== "finished" && this.phase !== "scoring") {
      this.sendError(ws, "WRONG_PHASE", "Tu ne peux pas revenir au lobby maintenant.");
      return;
    }
    this.resetGameState();
    this.broadcastRoomState();
  }

  private resetGameState(): void {
    if (this.roundTimerId) {
      clearTimeout(this.roundTimerId);
      this.roundTimerId = null;
    }
    this.phase = "lobby";
    this.config = null;
    this.currentRound = 0;
    this.currentWord = null;
    this.currentRealDef = null;
    this.drawnIndices = [];
    this.roundEndsAt = null;
    this.definitions = {};
    this.votes = {};
    this.currentResult = null;
    for (const p of this.players.values()) {
      p.totalScore = 0;
      p.hasLocked = false;
    }
  }

  // ==========================================================================
  // BROADCAST & UTILS
  // ==========================================================================

  private snapshotPlayers(): PlayerInfo[] {
    return [...this.players.values()].map((p) => ({
      pseudo: p.pseudo,
      isHost: p.pseudo === this.hostPseudo,
      totalScore: p.totalScore,
      isConnected: p.ws !== null,
    }));
  }

  private connectedPlayers(): PlayerSession[] {
    return [...this.players.values()].filter((p) => p.ws !== null);
  }

  private sendJoinedSnapshot(ws: WebSocket, pseudo: string): void {
    const isHost = pseudo === this.hostPseudo;
    const finalRanking =
      this.phase === "finished"
        ? this.snapshotPlayers().sort((a, b) => b.totalScore - a.totalScore)
        : null;
    // On ne reveille la proposition propre du joueur que pendant writing
    // (les autres restent confidentielles jusqu'au reveal).
    const myDefinition =
      this.phase === "writing" ? this.definitions[pseudo] ?? null : null;
    this.send(ws, {
      type: "joined",
      pseudo,
      isHost,
      players: this.snapshotPlayers(),
      hostPseudo: this.hostPseudo ?? "",
      roomCode: "",
      phase: this.phase,
      config: this.config,
      currentRound: this.currentRound,
      word: this.phase === "writing" ? this.currentWord : this.currentWord,
      roundEndsAt: this.roundEndsAt,
      currentResult: this.currentResult,
      finalRanking,
      myDefinition,
    });
  }

  private broadcastRoomState(): void {
    this.broadcast({
      type: "room_state",
      players: this.snapshotPlayers(),
      hostPseudo: this.hostPseudo ?? "",
      phase: this.phase,
    });
  }

  private broadcast(message: ServerMessage, except?: WebSocket): void {
    for (const session of this.players.values()) {
      if (!session.ws) continue;
      if (session.ws === except) continue;
      this.send(session.ws, message);
    }
  }

  private send(ws: WebSocket, data: ServerMessage): void {
    try {
      ws.send(JSON.stringify(data));
    } catch {
      const pseudo = this.wsToPseudo.get(ws);
      if (pseudo) {
        const session = this.players.get(pseudo);
        if (session) session.ws = null;
        this.wsToPseudo.delete(ws);
      }
    }
  }

  private sendError(ws: WebSocket, code: ErrorCode, message: string): void {
    this.send(ws, { type: "error", code, message });
  }
}

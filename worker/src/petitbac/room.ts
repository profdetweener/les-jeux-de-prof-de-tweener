/**
 * PetitBacRoom — Durable Object de la room (phase 4).
 *
 * Etats :
 *   - lobby       : on attend les joueurs, host configure la partie
 *   - in_round    : manche en cours, chacun remplit, fin sur STOP/timer/all_submitted
 *   - validating  : grille affichee, votes en parallele, host clique "Valider"
 *   - scoring     : scores affiches, host clique "manche suivante" ou "fin"
 *   - finished    : classement final
 *
 * L'etat est en memoire dans le DO ; seul un flag `initialized` est persiste
 * pour detecter si la room a deja ete creee (anti-collision de codes).
 */

import type {
  ClientMessage,
  ErrorCode,
  GameConfig,
  PlayerInfo,
  RoomPhase,
  RoundResult,
  ServerMessage,
  VoteValue,
} from "./messages";
import { ROOM_CONFIG, ROUND_CONFIG } from "./messages";
import { pseudosEqual, validatePseudo } from "../shared/moderation";
import {
  answerMatchesLength,
  answerMatchesLetter,
  computeRoundScores,
  drawLetter,
  normalizeAnswer,
  validateGameConfig,
} from "./scoring";

interface PlayerSession {
  pseudo: string;
  ws: WebSocket | null; // null si deconnecte mais conserve dans la partie
  joinedAt: number;
  totalScore: number;
  hasSubmitted: boolean; // pour la manche en cours
}

export class PetitBacRoom {
  private state: DurableObjectState;
  // Cle = pseudo (pas WebSocket) pour permettre la reconnexion en gardant le score
  private players: Map<string, PlayerSession>;
  // Index inverse : ws -> pseudo (pour cleanup rapide)
  private wsToPseudo: Map<WebSocket, string>;
  private hostPseudo: string | null;

  // Etat de la partie
  private phase: RoomPhase;
  private config: GameConfig | null;
  private currentRound: number;
  private letter: string | null;
  private drawnLetters: string[];
  private roundEndsAt: number | null; // timestamp epoch ms
  private roundTimerId: ReturnType<typeof setTimeout> | null;
  private answers: Record<string, Record<string, string>>; // pseudo -> cat -> answer
  private cellStates: Record<string, Record<string, VoteValue>>; // pseudo -> cat -> etat partage
  private currentResult: RoundResult | null;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.players = new Map();
    this.wsToPseudo = new Map();
    this.hostPseudo = null;
    this.phase = "lobby";
    this.config = null;
    this.currentRound = 0;
    this.letter = null;
    this.drawnLetters = [];
    this.roundEndsAt = null;
    this.roundTimerId = null;
    this.answers = {};
    this.cellStates = {};
    this.currentResult = null;
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

    // Upgrade WebSocket
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
    server.addEventListener("close", () => {
      this.handleClose(server);
    });
    server.addEventListener("error", () => {
      this.handleClose(server);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  // ==========================================================================
  // ROUTAGE DES MESSAGES CLIENT
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
      case "submit_answers":
        this.handleSubmitAnswers(ws, msg.answers);
        break;
      case "stop_round":
        this.handleStopRound(ws);
        break;
      case "set_cell_state":
        this.handleSetCellState(ws, msg.targetPseudo, msg.category, msg.state);
        break;
      case "set_cheater_cheats":
        this.handleSetCheaterCheats(ws, msg.count);
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
  // PHASE 3 — LOBBY (join, kick, deconnexion)
  // ==========================================================================

  private handleJoin(ws: WebSocket, rawPseudo: string): void {
    const v = validatePseudo(rawPseudo);
    if (!v.ok) {
      this.sendError(ws, "PSEUDO_INVALID", v.error);
      ws.close();
      return;
    }
    const pseudo = v.normalized;

    // Cas reconnexion : meme pseudo + memes lettres normalisees
    const existing = this.players.get(pseudo);
    if (existing) {
      if (existing.ws !== null) {
        // Le pseudo est utilise par une socket OUVERTE
        this.sendError(ws, "PSEUDO_TAKEN", "Ce pseudo est deja pris.");
        ws.close();
        return;
      }
      // Reconnexion : on lui rebranche la nouvelle ws
      existing.ws = ws;
      this.wsToPseudo.set(ws, pseudo);
      this.sendJoinedSnapshot(ws, pseudo);
      if (this.phase === "lobby" && this.config && pseudo !== this.hostPseudo) {
        this.send(ws, { type: "config_update", config: this.config });
      }
      this.broadcastRoomState();
      return;
    }

    // Pas de match strict : on cherche un pseudo equivalent (casse / accents).
    // Si on en trouve un dont la session est DECONNECTEE, c'est une reconnexion :
    // l'utilisateur a peut-etre retape son pseudo en "max" au lieu de "Max", ou
    // sans son accent. On le reconnecte sur sa session existante.
    // S'il existe mais est encore CONNECTE, c'est un conflit, on refuse.
    for (const [existingPseudo, existingSession] of this.players.entries()) {
      if (!pseudosEqual(existingPseudo, pseudo)) continue;
      if (existingSession.ws !== null) {
        this.sendError(ws, "PSEUDO_TAKEN", "Pseudo deja pris (variante).");
        ws.close();
        return;
      }
      // Reconnexion case-insensitive : on garde le pseudo original
      existingSession.ws = ws;
      this.wsToPseudo.set(ws, existingPseudo);
      this.sendJoinedSnapshot(ws, existingPseudo);
      if (
        this.phase === "lobby" &&
        this.config &&
        existingPseudo !== this.hostPseudo
      ) {
        this.send(ws, { type: "config_update", config: this.config });
      }
      this.broadcastRoomState();
      return;
    }

    // Permet de rejoindre meme en cours de partie (in_round, validating, scoring).
    // Le nouveau joueur est ajoute avec un score de 0, et selon la phase :
    //   - in_round    : il rejoint la manche en cours avec le temps restant
    //   - validating  : il voit le tableau de votes mais n'a pas de reponses (toutes vides)
    //   - scoring     : il voit les scores, attendra la prochaine manche pour participer
    //   - finished    : il voit le classement final
    // Le seul refus est si la room est pleine.

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
      hasSubmitted: false,
    };
    this.players.set(pseudo, session);
    this.wsToPseudo.set(ws, pseudo);

    // Premier connecte = host
    if (this.hostPseudo === null) {
      this.hostPseudo = pseudo;
    }

    // Si on rejoint en cours de partie, initialiser ses structures de donnees
    // pour les phases ou c'est necessaire
    if (this.phase === "in_round" && this.config) {
      // Grille vide pour la manche en cours (sera ecrasee par les submit_answers)
      const empty: Record<string, string> = {};
      for (const cat of this.config.categories) empty[cat] = "";
      this.answers[pseudo] = empty;
    } else if (
      (this.phase === "validating" || this.phase === "scoring") &&
      this.config &&
      this.currentResult
    ) {
      // Ajouter le joueur dans les structures de la manche en cours avec une grille vide
      const empty: Record<string, string> = {};
      for (const cat of this.config.categories) empty[cat] = "";
      if (!this.answers[pseudo]) {
        this.answers[pseudo] = empty;
        this.currentResult.answers[pseudo] = empty;
      }
      if (!this.cellStates[pseudo]) {
        this.cellStates[pseudo] = {};
        // Toutes les cellules vides sont par defaut "reject"
        for (const cat of this.config.categories) {
          this.cellStates[pseudo][cat] = "reject";
        }
        this.currentResult.cellStates[pseudo] = this.cellStates[pseudo];
      }
      // Le score cellulaire est 0 partout
      if (!this.currentResult.cellScores[pseudo]) {
        this.currentResult.cellScores[pseudo] = {};
        for (const cat of this.config.categories) {
          this.currentResult.cellScores[pseudo][cat] = 0;
        }
      }
      if (this.currentResult.scoreByPlayer[pseudo] === undefined) {
        this.currentResult.scoreByPlayer[pseudo] = 0;
      }
    }

    this.sendJoinedSnapshot(ws, pseudo);

    // Si on est en lobby et qu'une config a deja ete editee par l'hote,
    // pousser cette config au nouveau venu pour qu'il la voie en lecture seule.
    // (Le snapshot joined contient deja msg.config, mais on envoie aussi un
    // config_update explicite pour declencher le rendu cote client de maniere
    // identique au flux normal d'edition live.)
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

    // En lobby ou partie finie : on retire completement le joueur
    if (this.phase === "lobby" || this.phase === "finished") {
      this.removePlayer(pseudo);
    } else {
      // En partie : on conserve le joueur (avec son score) mais on marque "deconnecte"
      session.ws = null;
    }

    this.broadcastRoomState();

    // Si en pleine manche et tous les connectes ont soumis -> fin de manche
    if (this.phase === "in_round") {
      this.checkAllSubmitted();
    }
  }

  private removePlayer(pseudo: string): void {
    const session = this.players.get(pseudo);
    if (!session) return;
    if (session.ws) {
      this.wsToPseudo.delete(session.ws);
    }
    this.players.delete(pseudo);

    // Migration de host si besoin (FIFO sur les connectes restants)
    if (this.hostPseudo === pseudo) {
      const next = [...this.players.values()]
        .filter((p) => p.ws !== null)
        .sort((a, b) => a.joinedAt - b.joinedAt)[0];
      this.hostPseudo = next ? next.pseudo : null;
    }

    // Si plus personne, on reset l'etat de partie
    if (this.players.size === 0) {
      this.resetGameState();
    }
  }

  // ==========================================================================
  // PHASE 4 — DEMARRAGE DE PARTIE
  // ==========================================================================

  /**
   * Diffusion live de la config en cours d'edition par le host (lobby uniquement).
   * Les autres joueurs voient la config evoluer en temps reel mais ne peuvent pas la modifier.
   */
  private handleConfigUpdate(ws: WebSocket, config: GameConfig): void {
    const myPseudo = this.wsToPseudo.get(ws);
    if (!myPseudo || myPseudo !== this.hostPseudo) {
      // Silencieux : pas une vraie erreur, juste un client mal synchronise
      return;
    }
    if (this.phase !== "lobby" && this.phase !== "finished") {
      return;
    }
    // On ne valide pas strictement ici (la config est en cours d'edition)
    // mais on s'assure que c'est bien un objet correctement forme.
    if (!config || typeof config !== "object") return;
    // Stocke la config courante pour qu'un nouveau joueur puisse la voir au join
    this.config = config;
    // Diffuse aux autres (sans renvoyer au host)
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
    this.config = config;
    // Reset des scores cumules pour une nouvelle partie
    for (const p of this.players.values()) {
      p.totalScore = 0;
    }
    this.currentRound = 0;
    this.drawnLetters = [];
    this.startNextRound();
  }

  private startNextRound(): void {
    if (!this.config) return;
    this.currentRound += 1;
    // Pool de lettres : depuis la config si fourni et non vide, sinon defaut serveur
    const rawPool = this.config.letterPool ?? "";
    const cleanedPool = rawPool.toUpperCase().replace(/[^A-Z]/g, "");
    // Dedup en preservant l'ordre
    const seen = new Set<string>();
    let dedupPool = "";
    for (const ch of cleanedPool) {
      if (!seen.has(ch)) {
        seen.add(ch);
        dedupPool += ch;
      }
    }
    const pool = dedupPool.length > 0 ? dedupPool : ROUND_CONFIG.LETTERS;
    this.letter = drawLetter(pool, this.drawnLetters);
    this.drawnLetters.push(this.letter);
    this.answers = {};
    this.cellStates = {};
    this.currentResult = null;
    for (const p of this.players.values()) {
      p.hasSubmitted = false;
    }
    this.phase = "in_round";
    const durationMs = this.config.timerSeconds * 1000;
    this.roundEndsAt = Date.now() + durationMs;

    // Timer serveur autoritatif
    if (this.roundTimerId) clearTimeout(this.roundTimerId);
    this.roundTimerId = setTimeout(() => {
      if (this.phase === "in_round") {
        this.endRound("timer", null);
      }
    }, durationMs);

    const msg: ServerMessage = {
      type: "round_started",
      roundNumber: this.currentRound,
      totalRounds: this.config.totalRounds,
      letter: this.letter,
      categories: this.config.categories,
      timerSeconds: this.config.timerSeconds,
      roundEndsAt: this.roundEndsAt,
    };
    this.broadcast(msg);
    this.broadcastRoomState();
  }

  // ==========================================================================
  // PHASE 4 — SAISIE DES REPONSES
  // ==========================================================================

  private handleSubmitAnswers(
    ws: WebSocket,
    answers: Record<string, string>
  ): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (!pseudo) return;
    if (this.phase !== "in_round") {
      // Pas d'erreur loggue : peut etre un submit en retard juste apres endRound
      return;
    }
    const player = this.players.get(pseudo);
    if (!player) return;

    // Sanitisation : on ne garde que les categories prevues, tronque les reponses
    const cleaned: Record<string, string> = {};
    if (this.config) {
      for (const cat of this.config.categories) {
        const raw = answers?.[cat];
        if (typeof raw === "string") {
          cleaned[cat] = raw.slice(0, ROUND_CONFIG.MAX_ANSWER_LEN);
        } else {
          cleaned[cat] = "";
        }
      }
    }
    // On accepte les submits multiples : le dernier ecrase les precedents.
    // Cela permet au frontend d'envoyer les reponses en continu (debounced) :
    // si la manche se termine par timer, on a quand meme les dernieres saisies.
    this.answers[pseudo] = cleaned;

    // hasSubmitted = true uniquement si c'est un submit "final" (declenche par STOP).
    // Pour les submits "sauvegarde" (envoyes en continu), le client ne marque pas
    // l'utilisateur comme ayant fini. On distingue via un drapeau optionnel.
    // Pour rester simple et retrocompatible, on garde hasSubmitted lie a STOP uniquement,
    // et le checkAllSubmitted ne se declenche que via stop_round.
  }

  private handleStopRound(ws: WebSocket): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (!pseudo) return;
    if (this.phase !== "in_round") {
      this.sendError(ws, "WRONG_PHASE", "Pas de manche en cours.");
      return;
    }
    const player = this.players.get(pseudo);
    if (!player) return;

    // Defense en profondeur : refuser le STOP si la partie est en mode "timer_only".
    // Le frontend ne devrait meme pas afficher le bouton, mais on bloque ici aussi.
    if (!this.config) return;
    if (this.config.endMode === "timer_only") {
      this.sendError(
        ws,
        "WRONG_PHASE",
        "Le mode de partie n'autorise pas le STOP : il faut attendre le timer."
      );
      return;
    }

    // Defense en profondeur : un joueur ne peut stopper que s'il a rempli toutes les cases
    // ET que toutes ses reponses commencent par la bonne lettre.
    // Le frontend devrait deja l'empecher mais on verifie ici aussi.
    const myAnswers = this.answers[pseudo] ?? {};
    const incompleteCells = this.config.categories.filter(
      (cat) => !myAnswers[cat] || myAnswers[cat].trim().length === 0
    );
    if (incompleteCells.length > 0) {
      this.sendError(
        ws,
        "INVALID_MESSAGE",
        `Remplis toutes les cases avant de cliquer STOP (${incompleteCells.length} manquantes).`
      );
      return;
    }
    const currentLetter = this.letter ?? "";
    const badLetterCells = this.config.categories.filter(
      (cat) => !answerMatchesLetter(myAnswers[cat] ?? "", currentLetter)
    );
    if (badLetterCells.length > 0) {
      this.sendError(
        ws,
        "INVALID_MESSAGE",
        `Toutes tes reponses doivent commencer par ${currentLetter} (${badLetterCells.length} incorrectes).`
      );
      return;
    }
    // Defense en profondeur : si une contrainte de longueur est definie,
    // toutes les reponses doivent la respecter. On traite la violation
    // exactement comme une mauvaise lettre (refus du STOP).
    const lengthConstraint = this.config.lengthConstraint;
    if (lengthConstraint && lengthConstraint.mode !== "none") {
      const badLengthCells = this.config.categories.filter(
        (cat) => !answerMatchesLength(myAnswers[cat] ?? "", lengthConstraint)
      );
      if (badLengthCells.length > 0) {
        const ruleText =
          lengthConstraint.mode === "min"
            ? `au moins ${lengthConstraint.value} lettres`
            : `au plus ${lengthConstraint.value} lettres`;
        this.sendError(
          ws,
          "INVALID_MESSAGE",
          `Toutes tes reponses doivent faire ${ruleText} (${badLengthCells.length} hors limite).`
        );
        return;
      }
    }

    // Marquer ce joueur comme ayant fini (pour checkAllSubmitted plus tard si besoin)
    player.hasSubmitted = true;
    this.broadcast({ type: "answers_received", pseudo });

    // Le STOP ferme la manche pour TOUT LE MONDE (regle classique du Petit Bac)
    this.endRound("stop", pseudo);
  }

  private checkAllSubmitted(): void {
    if (this.phase !== "in_round") return;
    const connected = this.connectedPlayers();
    if (connected.length === 0) return;
    if (connected.every((p) => p.hasSubmitted)) {
      this.endRound("all_submitted", null);
    }
  }

  // ==========================================================================
  // PHASE 4 — FIN DE MANCHE & VALIDATION
  // ==========================================================================

  private endRound(
    reason: "timer" | "stop" | "all_submitted",
    stoppedBy: string | null
  ): void {
    if (!this.config || !this.letter) return;
    if (this.roundTimerId) {
      clearTimeout(this.roundTimerId);
      this.roundTimerId = null;
    }
    // Pour les joueurs qui n'ont pas soumis : on enregistre une grille vide
    for (const p of this.players.values()) {
      if (!this.answers[p.pseudo]) {
        const empty: Record<string, string> = {};
        for (const cat of this.config.categories) empty[cat] = "";
        this.answers[p.pseudo] = empty;
      }
    }

    // Initialise les etats de cellule : "unique" pour les cellules syntaxiquement
    // valides (reponse non vide, qui commence par la lettre, ET respectant la
    // contrainte de longueur si definie), "reject" pour les autres.
    // Modele collaboratif : un seul etat par cellule, modifiable par tout le monde.
    // Note : meme si un joueur vote ensuite "unique" sur une cellule pre-rejetee
    // syntaxiquement, le scoring final la forcera quand meme a "reject"
    // (cf. computeRoundScores).
    this.cellStates = {};
    const lengthConstraint = this.config.lengthConstraint;
    const allPseudos = Object.keys(this.answers);
    for (const targetPseudo of allPseudos) {
      this.cellStates[targetPseudo] = {};
      for (const cat of this.config.categories) {
        const raw = this.answers[targetPseudo][cat] ?? "";
        const goodLetter = answerMatchesLetter(raw, this.letter);
        const goodLength = answerMatchesLength(raw, lengthConstraint);
        if (goodLetter && goodLength) {
          this.cellStates[targetPseudo][cat] = "unique";
        } else {
          this.cellStates[targetPseudo][cat] = "reject";
        }
      }
    }

    // Construit un resultat preliminaire (sans scores encore — calcules au passage scoring)
    const result: RoundResult = {
      roundNumber: this.currentRound,
      letter: this.letter,
      answers: this.answers,
      cellStates: this.cellStates,
      cellScores: {},
      scoreByPlayer: {},
      stoppedBy,
      cheaterCheats: 0,
      cheaterPenalty: 0,
    };
    this.currentResult = result;
    this.phase = "validating";
    this.roundEndsAt = null;

    this.broadcast({
      type: "round_ended",
      reason,
      stoppedBy,
      categories: this.config.categories,
      totalRounds: this.config.totalRounds,
      result,
    });
    this.broadcastRoomState();
  }

  private handleSetCellState(
    ws: WebSocket,
    targetPseudo: string,
    category: string,
    state: VoteValue
  ): void {
    const editor = this.wsToPseudo.get(ws);
    if (!editor) return;
    if (this.phase !== "validating") {
      this.sendError(ws, "WRONG_PHASE", "Pas de phase de validation en cours.");
      return;
    }
    if (!this.config || !this.config.categories.includes(category)) {
      this.sendError(ws, "INVALID_MESSAGE", "Categorie inconnue.");
      return;
    }
    if (!this.cellStates[targetPseudo]) {
      this.sendError(ws, "TARGET_NOT_FOUND", "Joueur cible inconnu.");
      return;
    }
    if (state !== "unique" && state !== "duplicate" && state !== "reject") {
      this.sendError(ws, "INVALID_MESSAGE", "Etat invalide.");
      return;
    }
    // Modele collaboratif : n'importe qui peut modifier n'importe quelle cellule.
    // (Y compris la sienne propre — c'est assume.)
    // Garde-fou : si la reponse n'est pas valide syntaxiquement (vide / mauvaise lettre),
    // on force "reject" peu importe ce qui est demande.
    const raw = this.answers[targetPseudo]?.[category] ?? "";
    if (!answerMatchesLetter(raw, this.letter ?? "")) {
      this.cellStates[targetPseudo][category] = "reject";
    } else {
      this.cellStates[targetPseudo][category] = state;
    }
    // Synchronise aussi currentResult.cellStates pour que les nouveaux arrivants voient l'etat a jour
    if (this.currentResult) {
      this.currentResult.cellStates = this.cellStates;
    }
    this.broadcast({ type: "cell_state_update", cellStates: this.cellStates });
  }

  /**
   * Modifie collaborativement le nombre de "categories tricheuses" pour le stoppeur
   * de la manche. N'importe qui peut le faire pendant la phase validating.
   * Le serveur clamp entre 0 et le nombre de categories, et ignore silencieusement
   * si la manche ne s'est pas terminee par STOP (pas de stoppeur a penaliser).
   */
  private handleSetCheaterCheats(ws: WebSocket, count: number): void {
    if (this.phase !== "validating") {
      this.sendError(ws, "WRONG_PHASE", "Pas de phase de validation en cours.");
      return;
    }
    if (!this.config || !this.currentResult) return;
    // Pas de stoppeur => l'UI ne devrait pas etre affichee cote client, mais on
    // ignore silencieusement par defense en profondeur.
    if (!this.currentResult.stoppedBy) return;
    // Malus desactive cote config => meme chose, on ignore.
    const penaltyPerCheat = this.config.scoring.cheaterPenaltyPerCheat ?? 0;
    if (penaltyPerCheat === 0) return;

    if (typeof count !== "number" || !Number.isFinite(count)) {
      this.sendError(ws, "INVALID_MESSAGE", "Compteur invalide.");
      return;
    }
    // Clamp entre 0 et le nombre de categories de la manche
    const maxCount = this.config.categories.length;
    const clamped = Math.max(0, Math.min(maxCount, Math.floor(count)));
    this.currentResult.cheaterCheats = clamped;
    this.broadcast({ type: "cheater_cheats_update", count: clamped });
  }

  // ==========================================================================
  // PHASE 4 — SCORING & MANCHE SUIVANTE
  // ==========================================================================

  private handleNextRound(ws: WebSocket): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (!pseudo || pseudo !== this.hostPseudo) {
      this.sendError(ws, "NOT_HOST", "Seul l'hote peut passer a la suite.");
      return;
    }
    if (this.phase !== "validating" && this.phase !== "scoring") {
      this.sendError(ws, "WRONG_PHASE", "Pas la bonne phase pour cela.");
      return;
    }
    if (!this.config || !this.letter) return;

    if (this.phase === "validating") {
      // Premier passage : on calcule les scores et on diffuse
      const pseudos = Object.keys(this.answers);
      const { cellScores, scoreByPlayer } = computeRoundScores(
        this.letter,
        this.config.categories,
        pseudos,
        this.answers,
        this.cellStates,
        this.config.scoring,
        this.config.lengthConstraint
      );
      if (!this.currentResult) return;
      this.currentResult.cellScores = cellScores;
      this.currentResult.scoreByPlayer = scoreByPlayer;

      // Application du malus tricheur : applique au stoppeur uniquement, si configure.
      // cheaterPenalty est negatif ou nul. Il est ajoute au score de la manche du stoppeur,
      // et stocke sur le RoundResult pour affichage cote client.
      const stoppedBy = this.currentResult.stoppedBy;
      const cheats = this.currentResult.cheaterCheats;
      const perCheat = this.config.scoring.cheaterPenaltyPerCheat ?? 0;
      let penalty = 0;
      if (stoppedBy && cheats > 0 && perCheat < 0 && scoreByPlayer[stoppedBy] !== undefined) {
        penalty = cheats * perCheat; // <= 0
        scoreByPlayer[stoppedBy] += penalty;
      }
      this.currentResult.cheaterPenalty = penalty;

      // Cumul dans les sessions (apres application du malus)
      for (const [p, score] of Object.entries(scoreByPlayer)) {
        const session = this.players.get(p);
        if (session) session.totalScore += score;
      }
      this.phase = "scoring";
      this.broadcast({
        type: "round_scored",
        categories: this.config.categories,
        totalRounds: this.config.totalRounds,
        result: this.currentResult,
        players: this.snapshotPlayers(),
      });
      this.broadcastRoomState();
      return;
    }

    // phase === "scoring" : passage a la manche suivante OU fin de partie
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
    this.letter = null;
    this.roundEndsAt = null;
    const ranking = this.snapshotPlayers().sort(
      (a, b) => b.totalScore - a.totalScore
    );
    this.broadcast({
      type: "game_finished",
      ranking,
      drawnLetters: [...this.drawnLetters],
    });
    this.broadcastRoomState();
  }

  /**
   * L'hote termine la partie immediatement (depuis les vues validating ou scoring).
   * Saute directement au classement final avec les scores cumules actuels.
   */
  private handleEndGame(ws: WebSocket): void {
    const pseudo = this.wsToPseudo.get(ws);
    if (!pseudo || pseudo !== this.hostPseudo) {
      this.sendError(ws, "NOT_HOST", "Seul l'hote peut terminer la partie.");
      return;
    }
    if (
      this.phase !== "in_round" &&
      this.phase !== "validating" &&
      this.phase !== "scoring"
    ) {
      this.sendError(ws, "WRONG_PHASE", "Pas de partie en cours a terminer.");
      return;
    }
    // Si on est en pleine manche, on coupe le timer
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
    this.letter = null;
    this.drawnLetters = [];
    this.roundEndsAt = null;
    this.answers = {};
    this.cellStates = {};
    this.currentResult = null;
    for (const p of this.players.values()) {
      p.totalScore = 0;
      p.hasSubmitted = false;
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

  /**
   * Envoie a un nouveau client le snapshot complet de la room.
   * Utilise au moment du `joined` initial ET en reconnexion.
   */
  private sendJoinedSnapshot(ws: WebSocket, pseudo: string): void {
    const isHost = pseudo === this.hostPseudo;
    const finalRanking =
      this.phase === "finished"
        ? this.snapshotPlayers().sort((a, b) => b.totalScore - a.totalScore)
        : null;
    // Reponses propres du joueur pour la manche en cours (utilise pour
    // restaurer la grille apres une deconnexion / refresh en in_round).
    // On n'envoie QUE les siennes : les reponses des autres restent
    // confidentielles jusqu'a la phase de validation.
    const myAnswers =
      this.phase === "in_round" ? this.answers[pseudo] ?? null : null;
    this.send(ws, {
      type: "joined",
      pseudo,
      isHost,
      players: this.snapshotPlayers(),
      hostPseudo: this.hostPseudo ?? "",
      roomCode: "", // rempli cote routeur si besoin
      phase: this.phase,
      config: this.config,
      currentRound: this.currentRound,
      letter: this.letter,
      roundEndsAt: this.roundEndsAt,
      currentResult: this.currentResult,
      finalRanking,
      myAnswers,
      drawnLetters: [...this.drawnLetters],
    });
  }

  private broadcastRoomState(): void {
    const message: ServerMessage = {
      type: "room_state",
      players: this.snapshotPlayers(),
      hostPseudo: this.hostPseudo ?? "",
      phase: this.phase,
    };
    this.broadcast(message);
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

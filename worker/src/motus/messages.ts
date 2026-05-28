/**
 * Types des messages echanges entre client et serveur — Motus.
 *
 * Convention : `type` est le discriminant. Tous les messages serveur ont
 * un champ `type` qui permet au client de router le traitement.
 *
 * Les constantes generiques (ROOM_CONFIG, PlayerInfo, codes d'erreur communs)
 * sont importees depuis ../shared/types.
 */

import type { PlayerInfo, SharedErrorCode } from "../shared/types";
export { ROOM_CONFIG } from "../shared/types";
export type { PlayerInfo } from "../shared/types";

// ===========================================
// Constantes specifiques Motus
// ===========================================

export const MOTUS_CONFIG = {
  MIN_WORD_LEN: 5,
  MAX_WORD_LEN: 10,
  DEFAULT_WORD_LEN: 7,
  MIN_ATTEMPTS: 4,
  MAX_ATTEMPTS: 8,
  DEFAULT_ATTEMPTS: 6,
} as const;

/**
 * Mode de jeu Motus.
 *   - "coop_stream" : seul l'hote tape, tout le monde voit la meme grille
 *     en temps reel. Conçu pour le stream.
 *   - "competitive" : tout le monde a le meme mot, chacun sa grille, on voit
 *     les couleurs des autres mais pas les lettres. Le mode est fige a la
 *     creation de la room (cf. handleGameRoutes cote worker).
 */
export type GameMode = "coop_stream" | "competitive";

/**
 * Preset de partie competitive. L'hote choisit un preset, qui fixe toutes les
 * dimensions ; ou bien il bascule en "custom" pour tout regler a la main.
 *
 *   - "speed"     : 1er trouve = fin manche, position scoring (3/2/1), 5 manches, pas de timer
 *   - "chrono"    : timer 90s, tout le monde joue jusqu'a fin timer, attempts_left + bonus 1er, 5 manches
 *   - "marathon"  : tout le monde finit, attempts_left, manches illimitees
 *   - "custom"    : aucun verrouillage, tout regle par l'hote
 */
export type CompPreset = "speed" | "chrono" | "marathon" | "custom";

/**
 * Quand la manche se termine.
 *   - "first_finds"   : des qu'un joueur trouve le mot, manche terminee
 *   - "everyone_done" : on attend que tout le monde ait soit trouve, soit
 *                       epuise ses essais
 *   - "timer_only"    : la manche dure exactement timerSeconds, peu importe
 *                       qui trouve quand
 */
export type EndCondition = "first_finds" | "everyone_done" | "timer_only";

/**
 * Comment on attribue les points pour la manche.
 *   - "position"      : 3 pts au 1er, 2 pts au 2e, 1 pt au 3e, 0 sinon
 *   - "binary"        : 1 pt au 1er, 0 aux autres (s'aligne bien avec first_finds)
 *   - "attempts_left" : (maxAttempts - essais utilises) pour ceux qui trouvent
 *   - "combo"         : attempts_left + bonus de position (+2 au 1er, +1 au 2e)
 */
export type ScoringMode = "position" | "binary" | "attempts_left" | "combo";

/**
 * Format de partie (condition d'arret de la boucle de manches).
 *   - "fixed_rounds"     : n manches fixes (maxRounds)
 *   - "unlimited"        : l'hote arrete quand il veut via end_game
 *   - "first_to_points"  : premier a atteindre pointsTarget gagne
 */
export type GameFormat = "fixed_rounds" | "unlimited" | "first_to_points";

export interface MotusConfig {
  // Champs communs aux deux modes
  wordLength: number;     // entre MIN_WORD_LEN et MAX_WORD_LEN
  maxAttempts: number;    // entre MIN_ATTEMPTS et MAX_ATTEMPTS
  mode: GameMode;

  // Champs specifiques au mode competitive. Optionnels en coop_stream (ignores).
  preset?: CompPreset;
  endCondition?: EndCondition;
  /**
   * Duree du timer de manche en secondes. null = pas de timer.
   * Si endCondition === "timer_only", ce champ est obligatoire.
   */
  timerSeconds?: number | null;
  scoring?: ScoringMode;
  format?: GameFormat;
  /**
   * Nombre de manches max si format === "fixed_rounds". Ignore sinon.
   */
  maxRounds?: number;
  /**
   * Seuil de points si format === "first_to_points". Ignore sinon.
   */
  pointsTarget?: number;
}

/**
 * Bornes des parametres du mode competitive. La normalisation cote serveur
 * clamp dans ces bornes ; l'UI client utilise les memes pour les inputs.
 */
export const COMP_CONFIG = {
  MIN_TIMER_SEC: 15,
  MAX_TIMER_SEC: 300,
  MIN_ROUNDS: 1,
  MAX_ROUNDS: 50,
  MIN_POINTS_TARGET: 1,
  MAX_POINTS_TARGET: 100,
} as const;

/**
 * Definition des presets. Sert de source unique a la fois pour le client
 * (afficher les choix) et le serveur (valider qu'un preset envoye correspond
 * bien aux parametres associes — defense contre client qui mentirait).
 *
 * Note : "custom" n'est pas dans COMP_PRESETS car il n'a pas de valeurs par
 * defaut imposees ; il est libre.
 */
export const COMP_PRESETS: Record<
  Exclude<CompPreset, "custom">,
  Required<Pick<MotusConfig, "endCondition" | "timerSeconds" | "scoring" | "format" | "maxRounds">>
> = {
  speed: {
    endCondition: "first_finds",
    timerSeconds: null,
    scoring: "position",
    format: "fixed_rounds",
    maxRounds: 5,
  },
  chrono: {
    endCondition: "timer_only",
    timerSeconds: 90,
    scoring: "combo",
    format: "fixed_rounds",
    maxRounds: 5,
  },
  marathon: {
    endCondition: "everyone_done",
    timerSeconds: null,
    scoring: "attempts_left",
    format: "unlimited",
    maxRounds: 0,
  },
};

// ===========================================
// Coloration des essais — la mecanique cle
// ===========================================

/**
 * Statut d'une lettre dans un essai apres coloration.
 *
 *   - "good"     : bien placee (rouge classique)
 *   - "misplaced": mal placee (jaune classique)
 *   - "absent"   : pas dans le mot (gris/blanc)
 *
 * Le 4e cas "bien placee + presente ailleurs" n'est PAS une nouvelle valeur,
 * mais un drapeau additionnel `hasMore: true` sur une case "good". Cela
 * permet au client de choisir librement le rendu visuel (diagonale rouge/jaune,
 * 4e couleur mauve, bordure, etc.) sans changer le protocole.
 */
export type LetterStatus = "good" | "misplaced" | "absent";

export interface LetterFeedback {
  letter: string;          // la lettre saisie (uppercase, A-Z)
  status: LetterStatus;
  /**
   * Vrai si la case est "good" ET qu'il existe au moins une autre instance
   * non-decouverte de cette meme lettre ailleurs dans le mot. Sinon false.
   * N'a de sens que pour status === "good" ; toujours false dans les autres cas.
   */
  hasMore: boolean;
}

/**
 * Un essai consigne : la chaine saisie + la coloration calculee par le serveur.
 */
export interface Attempt {
  guess: string;                   // ce qui a ete tape (uppercase, A-Z)
  feedback: LetterFeedback[];      // longueur === guess.length
}

// ===========================================
// Etat de la room (vu par le client)
// ===========================================

export type RoomPhase =
  | "lobby"            // attente avant le 1er mot/manche
  // Phases mode coop_stream (rétro-compat)
  | "in_game"          // un mot en cours (coop)
  | "between_words"    // mot trouve ou epuise, on attend "next" de l'hote (coop)
  // Phases mode competitive
  | "in_round"         // une manche en cours (comp)
  | "between_rounds"   // manche terminee, recap visible, on attend "next_round" host (comp)
  | "finished";        // partie terminee (fin de boucle de manches), retour lobby au prochain start

export interface WordState {
  /**
   * La 1ere lettre, donnee en debut de manche. Le reste du mot n'est PAS
   * envoye aux clients tant que le mot n'est pas trouve ou les essais epuises.
   */
  firstLetter: string;
  wordLength: number;
  attempts: Attempt[];          // tous les essais soumis jusqu'ici
  maxAttempts: number;
  /**
   * Mot complet : envoye uniquement quand la manche est terminee (trouvee ou
   * epuisee). null tant que la partie est en cours.
   */
  revealedWord: string | null;
  status: "in_progress" | "found" | "exhausted";
  /**
   * Pseudo du joueur qui a trouve le mot, si status === "found". Null sinon.
   * En mode coop_stream, c'est toujours l'hote (puisqu'il est le seul a taper).
   */
  foundBy: string | null;
}

// ===========================================
// Messages CLIENT -> SERVEUR
// ===========================================

export type ClientMessage =
  // Lobby
  | { type: "join"; pseudo: string }
  | { type: "kick"; targetPseudo: string }
  | { type: "ping" }
  | { type: "config_update"; config: MotusConfig }   // host : diffuse la config live
  | { type: "start_game"; config: MotusConfig }
  // Pendant la manche
  | { type: "submit_guess"; guess: string }         // host (mode coop)
  // Entre manches
  | { type: "next_word" }                            // host : demarre le prochain mot
  | { type: "end_game" };                            // host : termine la partie

// ===========================================
// Messages SERVEUR -> CLIENT
// ===========================================

export type ServerMessage =
  // Lobby / etat
  | {
      type: "joined";
      pseudo: string;
      isHost: boolean;
      players: PlayerInfo[];
      hostPseudo: string;
      roomCode: string;
      phase: RoomPhase;
      config: MotusConfig | null;
      /**
       * Mot en cours s'il y en a un (in_game ou between_words). null sinon.
       * Permet la reconnexion en plein milieu d'une manche.
       */
      currentWord: WordState | null;
    }
  | {
      type: "room_state";
      players: PlayerInfo[];
      hostPseudo: string;
      phase: RoomPhase;
    }
  | { type: "kicked"; reason: string }
  | { type: "error"; code: ErrorCode; message: string }
  | { type: "pong" }
  // Configuration en direct
  | {
      type: "config_update";
      config: MotusConfig;
    }
  // Demarrage d'une nouvelle manche : on envoie la 1ere lettre, le reste reste secret
  | {
      type: "word_started";
      firstLetter: string;
      wordLength: number;
      maxAttempts: number;
    }
  // Apres chaque essai, on diffuse l'essai colore (visible par tous : single grille partagee en coop)
  | {
      type: "guess_resolved";
      attempt: Attempt;
      attemptIndex: number;       // 0-based, pour positionner sur la grille
      status: "in_progress" | "found" | "exhausted";
      /**
       * Le mot, devoile uniquement quand status !== "in_progress".
       * Null tant que la partie continue.
       */
      revealedWord: string | null;
      foundBy: string | null;
    };

// ===========================================
// Codes d'erreur
// ===========================================

export type ErrorCode =
  | SharedErrorCode
  // Specifiques Motus
  | "INVALID_CONFIG"
  | "WRONG_PHASE"
  | "NOT_ENOUGH_PLAYERS"
  | "INVALID_GUESS_LENGTH"      // mot saisi pas a la bonne longueur
  | "INVALID_GUESS_LETTERS"     // caracteres autres que A-Z
  | "INVALID_GUESS_FIRST_LETTER" // ne commence pas par la lettre imposee
  | "WORD_NOT_IN_DICTIONARY";   // mot pas dans le dico playable

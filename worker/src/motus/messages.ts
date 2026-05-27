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
 *   - "coop_stream" (Livraison 2) : seul l'hote tape, tout le monde voit la
 *     meme grille en temps reel. Conçu pour le stream.
 *   - "competitive" (Livraison 3) : tout le monde le meme mot, chacun sa
 *     grille, on voit les couleurs des autres mais pas les lettres.
 */
export type GameMode = "coop_stream" | "competitive";

export interface MotusConfig {
  wordLength: number;     // entre MIN_WORD_LEN et MAX_WORD_LEN
  maxAttempts: number;    // entre MIN_ATTEMPTS et MAX_ATTEMPTS
  mode: GameMode;
}

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
  | "lobby"            // attente avant le 1er mot
  | "in_game"          // un mot en cours
  | "between_words"    // mot trouve ou epuise, on attend "next" de l'hote
  | "finished";        // l'hote a quitte le jeu

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

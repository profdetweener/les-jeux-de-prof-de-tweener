/**
 * Types des messages echanges entre client et serveur — Definitions.
 *
 * Principe du jeu :
 *   - chaque manche affiche un mot/expression difficile (la vraie definition
 *     est codee en dur cote serveur, cf. words.ts)
 *   - phase WRITING : chaque joueur ecrit sa proposition de definition (a l'aveugle)
 *   - fin de manche : la vraie definition est revelee, et toutes les propositions
 *     deviennent visibles (jeu NON anonyme)
 *   - phase VOTING : chaque joueur note la proposition de chacun de ses adversaires
 *     avec une valeur dans {0, 0.25, 0.5, 0.75, 1}. On ne se note pas soi-meme
 *     (diagonale barree de la matrice). Les votes sont visibles en direct.
 *   - phase SCORING : le serveur agrege les votes recus par chaque auteur
 *     (moyenne tronquee par defaut, robuste aux notes malveillantes) et applique
 *     le bareme pour donner le score de la manche.
 *
 * Les constantes generiques (ROOM_CONFIG, PlayerInfo, codes d'erreur communs)
 * viennent de ../shared/types.
 */

import type { PlayerInfo, SharedErrorCode } from "../shared/types";
export { ROOM_CONFIG } from "../shared/types";
export type { PlayerInfo } from "../shared/types";

// ===========================================
// Constantes specifiques Definitions
// ===========================================

export const DEF_CONFIG = {
  MIN_TIMER_SEC: 30,
  MAX_TIMER_SEC: 600,
  DEFAULT_TIMER_SEC: 120,
  MIN_ROUNDS: 1,
  MAX_ROUNDS: 30, // 0 = illimite
  MAX_DEFINITION_LEN: 280, // longueur max d'une proposition (caracteres)
  MIN_POINTS_PER_ROUND: 10,
  MAX_POINTS_PER_ROUND: 1000,
  DEFAULT_POINTS_PER_ROUND: 100,
  // Valeurs de vote autorisees (paliers de 0.25)
  VOTE_VALUES: [0, 0.25, 0.5, 0.75, 1] as const,
  DEFAULT_AGGREGATION: "trimmed" as Aggregation,
} as const;

/**
 * Methode d'agregation des votes recus par un auteur :
 *   - "mean"    : moyenne simple de tous les votes recus
 *   - "trimmed" : moyenne tronquee — on retire le vote le plus haut ET le plus
 *                 bas avant de moyenner (des qu'il y a au moins 4 votes ; sinon
 *                 on retombe sur la moyenne simple). Neutralise un saboteur isole.
 *   - "median"  : mediane des votes recus (tres robuste a un vote extreme isole).
 */
export type Aggregation = "mean" | "trimmed" | "median";

// ===========================================
// Configuration de partie (definie par le host)
// ===========================================

export interface GameConfig {
  /** Nombre de manches. 0 = illimite (jusqu'a arret manuel par l'hote). */
  totalRounds: number;
  /** Duree de la phase d'ecriture (secondes). */
  timerSeconds: number;
  /** Methode d'agregation des votes. */
  aggregation: Aggregation;
  /**
   * Bareme : le score d'une manche pour un auteur vaut
   *   round(agregat(0..1) × maxPointsPerRound).
   * Une note moyenne de 0.75 avec maxPointsPerRound = 100 donne donc 75 points.
   */
  maxPointsPerRound: number;
}

// ===========================================
// Etat de la room (vu par le client)
// ===========================================

export type RoomPhase =
  | "lobby"
  | "writing"   // mot affiche, chacun ecrit sa definition (a l'aveugle)
  | "voting"    // vraie definition revelee, on note les propositions des autres
  | "scoring"   // scores de la manche affiches
  | "finished"; // classement final

/**
 * Matrice de votes : votes[voter][author] = valeur dans {0,0.25,0.5,0.75,1}.
 * Pas d'auto-vote (voter === author exclu). Un vote non encore exprime est
 * simplement absent de la matrice (ignore a l'agregation).
 */
export type VoteMatrix = Record<string, Record<string, number>>;

export interface RoundResult {
  roundNumber: number;
  word: string;
  /** Vraie definition (revelee en phase voting/scoring uniquement). */
  realDefinition: string;
  /** definitions[author] = proposition saisie (chaine, "" si rien soumis). */
  definitions: Record<string, string>;
  /** votes[voter][author] = valeur de vote. */
  votes: VoteMatrix;
  /**
   * Agregat des votes recus par chaque auteur (0..1). Rempli au scoring.
   * Vide tant qu'on est en phase voting.
   */
  aggregateByAuthor: Record<string, number>;
  /** Score de la manche par joueur (points). Rempli au scoring. */
  scoreByPlayer: Record<string, number>;
}

// ===========================================
// Messages CLIENT -> SERVEUR
// ===========================================

export type ClientMessage =
  // Lobby
  | { type: "join"; pseudo: string }
  | { type: "kick"; targetPseudo: string }
  | { type: "ping" }
  // Partie
  | { type: "start_game"; config: GameConfig }
  | { type: "config_update"; config: GameConfig } // host : diffuse la config live
  // Phase writing : sauvegarde continue de sa proposition
  | { type: "submit_definition"; text: string }
  // Phase writing : "j'ai terminé" -> verrouille, fin anticipee si tous verrouillent
  | { type: "lock_definition" }
  // Phase voting : je note la proposition d'un auteur (voter = expediteur)
  | { type: "set_vote"; author: string; value: number }
  | { type: "next_round" } // host : voting->scoring (calcule), puis scoring->suite
  | { type: "end_game" } // host : termine tout de suite
  | { type: "back_to_lobby" };

// ===========================================
// Messages SERVEUR -> CLIENT
// ===========================================

export type ServerMessage =
  | {
      type: "joined";
      pseudo: string;
      isHost: boolean;
      players: PlayerInfo[];
      hostPseudo: string;
      roomCode: string;
      phase: RoomPhase;
      config: GameConfig | null;
      currentRound: number;
      // Mot de la manche en cours (phase writing/voting/scoring), null sinon.
      word: string | null;
      roundEndsAt: number | null;
      currentResult: RoundResult | null;
      finalRanking: PlayerInfo[] | null;
      // Ma propre proposition pour la manche en cours (writing uniquement),
      // pour restaurer apres reconnexion / refresh. null sinon.
      myDefinition: string | null;
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
  | { type: "config_update"; config: GameConfig }
  | {
      type: "round_started";
      roundNumber: number;
      totalRounds: number;
      word: string; // la vraie definition N'est PAS envoyee ici
      timerSeconds: number;
      roundEndsAt: number;
    }
  | {
      // Indique qui a verrouille sa definition (sans en reveler le contenu)
      type: "definition_locked";
      pseudo: string;
    }
  | {
      type: "round_ended";
      reason: "timer" | "all_locked";
      word: string;
      realDefinition: string;
      totalRounds: number;
      result: RoundResult;
    }
  | {
      // Matrice de votes diffusee a chaque modification (visible par tous)
      type: "vote_update";
      votes: VoteMatrix;
    }
  | {
      type: "round_scored";
      totalRounds: number;
      result: RoundResult;
      players: PlayerInfo[]; // totalScore mis a jour
    }
  | {
      type: "game_finished";
      ranking: PlayerInfo[];
    };

// ===========================================
// Codes d'erreur
// ===========================================

export type ErrorCode =
  | SharedErrorCode
  | "INVALID_CONFIG"
  | "WRONG_PHASE"
  | "NOT_ENOUGH_PLAYERS"
  | "INVALID_VOTE";

/**
 * Types des messages echanges entre client et serveur — Petit Bac.
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
// Constantes specifiques Petit Bac
// ===========================================

export const ROUND_CONFIG = {
  MIN_TIMER_SEC: 30,
  MAX_TIMER_SEC: 300,
  DEFAULT_TIMER_SEC: 90,
  // Lettres exclues du tirage par defaut (rares en francais)
  // Le tirage reste "aleatoire pur" dans l'alphabet ci-dessous.
  LETTERS: "ABCDEFGHIJLMNOPRSTUV",
  MIN_CATEGORIES: 2,
  MAX_CATEGORIES: 12,
  MAX_CATEGORY_LEN: 30,
  MAX_ANSWER_LEN: 50,
  MIN_ROUNDS: 1,
  MAX_ROUNDS: 20, // 0 = illimite
  // Contrainte optionnelle sur la longueur des mots (par caracteres, sans
  // les espaces de tete/queue). 1 = au moins une lettre, MAX = on borne pour
  // qu'il reste un peu de marge sous MAX_ANSWER_LEN. La contrainte est soit
  // "min N" (les mots de moins de N lettres sont rejetes), soit "max N" (les
  // mots de plus de N lettres sont rejetes), soit aucune.
  MIN_WORD_LEN_BOUND: 1,
  MAX_WORD_LEN_BOUND: 30,
  // Bareme par defaut (classique)
  DEFAULT_SCORING: {
    aloneInCategory: 15, // seul a repondre dans toute la categorie
    uniqueAnswer: 10,    // bonne reponse non doublonnee, plusieurs repondants
    duplicateAnswer: 5,  // reponse en doublon
    invalidOrEmpty: 0,   // pas de reponse ou invalidee par vote
    cheaterPenaltyPerCheat: 0, // malus par categorie jugee "tricheuse" pour le stoppeur (≤ 0)
  },
  // Modes de fin de manche
  DEFAULT_END_MODE: "stop_or_timer" as "stop_or_timer" | "timer_only",
  MIN_CHEATER_PENALTY: -100,
  MAX_CHEATER_PENALTY: 0,
} as const;

export const CATEGORY_PRESETS = [
  "Pays",
  "Ville",
  "Animal",
  "Prenom",
  "Metier",
  "Fruit / Legume",
  "Couleur",
  "Sport",
  "Marque",
  "Film",
  "Personnage celebre",
  "Plat / Cuisine",
  "Objet de la maison",
  "Vetement",
  "Instrument de musique",
] as const;

// ===========================================
// Configuration de partie (definie par le host)
// ===========================================

export interface ScoringConfig {
  aloneInCategory: number;  // seul a repondre dans la categorie
  uniqueAnswer: number;     // reponse unique parmi plusieurs repondants
  duplicateAnswer: number;  // reponse en doublon
  invalidOrEmpty: number;   // vide ou invalide par vote
  /**
   * Malus (≤ 0) applique au stoppeur pour chaque categorie marquee
   * "tricheuse" par les autres joueurs pendant la phase de validation.
   * 0 = desactive (pas d'UI affichee).
   * N'a d'effet que si la manche s'est terminee par STOP (reason === "stop").
   * Optionnel pour la retrocompatibilite (parties en cours avec ancienne config).
   */
  cheaterPenaltyPerCheat?: number;
}

/**
 * Mode de fin de manche :
 *   - "stop_or_timer" : un joueur peut cliquer STOP des qu'il a tout rempli,
 *     ou bien attendre le timer (comportement historique).
 *   - "timer_only" : aucun joueur ne peut interrompre la manche, on attend le timer.
 *     Le bouton STOP n'est pas affiche cote client.
 */
export type EndMode = "stop_or_timer" | "timer_only";

/**
 * Contrainte optionnelle de longueur de mot.
 *   - mode "none" : pas de contrainte (equivalent a un champ absent)
 *   - mode "min"  : la reponse doit avoir AU MOINS `value` caracteres (trim)
 *   - mode "max"  : la reponse doit avoir AU PLUS `value` caracteres (trim)
 *
 * Le but est de forcer la reflexion : avec un min eleve, les joueurs ne peuvent
 * plus enchainer en mode "tac-au-tac". Une seule contrainte a la fois (radio).
 *
 * Une cellule qui viole la contrainte est traitee EXACTEMENT comme une cellule
 * qui ne commence pas par la bonne lettre :
 *   - on ne peut pas faire STOP tant qu'au moins une case viole la contrainte
 *   - au scoring, la cellule est forcee a "reject" (donc invalidOrEmpty points)
 *   - en validation, la cellule est affichee non-votable avec un tooltip
 */
export interface LengthConstraint {
  mode: "none" | "min" | "max";
  value: number; // ignore si mode === "none"
}

export interface GameConfig {
  categories: string[];        // liste finale des categories
  totalRounds: number;         // 0 = illimite (jusqu'a stop manuel)
  timerSeconds: number;        // duree du timer de la manche
  scoring: ScoringConfig;
  /**
   * Optionnel pour la retrocompatibilite : si absent ou inconnu, on traite
   * comme "stop_or_timer" (comportement historique).
   */
  endMode?: EndMode;
  /**
   * Chaine de lettres autorisees pour le tirage (ex. "ABCDEFGH").
   * Optionnel : si absent ou vide, le serveur retombe sur ROUND_CONFIG.LETTERS.
   * Cote serveur, on normalise toujours en uppercase + dedup + filtre A-Z.
   */
  letterPool?: string;
  /**
   * Contrainte de longueur de mot. Optionnel pour la retrocompatibilite :
   * absent = aucune contrainte (comportement historique).
   */
  lengthConstraint?: LengthConstraint;
}

// ===========================================
// Etat de la room (vu par le client)
// ===========================================

export type RoomPhase =
  | "lobby"
  | "in_round"      // manche en cours, joueurs remplissent
  | "validating"    // grille affichee, votes en cours
  | "scoring"       // affichage des scores de la manche
  | "finished";     // partie terminee, classement final

// PlayerInfo est defini dans ../shared/types et reexporte en haut de ce fichier.

export type VoteValue = "unique" | "duplicate" | "reject";

export interface RoundResult {
  roundNumber: number;
  letter: string;
  // grid[pseudo][category] = string (reponse brute saisie)
  answers: Record<string, Record<string, string>>;
  // cellStates[pseudo][category] = VoteValue (etat partage, modifie collaborativement)
  cellStates: Record<string, Record<string, VoteValue>>;
  // scores[pseudo][category] = number (apres calcul)
  cellScores: Record<string, Record<string, number>>;
  // scoreByPlayer[pseudo] = number (somme de la manche)
  scoreByPlayer: Record<string, number>;
  /**
   * Pseudo du joueur qui a stoppe la manche (si la manche s'est terminee par STOP).
   * null pour les manches terminees par timer ou all_submitted.
   * Necessaire pour afficher l'UI de "vote tricheur" pendant la phase validating.
   */
  stoppedBy: string | null;
  /**
   * Nombre de categories considerees "tricheuses" pour le stoppeur (cellules valides
   * syntaxiquement mais jugees abusives, type "A" tout seul en Animal). Edite
   * collaborativement pendant la phase validating, applique au scoring.
   * 0 par defaut. N'a de sens que si stoppedBy !== null.
   */
  cheaterCheats: number;
  /**
   * Malus total applique au stoppeur (cheaterCheats × cheaterPenaltyPerCheat).
   * Rempli uniquement au moment du scoring (phase "scoring"), sinon 0.
   */
  cheaterPenalty: number;
}

// ===========================================
// Messages CLIENT -> SERVEUR
// ===========================================

export type ClientMessage =
  // Phase 3 (lobby)
  | { type: "join"; pseudo: string }
  | { type: "kick"; targetPseudo: string }
  | { type: "ping" }
  // Phase 4 (game)
  | { type: "start_game"; config: GameConfig }
  | { type: "config_update"; config: GameConfig } // host : diffuse la config live aux autres
  | { type: "submit_answers"; answers: Record<string, string> }
  | { type: "stop_round" }
  | {
      // Modifie collaborativement l'etat d'une cellule (n'importe qui peut le faire)
      type: "set_cell_state";
      targetPseudo: string;
      category: string;
      state: "unique" | "duplicate" | "reject";
    }
  | {
      // Modifie collaborativement le nombre de categories "tricheuses" du stoppeur.
      // N'a d'effet qu'en phase validating et si la manche s'est terminee par STOP.
      // Le serveur clamp entre 0 et le nombre de categories de la manche.
      type: "set_cheater_cheats";
      count: number;
    }
  | { type: "next_round" }
  | { type: "end_game" } // host : termine la partie tout de suite
  | { type: "back_to_lobby" };

// ===========================================
// Messages SERVEUR -> CLIENT
// ===========================================

export type ServerMessage =
  // Phase 3
  | {
      type: "joined";
      pseudo: string;
      isHost: boolean;
      players: PlayerInfo[];
      hostPseudo: string;
      roomCode: string;
      phase: RoomPhase;
      config: GameConfig | null;
      // Si on rejoint en cours de partie, on a besoin de l'etat courant
      currentRound: number;
      letter: string | null;
      roundEndsAt: number | null;       // timestamp epoch ms
      currentResult: RoundResult | null;
      finalRanking: PlayerInfo[] | null;
      // Reponses propres du joueur pour la manche en cours (in_round seulement),
      // permet de restaurer la grille apres reconnexion / refresh.
      // null en dehors de in_round, ou si le joueur n'a encore rien soumis.
      myAnswers: Record<string, string> | null;
      // Lettres deja tirees dans la partie en cours (ou la derniere terminee).
      // Vide tant qu'aucune manche n'a demarre.
      drawnLetters: string[];
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
  // Phase 4
  | {
      // Diffuse la config courante du host aux autres joueurs (visu uniquement)
      type: "config_update";
      config: GameConfig;
    }
  | {
      type: "round_started";
      roundNumber: number;
      totalRounds: number;
      letter: string;
      categories: string[];
      timerSeconds: number;
      roundEndsAt: number;       // timestamp epoch ms (autoritatif serveur)
    }
  | {
      type: "answers_received";
      pseudo: string;
      // Indique simplement qui a fini de soumettre, pas le contenu
    }
  | {
      type: "round_ended";
      reason: "timer" | "stop" | "all_submitted";
      stoppedBy: string | null;
      categories: string[];      // categories de la manche (pour le rendu cote client)
      totalRounds: number;
      result: RoundResult;
    }
  | {
      type: "cell_state_update";
      // Etat collaboratif diffuse a chaque modification.
      // cellStates[pseudo][category] = VoteValue
      cellStates: Record<string, Record<string, VoteValue>>;
    }
  | {
      // Diffuse a chaque modification collaborative du compteur de "categories tricheuses"
      // pour le stoppeur de la manche (phase validating uniquement).
      type: "cheater_cheats_update";
      count: number;
    }
  | {
      type: "round_scored";
      categories: string[];
      totalRounds: number;
      result: RoundResult;
      players: PlayerInfo[]; // avec totalScore mis a jour
    }
  | {
      type: "game_finished";
      ranking: PlayerInfo[];
      /**
       * Lettres tirees au cours de la partie qui vient de se terminer,
       * dans l'ordre de tirage. Permet au frontend de les memoriser pour
       * proposer de les exclure de la prochaine partie.
       */
      drawnLetters: string[];
    };

// ===========================================
// Codes d'erreur
// ===========================================

export type ErrorCode =
  | SharedErrorCode
  // Specifiques Petit Bac
  | "INVALID_CONFIG"
  | "WRONG_PHASE"
  | "NOT_ENOUGH_PLAYERS"
  | "ALREADY_SUBMITTED";

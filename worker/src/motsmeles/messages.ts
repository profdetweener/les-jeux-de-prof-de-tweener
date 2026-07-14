/**
 * Protocole Mots meles competitif, deux modes choisis dans le salon par l'hote :
 *
 *  - "commune"  : grille commune interactive. Premier a reperer un mot le
 *                 verrouille a sa couleur, plus dispo pour les autres. Score =
 *                 nombre de mots. Fin quand la grille est videe (ou hote). Pas de
 *                 mot mystere (personne ne decouvre toute la grille seul).
 *
 *  - "chacun"   : chacun sa grille (identique). On cherche en parallele, sans
 *                 verrouillage entre joueurs. Minuteur regle par l'hote. Score =
 *                 nombre de mots ; quand tu vides TA grille, le mot mystere
 *                 s'ouvre pour toi et le deviner rapporte un bonus. Classement a
 *                 la fin du minuteur, departage au chrono.
 *
 * En "chacun", l'etat de jeu (cases trouvees, mystere) est PROPRE a chaque
 * joueur : le serveur envoie a chacun son propre game_state / found.
 */

import type { SharedErrorCode } from "../shared/types";

export type MmErrorCode =
  | SharedErrorCode
  | "WRONG_PHASE"
  | "NOT_ENOUGH_PLAYERS"
  | "INVALID_MOVE";

export type Phase = "lobby" | "playing" | "finished";
export type Mode = "commune" | "chacun";

export interface Cell { r: number; c: number; }

export interface MmPlayer {
  pseudo: string;
  isHost: boolean;
  color: number;
  score: number;          // nombre de mots trouves (+ bonus mystere en "chacun")
  solvedMystery: boolean; // "chacun" uniquement
  isConnected: boolean;
  teamId: number;         // 0 = chacun pour soi ; 1..4 = equipe
}

export interface FoundWord {
  word: string;
  cells: Cell[];
  color: number;
  pseudo: string;
}

export interface GameStateDTO {
  mode: Mode;
  teamsOn: boolean;
  gridSize: number;
  grid: string[][];
  totalWords: number;
  level: string;
  // "commune" : mots trouves partages. "chacun" : mots trouves DU destinataire.
  found: FoundWord[];
  endsAt: number | null;            // "chacun" : fin du minuteur (ms epoch)
  mysteryOpen: boolean;             // "chacun" : le destinataire a tout trouve
  mysteryDefinition: string | null;
}

// -------- Client -> serveur --------
export type ClientMessage =
  | { type: "join"; pseudo: string }
  | { type: "setTeamsMode"; on: boolean }          // hote : bascule chacun pour soi / equipes
  | { type: "setTeam"; pseudo: string; teamId: number } // hote : place un joueur dans une equipe
  | { type: "start"; mode: Mode; gridSize: number; level: string; duration: number }
  | { type: "claim"; cells: Cell[] }
  | { type: "mysteryGuess"; guess: string }
  | { type: "endGame" }
  | { type: "backToLobby" };

// -------- Serveur -> client --------
export type ServerMessage =
  | {
      type: "joined";
      pseudo: string;
      isHost: boolean;
      players: MmPlayer[];
      hostPseudo: string;
      phase: Phase;
      config: { mode: Mode; teamsOn: boolean; gridSize: number; level: string; duration: number } | null;
      game: GameStateDTO | null;
    }
  | { type: "room_state"; players: MmPlayer[]; hostPseudo: string; phase: Phase; teamsOn: boolean }
  | { type: "game_state"; players: MmPlayer[]; phase: Phase; game: GameStateDTO }
  // Un mot vient d'etre trouve. "commune" : broadcast a tous. "chacun" : prive au trouveur.
  | { type: "found"; players: MmPlayer[]; word: FoundWord; remaining: number }
  // "chacun" : mise a jour legere des scores pour tous (sans la grille).
  | { type: "scores"; players: MmPlayer[] }
  // "chacun" : le mot mystere s'ouvre pour ce joueur (prive).
  | { type: "mystery_open"; definition: string; length: number }
  // Retour prive a l'auteur d'une selection.
  | { type: "hint"; kind: "longer" | "nope" | "already"; message: string }
  | { type: "finished"; players: MmPlayer[]; ranking: MmPlayer[]; winner: string; mode: Mode; teamsOn: boolean; mysteryWord: string }
  | { type: "error"; code: MmErrorCode; message: string };

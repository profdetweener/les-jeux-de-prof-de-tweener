/**
 * Protocole Mots meles, mode competitif "grille commune" (Compet 1).
 *
 * Tout le monde sur la MEME grille en temps reel. Un mot trouve est verrouille
 * a la couleur du premier qui l'a repere et n'est plus disponible. Score =
 * nombre de mots trouves ; departage au chrono (qui a atteint son total en
 * premier). Quand toute la grille est videe, la partie se termine et le
 * classement fait foi. (Pas de mot mystere ici : il est reserve aux modes ou
 * l'on decouvre soi-meme toute la grille, chill et Compet 2.)
 *
 * La grille (lettres) est diffusee a tous ; les lettres qui ne composent aucun
 * mot a trouver ne sont que du remplissage.
 */

import type { SharedErrorCode } from "../shared/types";

export type MmErrorCode =
  | SharedErrorCode
  | "WRONG_PHASE"
  | "NOT_ENOUGH_PLAYERS"
  | "INVALID_MOVE";

export type Phase = "lobby" | "playing" | "finished";

export interface Cell { r: number; c: number; }

export interface MmPlayer {
  pseudo: string;
  isHost: boolean;
  color: number; // index de palette
  score: number; // nombre de mots trouves
  isConnected: boolean;
}

export interface FoundWord {
  word: string;
  cells: Cell[];
  color: number; // couleur du joueur qui l'a trouve
  pseudo: string;
}

export interface GameStateDTO {
  gridSize: number;
  grid: string[][];       // lettres (identiques pour tous)
  totalWords: number;
  found: FoundWord[];     // mots deja trouves
  level: string;
}

// -------- Client -> serveur --------
export type ClientMessage =
  | { type: "join"; pseudo: string }
  | { type: "start"; gridSize: number; level: string }
  | { type: "claim"; cells: Cell[] }
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
      config: { gridSize: number; level: string } | null;
      game: GameStateDTO | null;
    }
  | { type: "room_state"; players: MmPlayer[]; hostPseudo: string; phase: Phase }
  | { type: "game_state"; players: MmPlayer[]; phase: Phase; game: GameStateDTO }
  // Evenement incremental quand un mot est trouve (coloration + toast live).
  | { type: "found"; players: MmPlayer[]; word: FoundWord; remaining: number }
  // Retour prive au seul auteur d'une selection : mot plus long, ou refus.
  | { type: "hint"; kind: "longer" | "nope"; message: string }
  | { type: "finished"; players: MmPlayer[]; ranking: MmPlayer[]; winner: string }
  | { type: "error"; code: MmErrorCode; message: string };

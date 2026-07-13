/**
 * Protocole Mots meles, mode competitif "grille commune" (Compet 1).
 *
 * Tout le monde sur la MEME grille en temps reel. Un mot trouve est verrouille
 * a la couleur du premier qui l'a repere et n'est plus disponible. Score = 
 * nombre de mots trouves ; departage au chrono (qui a atteint son total en
 * premier). Quand toute la grille est videe, le mot mystere s'ouvre : premier a
 * le deviner remporte un point bonus et cloture la partie.
 *
 * La grille (lettres) est diffusee a tous. Le mot mystere lui-meme n'est jamais
 * envoye au client (validation serveur) ; seule sa definition est revelee a
 * l'ouverture du finale.
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
  score: number; // nombre de mots trouves (+1 si mot mystere)
  solvedMystery: boolean;
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
  mysteryOpen: boolean;
  mysteryDefinition: string | null; // renseigne seulement quand mysteryOpen
  mysterySolvedBy: string | null;
  level: string;
}

// -------- Client -> serveur --------
export type ClientMessage =
  | { type: "join"; pseudo: string }
  | { type: "start"; gridSize: number; level: string }
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
      config: { gridSize: number; level: string } | null;
      game: GameStateDTO | null;
    }
  | { type: "room_state"; players: MmPlayer[]; hostPseudo: string; phase: Phase }
  | { type: "game_state"; players: MmPlayer[]; phase: Phase; game: GameStateDTO }
  // Evenement incremental quand un mot est trouve (coloration + toast live).
  | { type: "found"; players: MmPlayer[]; word: FoundWord; remaining: number }
  // Le finale mot mystere s'ouvre (grille videe).
  | { type: "mystery_open"; definition: string; length: number }
  // Retour prive au seul auteur d'une selection : mot plus long, ou refus.
  | { type: "hint"; kind: "longer" | "nope"; message: string }
  | { type: "finished"; players: MmPlayer[]; ranking: MmPlayer[]; winner: string; mysteryWord: string }
  | { type: "error"; code: MmErrorCode; message: string };

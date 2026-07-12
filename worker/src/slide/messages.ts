/**
 * Protocole Slide (mode competitif, plateau partage). Client -> serveur et
 * serveur -> client. Le plateau etant petit, on rediffuse l'etat complet
 * apres chaque changement plutot que des diffs.
 */

import type { SharedErrorCode } from "../shared/types";

export type SlideErrorCode =
  | SharedErrorCode
  | "WRONG_PHASE"
  | "NOT_YOUR_TURN"
  | "INVALID_MOVE"
  | "NOT_ENOUGH_PLAYERS";

export type Phase = "lobby" | "playing" | "finished";
export type TurnPhase = "push" | "claim";

export interface CardDTO {
  id: number;
  value: number;
}
export interface GroupDTO {
  key: string;
  value: number;
  cells: { r: number; c: number }[];
}
export interface SlidePlayer {
  pseudo: string;
  isHost: boolean;
  color: number; // index dans la palette
  score: number;
  isConnected: boolean;
}
export interface GameStateDTO {
  gridSize: number;
  target: number;
  board: CardDTO[][];
  river: CardDTO[];
  turnOrder: string[];
  activePseudo: string;
  activeColor: number;
  turnPhase: TurnPhase;
  lit: GroupDTO[];
  round: number;
}

// -------- Client -> serveur --------
export type ClientMessage =
  | { type: "join"; pseudo: string }
  | { type: "start"; gridSize: number; target: number }
  | { type: "push"; cardId: number; kind: "row" | "col"; index: number; fromStart: boolean }
  | { type: "claim"; key: string }
  | { type: "endTurn" }
  | { type: "backToLobby" };

// -------- Serveur -> client --------
export type ServerMessage =
  | {
      type: "joined";
      pseudo: string;
      isHost: boolean;
      players: SlidePlayer[];
      hostPseudo: string;
      phase: Phase;
      config: { gridSize: number; target: number } | null;
      game: GameStateDTO | null;
    }
  | { type: "room_state"; players: SlidePlayer[]; hostPseudo: string; phase: Phase }
  | { type: "game_state"; players: SlidePlayer[]; phase: Phase; game: GameStateDTO }
  | { type: "finished"; players: SlidePlayer[]; ranking: SlidePlayer[]; winner: string }
  | { type: "error"; code: SlideErrorCode; message: string };

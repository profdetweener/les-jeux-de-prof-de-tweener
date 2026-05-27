/**
 * Types et constantes partages entre tous les jeux.
 *
 * On garde ici uniquement ce qui est *vraiment* generique : structure d'une
 * room (code, capacite), info d'un joueur, codes d'erreur transverses.
 *
 * Chaque jeu definit son propre protocole (ClientMessage / ServerMessage)
 * dans son sous-dossier — voir par exemple `petitbac/messages.ts`.
 */

export const ROOM_CONFIG = {
  MIN_PLAYERS: 2,
  MAX_PLAYERS: 12,
  CODE_LENGTH: 6,
  // Caracteres sans ambiguite visuelle : pas de 0/O, pas de 1/I/L
  CODE_ALPHABET: "ABCDEFGHJKMNPQRSTUVWXYZ23456789",
} as const;

/**
 * Info d'un joueur expose au client. Generique : tous les jeux peuvent
 * l'utiliser tel quel ou l'etendre (Petit Bac le sert tel quel via "joined").
 */
export interface PlayerInfo {
  pseudo: string;
  isHost: boolean;
  totalScore: number;
  isConnected: boolean;
}

/**
 * Codes d'erreur communs aux jeux. Les codes specifiques (INVALID_CONFIG,
 * WRONG_PHASE...) restent dans le messages.ts de chaque jeu.
 */
export type SharedErrorCode =
  | "PSEUDO_INVALID"
  | "PSEUDO_TAKEN"
  | "ROOM_FULL"
  | "ROOM_NOT_FOUND"
  | "NOT_HOST"
  | "TARGET_NOT_FOUND"
  | "CANNOT_KICK_SELF"
  | "INVALID_MESSAGE"
  | "ALREADY_JOINED";

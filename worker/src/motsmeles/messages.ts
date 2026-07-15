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
 *                 nombre de mots ; le mot mystere est ouvert a tous des le
 *                 lancement, avec un nombre d'essais limite. Le deviner rapporte
 *                 un bonus. Classement a la fin du minuteur, departage au chrono.
 *
 *                 Le mystere est composee des cases NON couvertes par les mots
 *                 trouvables (protectMystery garantit qu'aucun mot ne le
 *                 traverse). Le client lit donc ses cases restantes dans l'ordre
 *                 et affiche la chaine : plus tu trouves de mots, plus elle se
 *                 reduit, jusqu'a valoir exactement le mystere. Aucun calcul
 *                 serveur la-dedans, le client a la grille et ses mots trouves.
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
// "chat" : la grille est jouee par le tchat Twitch. L'hote affiche la grille et
// relaie les messages du tchat au serveur, qui arbitre. Les viewers ne sont pas
// connectes en WebSocket : voir MmPlayer.isViewer.
export type Mode = "commune" | "chacun" | "chat";

export interface Cell { r: number; c: number; }

export interface MmPlayer {
  pseudo: string;
  isHost: boolean;
  color: number;
  score: number;          // nombre de mots trouves (+ bonus mystere en "chacun")
  solvedMystery: boolean; // "chacun" uniquement
  isConnected: boolean;
  teamId: number;         // 0 = chacun pour soi ; 1..8 = equipe
  isViewer?: boolean;     // "chat" : joueur venu du tchat, sans WebSocket
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
  teamNames: string[];   // index 0 = equipe 1, etc.
  gridSize: number;
  grid: string[][];
  totalWords: number;
  level: string;
  // "commune" : mots trouves partages. "chacun" : mots trouves DU destinataire.
  found: FoundWord[];
  endsAt: number | null;            // "chacun" : fin du minuteur (ms epoch)
  mysteryOpen: boolean;             // "chacun" : vrai des le lancement, pour tous
  mysteryDefinition: string | null;
  mysteryLength: number | null;     // "chacun" : nombre de lettres du mystere
  mysteryTriesLeft: number;         // "chacun" : essais restants DU destinataire
}

// -------- Client -> serveur --------
export type ClientMessage =
  | { type: "join"; pseudo: string }
  | { type: "setTeamsMode"; on: boolean }          // hote : bascule individuel / equipes
  | { type: "setTeamCount"; n: number }            // hote : nombre d'equipes
  | { type: "setTeamName"; teamId: number; name: string } // hote : renomme une equipe
  | { type: "setTeam"; pseudo: string; teamId: number } // hote : place un joueur dans une equipe
  // Hote : mode choisi dans le salon. Envoye avant le lancement, pour que le
  // serveur sache s'il doit ecouter le tchat et que les autres voient le choix.
  | { type: "setMode"; mode: Mode }
  // Hote : repartit au hasard les joueurs (ou les viewers inscrits en "chat")
  // sur les equipes, a une unite pres.
  | { type: "shuffleTeams" }
  // "chat" : l'hote relaie un message du tchat Twitch. Lui seul est cru : c'est
  // sa page qui est branchee sur l'IRC.
  | { type: "chatWord"; viewer: string; word: string }
  // "chat" + equipes : un viewer s'inscrit via !join (team = 0 s'il n'a pas
  // precise de numero, auquel cas il ira dans l'equipe la moins peuplee).
  | { type: "chatJoin"; viewer: string; team: number }
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
      config: { mode: Mode; teamsOn: boolean; teamCount: number; teamNames: string[]; gridSize: number; level: string; duration: number } | null;
      game: GameStateDTO | null;
    }
  | { type: "room_state"; players: MmPlayer[]; hostPseudo: string; phase: Phase; mode: Mode; teamsOn: boolean; teamCount: number; teamNames: string[] }
  | { type: "game_state"; players: MmPlayer[]; phase: Phase; game: GameStateDTO }
  // Un mot vient d'etre trouve. "commune" : broadcast a tous. "chacun" : prive au trouveur.
  | { type: "found"; players: MmPlayer[]; word: FoundWord; remaining: number }
  // "chacun" : mise a jour legere des scores pour tous (sans la grille).
  | { type: "scores"; players: MmPlayer[] }
  // "chacun" : retour prive sur une tentative de mot mystere. Le mystere etant
  // ouvert des le lancement (via game_state), il n'y a plus de message
  // d'ouverture : seul le resultat d'un essai circule.
  | { type: "mystery_result"; ok: boolean; triesLeft: number; message: string }
  // Retour prive a l'auteur d'une selection.
  | { type: "hint"; kind: "longer" | "nope" | "already"; message: string }
  | { type: "finished"; players: MmPlayer[]; ranking: MmPlayer[]; winner: string; mode: Mode; teamsOn: boolean; teamNames: string[]; mysteryWord: string }
  | { type: "error"; code: MmErrorCode; message: string };

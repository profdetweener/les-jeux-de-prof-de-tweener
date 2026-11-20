/**
 * Protocole Pression. Jeu joue depuis le tchat Twitch : la page de
 * l'hote lit le tchat (IRC anonyme) et relaie au serveur, qui arbitre.
 *
 * Deux modes :
 *  - "equipes"  : les viewers s'inscrivent avec !join (ou !join 2), l'hote
 *                 repartit. La cocotte passe d'equipe en equipe ; n'importe
 *                 quel membre de l'equipe qui la tient peut repondre.
 *  - "streamer" : le streamer (l'hote, qui tape sur sa page) contre tout le
 *                 tchat. Pas d'inscription : tout le tchat joue.
 *
 * Deroule : une manche = une cuisson. La regle (contient, commence, finit,
 * chaine) est tiree au debut de la manche parmi celles choisies par l'hote.
 * A chaque mot valide, la cocotte passe a l'equipe suivante avec une nouvelle
 * syllabe. Quand la pression lache, l'equipe qui la tient perd une vie. Une
 * pause, puis nouvelle manche. Derniere equipe en vie gagne.
 *
 * Boite de chargement : chaque mot qui fait passer la cocotte remplit la boite
 * de l'equipe d'autant de points que de lettres. Boite pleine = une vie de
 * plus (dans la limite du plafond) et la boite repart a zero.
 */

import type { SharedErrorCode } from "../shared/types";

export type CtErrorCode = SharedErrorCode | "WRONG_PHASE" | "NOT_ENOUGH_PLAYERS";

export type Phase = "lobby" | "playing" | "finished";
export type Mode = "equipes" | "streamer";
export type Rule = "contient" | "commence" | "finit" | "chaine";
export type Level = "facile" | "moyen" | "difficile";
export type Fuse = "courte" | "moyenne" | "longue";

export interface StartConfig {
  rules: Rule[];
  level: Level;
  fuse: Fuse;
  minTurnSec: number;     // temps minimum garanti a l'equipe qui recoit la cocotte
  lives: number;          // equipes : vies de chaque equipe
  livesStreamer: number;  // streamer : vies du streamer
  livesChat: number;      // streamer : vies du tchat
  charge: number;         // taille de la boite de chargement (en lettres)
}

export interface PlayerDTO {
  pseudo: string;
  isHost: boolean;
  isConnected: boolean;
  isViewer: boolean;      // inscrit du tchat (!join), sans WebSocket
  teamId: number;         // 0 = sans equipe
}

export interface TeamDTO {
  id: number;             // 1..8
  name: string;
  color: number;          // index de palette
  lives: number;
  maxLives: number;       // plafond (vies de depart + 2)
  charge: number;         // points dans la boite
  alive: boolean;
  members: number;        // inscrits (equipes) ; 1 / 0 en streamer
}

export interface PassInfo { word: string; by: string; teamId: number; }

export interface GameDTO {
  mode: Mode;
  level: Level;
  teams: TeamDTO[];
  chargeMax: number;
  holder: number;              // equipe qui tient la cocotte
  rule: Rule;
  syllable: string;
  manche: number;
  // Manometre : la pression monte de fuseStartAt a fuseStartAt + fuseMaxMs.
  // L'instant reel de l'explosion reste secret (tire entre min et max).
  fuseStartAt: number;
  fuseMaxMs: number;
  minTurnMs: number;
  serverNow: number;           // pour caler l'horloge du client
  interUntil: number | null;   // pause entre deux manches (ms epoch)
  lastPass: PassInfo | null;
  usedCount: number;
  whistling: boolean;          // la cocotte siffle (explosion imminente)
  hostPseudo: string;
}

export type GameEvent =
  | { kind: "manche"; chainBroken?: boolean }
  | { kind: "pass"; word: string; by: string; teamId: number; bonus: boolean; chainBroken: boolean }
  | { kind: "explode"; teamId: number; eliminated: boolean }
  // La cocotte siffle : explosion dans WARN_MS si personne ne repond.
  | { kind: "whistle" };

export interface ViewerStat { name: string; teamId: number; words: number; letters: number; }

// -------- Client -> serveur --------
export type ClientMessage =
  | { type: "join"; pseudo: string }
  | { type: "setMode"; mode: Mode }
  | { type: "setTeamCount"; n: number }
  | { type: "setTeamName"; teamId: number; name: string }
  | { type: "setTeam"; pseudo: string; teamId: number }
  | { type: "shuffleTeams" }
  // Relais du tchat (hote uniquement).
  | { type: "chatJoin"; viewer: string; team: number }
  | { type: "chatWord"; viewer: string; word: string }
  // Mode streamer : le mot tape par le streamer sur sa page.
  | { type: "hostWord"; word: string }
  | { type: "start"; mode: Mode; config: StartConfig }
  | { type: "endGame" }
  | { type: "backToLobby" };

// -------- Serveur -> client --------
export type ServerMessage =
  | {
      type: "joined";
      pseudo: string;
      isHost: boolean;
      hostPseudo: string;
      phase: Phase;
      mode: Mode;
      teamCount: number;
      teamNames: string[];
      players: PlayerDTO[];
      game: GameDTO | null;
    }
  | { type: "room_state"; players: PlayerDTO[]; hostPseudo: string; phase: Phase; mode: Mode; teamCount: number; teamNames: string[] }
  | { type: "game_state"; game: GameDTO; event?: GameEvent }
  // Mot conforme a la regle mais refuse : affiche dans le fil, pour que le
  // tchat comprenne pourquoi la cocotte n'a pas bouge.
  | { type: "reject"; by: string; word: string; teamId: number; reason: "used" | "unknown" }
  | {
      type: "finished";
      mode: Mode;
      winnerTeamId: number;
      winnerName: string;
      teams: TeamDTO[];          // classement
      top: ViewerStat[];         // meilleurs viewers (mots passes)
      longest: PassInfo | null;  // mot le plus long de la partie
      totalWords: number;
      hostPseudo: string;
    }
  | { type: "error"; code: CtErrorCode; message: string };

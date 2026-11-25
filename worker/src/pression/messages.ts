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
 * Minuteurs : chaque equipe a le sien, qui ne tourne que pendant son tour
 * (comme une pendule d'echecs). A chaque nouvelle manche, un temps de depart
 * est tire dans la plage choisie, le meme pour toutes les equipes. Une equipe
 * qui valide garde le temps qui lui reste pour son prochain tour, sans
 * descendre sous le minimum regle par l'hote. Quand son minuteur tombe a zero,
 * la cocotte saute : l'equipe perd une vie et une nouvelle manche commence.
 *
 * Deroule : une manche va d'une explosion a la suivante. La regle (contient,
 * commence, finit, chaine) est tiree au debut de la manche parmi celles
 * choisies par l'hote. A chaque mot valide, la cocotte passe a l'equipe
 * suivante avec une nouvelle syllabe. Derniere equipe en vie gagne.
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
export type Timer = "court" | "moyen" | "long";

export interface StartConfig {
  rules: Rule[];
  level: Level;
  timer: Timer;           // plage du minuteur de depart (tire au lancement)
  floorSec: number;       // minimum garanti au tour suivant d'une equipe qui a valide
  quickBonus: boolean;    // bonus de rapidite par paliers (voir QUICK_TIERS)
  graceSec: number;       // temps de passage : le minuteur demarre apres ce delai
  streamerName?: string;  // mode streamer : nom affiche (la chaine Twitch)
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
  // Manometre de l'equipe qui tient la cocotte : son minuteur demarre a
  // turnStartAt (apres le temps de passage, donc parfois dans le futur) avec
  // turnBudgetMs, sur un total de fullMs.
  turnStartAt: number;
  turnBudgetMs: number;
  fullMs: number;
  serverNow: number;           // pour caler l'horloge du client
  interUntil: number | null;   // pause entre deux manches (ms epoch)
  lastPass: PassInfo | null;
  usedCount: number;
  whistling: boolean;          // la cocotte siffle (explosion imminente)
  pausedAt: number | null;     // partie en pause depuis (ms epoch), sinon null
  hostPseudo: string;
}

export type GameEvent =
  | { kind: "manche"; chainBroken?: boolean }
  | { kind: "pass"; word: string; by: string; teamId: number; bonus: boolean; chainBroken: boolean; timeBonusSec: number }
  | { kind: "explode"; teamId: number; eliminated: boolean }
  // Compte a rebours final : explosion dans WARN_MS si personne ne repond.
  | { kind: "whistle" };

// Sort d'un mot relaye par l'hote (journal de diagnostic, ?debug=1).
export type ChatDebugResult =
  | "ok" | "pause" | "not_joined" | "not_turn" | "spam" | "late" | "rule" | "used" | "unknown";

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
  | { type: "pause" }
  | { type: "resume" }
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
  | { type: "reject"; by: string; word: string; teamId: number; reason: "used" | "unknown" | "not_joined" }
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
  | { type: "chat_debug"; by: string; word: string; result: ChatDebugResult; teamId: number; holder: number; rule: Rule; syllable: string }
  | { type: "error"; code: CtErrorCode; message: string };

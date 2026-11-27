/**
 * Protocole Pression. Deux facons de jouer, choisies a la creation de la
 * partie (Source) et fixes ensuite :
 *  - "tchat"      : jeu joue depuis le tchat Twitch. La page de l'hote lit le
 *                   tchat (IRC anonyme) et relaie au serveur, qui arbitre.
 *  - "navigateur" : chaque joueur ouvre le lien d'invitation, choisit un
 *                   pseudo et tape ses mots sur la page du jeu. Pas de temps
 *                   de passage (pas de retard de stream). L'hote compose les
 *                   equipes, ou choisit "chacun pour soi" (equipes de 1).
 *
 * Avec le tchat, deux modes :
 *  - "equipes"  : les viewers s'inscrivent avec !join (ou !join 2), l'hote
 *                 repartit. La caisse passe d'equipe en equipe ; n'importe
 *                 quel membre de l'equipe qui la tient peut repondre.
 *  - "streamer" : le streamer (l'hote, qui joue lui aussi depuis le tchat) contre tout le
 *                 tchat. Pas d'inscription : tout le tchat joue.
 *
 * Minuteurs : chaque equipe a le sien, qui ne tourne que pendant son tour
 * (comme une pendule d'echecs). A chaque nouvelle manche, toutes les equipes
 * repartent avec le temps de depart regle par l'hote. Une equipe
 * qui valide garde le temps qui lui reste pour son prochain tour, sans
 * descendre sous le minimum regle par l'hote. Quand son minuteur tombe a zero,
 * la caisse saute : l'equipe perd une vie et une nouvelle manche commence.
 *
 * Deroule : une manche va d'une explosion a la suivante. La regle (contient,
 * commence, finit, chaine) est tiree au debut de la manche parmi celles
 * choisies par l'hote. A chaque mot valide, la caisse passe a l'equipe
 * suivante avec une nouvelle syllabe. Derniere equipe en vie gagne.
 *
 * Boite de chargement : chaque mot qui fait passer la caisse remplit la boite
 * de l'equipe d'autant de points que de lettres. Boite pleine = une vie de
 * plus (dans la limite du plafond) et la boite repart a zero.
 */

import type { SharedErrorCode } from "../shared/types";

export type CtErrorCode = SharedErrorCode | "WRONG_PHASE" | "NOT_ENOUGH_PLAYERS";

export type Phase = "lobby" | "playing" | "finished";
export type Mode = "equipes" | "streamer";
export type Source = "tchat" | "navigateur";
export type Rule = "contient" | "commence" | "finit" | "chaine";
export type Level = "facile" | "moyen" | "difficile";
export type Timer = "court" | "moyen" | "long" | "custom";

export interface StartConfig {
  rules: Rule[];
  level: Level;
  timer: Timer;           // minuteur de depart ("custom" : timerMin..timerMax, en s ;
                          // la page envoie un temps fixe, timerMin = timerMax)
  timerMin?: number;
  timerMax?: number;
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
  teamId: number;         // 0 = sans equipe (navigateur : equipe du salon, puis de la partie)
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
  source: Source;
  solo: boolean;               // navigateur : chacun pour soi (equipes de 1)
  level: Level;
  teams: TeamDTO[];
  chargeMax: number;
  holder: number;              // equipe qui tient la caisse
  rule: Rule;
  syllable: string;
  manche: number;
  // Ecran de la caisse : le minuteur de l'equipe qui la tient demarre a
  // turnStartAt (apres le temps de passage, donc parfois dans le futur) avec
  // turnBudgetMs, sur un total de fullMs.
  turnStartAt: number;
  turnBudgetMs: number;
  fullMs: number;
  serverNow: number;           // pour caler l'horloge du client
  interUntil: number | null;   // pause entre deux manches (ms epoch)
  lastPass: PassInfo | null;
  usedCount: number;
  whistling: boolean;          // compte a rebours final (explosion imminente)
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
  // Navigateur : chacun pour soi (equipes de 1) ou equipes (hote).
  | { type: "setSolo"; solo: boolean }
  // Navigateur : nombre maximum de joueurs (0 = sans limite).
  | { type: "setMaxPlayers"; max: number }
  // Navigateur : mot tape sur la page par un joueur.
  | { type: "word"; word: string }
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
      source: Source;
      solo: boolean;
      maxPlayers: number;
      teamCount: number;
      teamNames: string[];
      players: PlayerDTO[];
      game: GameDTO | null;
    }
  | { type: "room_state"; players: PlayerDTO[]; hostPseudo: string; phase: Phase; mode: Mode; source: Source; solo: boolean; maxPlayers: number; teamCount: number; teamNames: string[] }
  | { type: "game_state"; game: GameDTO; event?: GameEvent }
  // Mot conforme a la regle mais refuse : affiche sous la caisse, pour que le
  // tchat comprenne pourquoi elle n'a pas bouge. En navigateur, un mot qui ne
  // respecte pas la regle est aussi signale ("rule") : il a ete tape expres.
  | { type: "reject"; by: string; word: string; teamId: number; reason: "used" | "unknown" | "not_joined" | "rule" }
  | {
      type: "finished";
      mode: Mode;
      source: Source;
      solo: boolean;
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

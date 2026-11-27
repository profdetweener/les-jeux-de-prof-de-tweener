/**
 * Protocole du Blind Test en navigateur.
 *
 * Chaque joueur ouvre le lien d'invitation, choisit un pseudo et tape ses
 * reponses dans sa propre case. Personne ne voit les reponses des autres :
 * tout le monde peut donc marquer sur le meme morceau, et les points
 * recompensent la vitesse (au temps, ou a l'ordre d'arrivee).
 *
 * Deroule d'une manche :
 *  - le serveur choisit le morceau et demande l'extrait a Deezer ;
 *  - il envoie l'adresse de l'extrait (sans titre ni artiste) et l'heure de
 *    depart : chaque navigateur le joue au meme moment ;
 *  - les reponses sont verifiees par le serveur, qui ne devoile titre et
 *    artiste qu'a la fin de la manche (ou au joueur qui vient de trouver) ;
 *  - revelation, puis manche suivante automatiquement.
 *
 * Le titre et l'artiste sont comptes a part, comme dans le mode tchat.
 */

export type Phase = "lobby" | "playing" | "finished";
export type Scoring = "temps" | "rang";
export type RoundStep = "loading" | "listening" | "reveal";

export interface StartConfig {
  rounds: number;        // nombre de manches
  duration: number;      // duree d'un extrait (s)
  tolerance: number;     // tolerance aux fautes (%)
  pop: number;           // notoriete minimale (0, 50, 75, 90)
  decades: number[];     // decennies retenues (vide = toutes)
  scoring: Scoring;
}

export interface PlayerDTO {
  pseudo: string;
  isHost: boolean;
  isConnected: boolean;
  teamId: number;        // 0 = chacun pour soi
}

// Une ligne du classement : un joueur, ou une equipe.
export interface ScoreDTO {
  id: string;            // pseudo, ou "t1", "t2"...
  name: string;
  color: number;         // index de couleur (equipes) ; -1 pour un joueur
  score: number;
  members: string[];     // equipes : leurs joueurs
  title: number | null;  // manche en cours : secondes pour trouver le titre (null = pas encore)
  artist: number | null;
  gain: number;          // points gagnes sur la manche en cours
}

export interface RevealDTO {
  title: string;
  artist: string;
  year: number | null;
  cover: string | null;
  // Qui a trouve quoi, dans l'ordre d'arrivee.
  found: Array<{ by: string; kind: "title" | "artist"; t: number; pts: number }>;
}

export interface HistoryDTO {
  n: number;
  title: string;
  artist: string;
  year: number | null;
  cover: string | null;
}

export interface GameDTO {
  solo: boolean;
  scoring: Scoring;
  round: number;          // 1..total
  total: number;
  step: RoundStep;
  duration: number;       // s
  preview: string | null; // adresse de l'extrait (pendant l'ecoute)
  startAt: number;        // debut de l'extrait (heure serveur)
  endsAt: number;         // fin de l'ecoute
  revealUntil: number | null;
  pausedAt: number | null; // heure serveur de la mise en pause, null si la partie tourne
  serverNow: number;
  scores: ScoreDTO[];
  reveal: RevealDTO | null;
  history: HistoryDTO[];  // du plus recent au plus ancien
  me: MeDTO | null;       // ce que le destinataire a trouve sur cette manche
  hostPseudo: string;
  devHint?: { title: string; artist: string };   // tests locaux uniquement
}

// Personnel : ce que j'ai (ou mon equipe a) trouve sur la manche en cours.
export interface MeDTO {
  title: { text: string; t: number; pts: number; by: string } | null;
  artist: { text: string; t: number; pts: number; by: string } | null;
}

export type ClientMessage =
  | { type: "join"; pseudo: string }
  | { type: "setSolo"; solo: boolean }
  | { type: "setTeamCount"; n: number }
  | { type: "setTeamName"; teamId: number; name: string }
  | { type: "setTeam"; pseudo: string; teamId: number }
  | { type: "shuffleTeams" }
  | { type: "start"; config: StartConfig }
  | { type: "answer"; text: string }
  | { type: "skip" }        // hote : passer ce morceau
  | { type: "pause"; paused: boolean }   // hote : pause / reprise
  | { type: "endGame" }
  | { type: "backToLobby" };

export type BtErrorCode =
  | "PSEUDO_INVALID" | "ROOM_FULL" | "NOT_HOST" | "WRONG_PHASE" | "INVALID_MESSAGE"
  | "NOT_ENOUGH_PLAYERS" | "NO_TRACKS" | "DEEZER";

export type ServerMessage =
  | {
      type: "joined";
      pseudo: string;
      isHost: boolean;
      hostPseudo: string;
      phase: Phase;
      solo: boolean;
      teamCount: number;
      teamNames: string[];
      players: PlayerDTO[];
      decades: number[];   // decennies presentes dans la playlist
      game: GameDTO | null;
    }
  | { type: "room_state"; players: PlayerDTO[]; hostPseudo: string; phase: Phase; solo: boolean; teamCount: number; teamNames: string[] }
  | { type: "game_state"; game: GameDTO }
  // Reponse a une proposition du joueur (a lui seul).
  | { type: "answer_result"; ok: boolean; title?: { text: string; t: number; pts: number }; artist?: { text: string; t: number; pts: number } }
  | {
      type: "finished";
      solo: boolean;
      scoring: Scoring;
      scores: ScoreDTO[];
      players: Array<{ name: string; teamId: number; titles: number; artists: number; points: number; best: number | null }>;
      history: HistoryDTO[];
      hostPseudo: string;
    }
  | { type: "error"; code: BtErrorCode; message: string };

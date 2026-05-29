/**
 * Motus — orchestrateur de la page de partie.
 *
 *   - Lit le code de room dans la query string
 *   - Recupere le pseudo depuis localStorage
 *   - Ouvre la WebSocket et envoie le `join`
 *   - Bascule entre les vues selon la phase de la room
 *   - Gere la connexion / reconnexion, les erreurs, les toasts
 *
 * Vues :
 *   - view-lobby      : attente avant la partie, config visible/editable
 *   - view-in-game    : un mot en cours, grille + clavier
 *   - view-between    : mot trouve ou epuise, "mot suivant" / "terminer"
 */

import { RoomConnection } from "../../shared/js/ws.js";
import { showToast } from "../../shared/js/toast.js";
import { initLobbyView } from "./view-lobby.js";
import { initGameView } from "./view-game.js";
import { initCompView } from "./view-comp.js";

const params = new URLSearchParams(window.location.search);

const storage = (() => {
  try {
    const test = "__test__";
    window.localStorage.setItem(test, "1");
    window.localStorage.removeItem(test);
    return window.localStorage;
  } catch {
    // Fallback memoire si localStorage indispo (mode privé strict)
    const mem = {};
    return {
      getItem: (k) => (k in mem ? mem[k] : null),
      setItem: (k, v) => { mem[k] = v; },
      removeItem: (k) => { delete mem[k]; },
    };
  }
})();

const roomCode = (params.get("code") || storage.getItem("motus_room") || "").toUpperCase();
const pseudo = storage.getItem("motus_pseudo") || "";

if (!roomCode || !pseudo) {
  // Pas de quoi rejoindre : retour a l'accueil
  window.location.href = "index.html";
}

const roomCodeDisplay = document.getElementById("room-code-display");
if (roomCodeDisplay) roomCodeDisplay.textContent = roomCode;

// =============================================================================
// Etat global de la page
// =============================================================================

const state = {
  pseudo,
  roomCode,
  isHost: false,
  hostPseudo: "",
  players: [],
  phase: "lobby",
  config: null,
  currentWord: null,   // WordState | null
};

const views = {
  lobby: document.getElementById("view-lobby"),
  in_game: document.getElementById("view-in-game"),
  between_words: document.getElementById("view-between"),
  in_round: document.getElementById("view-comp-game"),
  between_rounds: document.getElementById("view-comp-recap"),
  comp_final: document.getElementById("view-comp-final"),
};

function showView(phase) {
  let target = phase;
  // En mode comp, la phase serveur "finished" affiche le podium final.
  if (phase === "finished") {
    target = state.config?.mode === "competitive" ? "comp_final" : "lobby";
  }
  if (!views[target]) target = "lobby";
  for (const [name, el] of Object.entries(views)) {
    if (el) el.style.display = name === target ? "" : "none";
  }
}

// =============================================================================
// Connexion WebSocket
// =============================================================================

const conn = new RoomConnection(roomCode, "motus");

// Bandeau de statut connexion
const connectionStatusEl = document.getElementById("connection-status");
const statusDot = connectionStatusEl.querySelector(".dot");
const statusText = connectionStatusEl.querySelector(".text");

function setConnectionUI(status, detail) {
  // status: connecting | open | closed | error
  statusDot.className = `dot ${status}`;
  switch (status) {
    case "connecting": statusText.textContent = "connexion…"; break;
    case "open": statusText.textContent = "connecté"; break;
    case "closed": statusText.textContent = detail || "déconnecté"; break;
    case "error": statusText.textContent = detail || "erreur"; break;
    default: statusText.textContent = status;
  }
}

conn.onStatus((status, detail) => setConnectionUI(status, detail));

// =============================================================================
// Initialisation des vues
// =============================================================================

const lobbyView = initLobbyView(state, conn);
const gameView = initGameView(state, conn);
const compView = initCompView(state, conn);

// Met a jour le titre du header selon le mode de la room.
const roomTitleEl = document.getElementById("room-title");
function updateRoomTitle() {
  if (!roomTitleEl) return;
  const mode = state.config?.mode;
  if (mode === "competitive") {
    roomTitleEl.textContent = "🟥 Motus : mode compétitif ⚔️";
  } else if (mode === "coop_stream") {
    roomTitleEl.textContent = "🟥 Motus : mode chill 🏖️";
  } else {
    roomTitleEl.textContent = "🟥 Motus";
  }
}

// Mappage des messages serveur -> mises a jour de l'etat + des vues
conn.on("joined", (msg) => {
  state.pseudo = msg.pseudo;
  state.isHost = msg.isHost;
  state.hostPseudo = msg.hostPseudo;
  state.players = msg.players;
  state.phase = msg.phase;
  state.config = msg.config;
  state.currentWord = msg.currentWord;

  updateRoomTitle();
  lobbyView.refresh();
  gameView.refresh();

  // Reconnexion en pleine manche comp : on restaure la grille avant d'afficher
  if (state.phase === "in_round" && msg.compRound) {
    compView.restoreFromSnapshot(msg.compRound);
  }
  showView(state.phase);
});

conn.on("room_state", (msg) => {
  state.players = msg.players;
  state.hostPseudo = msg.hostPseudo;
  // Mettre a jour isHost : si on a ete promu apres depart de l'ancien hote
  state.isHost = msg.hostPseudo === state.pseudo;
  // Si la phase a change cote serveur (ex. retour lobby apres end_game)
  if (msg.phase !== state.phase) {
    state.phase = msg.phase;
    showView(state.phase);
  }
  lobbyView.refresh();
  gameView.refresh();
});

conn.on("config_update", (msg) => {
  state.config = msg.config;
  updateRoomTitle();
  lobbyView.refresh();
});

conn.on("word_started", (msg) => {
  state.phase = "in_game";
  state.currentWord = {
    firstLetter: msg.firstLetter,
    wordLength: msg.wordLength,
    attempts: [],
    maxAttempts: msg.maxAttempts,
    revealedWord: null,
    status: "in_progress",
    foundBy: null,
  };
  showView("in_game");
  gameView.onWordStarted();
});

conn.on("guess_resolved", (msg) => {
  if (!state.currentWord) return;
  state.currentWord.attempts[msg.attemptIndex] = msg.attempt;
  state.currentWord.status = msg.status;
  state.currentWord.revealedWord = msg.revealedWord;
  state.currentWord.foundBy = msg.foundBy;
  gameView.onGuessResolved(msg);

  if (msg.status !== "in_progress") {
    state.phase = "between_words";
    setTimeout(() => showView("between_words"), 1200);
  }
});

// ===== Messages mode COMPETITIVE =====
conn.on("round_started", (msg) => {
  state.phase = "in_round";
  showView("in_round");
  compView.onRoundStarted(msg);
});

conn.on("guess_result", (msg) => {
  compView.onGuessResult(msg);
});

conn.on("opponent_progress", (msg) => {
  compView.onOpponentProgress(msg);
});

conn.on("round_ended", (msg) => {
  state.phase = "between_rounds";
  compView.onRoundEnded(msg);
  // Si c'est la derniere manche, game_ended suit immediatement et affichera le
  // podium — on ne montre pas le recap intermediaire pour eviter un flash.
  if (!msg.isLastRound) {
    setTimeout(() => showView("between_rounds"), 1000);
  }
});

conn.on("game_ended", (msg) => {
  state.phase = "finished";
  compView.onGameEnded(msg);
  setTimeout(() => showView("finished"), 1200);
});

conn.on("kicked", (msg) => {
  storage.removeItem("motus_room");
  alert(`Tu as été kické : ${msg.reason || ""}`);
  window.location.href = "index.html";
});

conn.on("error", (msg) => {
  showToast(msg.message || "Erreur", { type: "error" });
});

// =============================================================================
// Lancement de la connexion
// =============================================================================

conn.connect();
conn.send({ type: "join", pseudo });

// Heartbeat applicatif : un ping toutes les 25s pour maintenir la connexion
setInterval(() => conn.send({ type: "ping" }), 25000);

// Safety net : pendant une manche compétitive, si la deadline serveur est
// dépassée et que round_ended/game_ended ne sont pas arrivés, on envoie des
// pings rapides. Le serveur, en recevant un ping en in_round + deadline
// dépassée, force la fin de manche.
setInterval(() => {
  if (state.phase !== "in_round") return;
  const deadline = compView?.getDeadlineTs?.();
  if (deadline === null || deadline === undefined) return;
  if (Date.now() >= deadline) {
    conn.send({ type: "ping" });
  }
}, 1500);

// =============================================================================
// Lien d'invitation
// =============================================================================

function buildInviteUrl(code) {
  const url = new URL(window.location.href);
  // Lien canonique : join.html#ABC123 (le code dans le hash, accueil en clair).
  url.pathname = url.pathname.replace(/room\.html$/, "join.html");
  url.search = "";
  url.hash = code;
  return url.toString();
}
const inviteUrl = buildInviteUrl(roomCode);
const inviteUrlEl = document.getElementById("invite-url");
if (inviteUrlEl) inviteUrlEl.textContent = inviteUrl;
const copyBtn = document.getElementById("copy-btn");
if (copyBtn) {
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      showToast("Lien copié !", { type: "success" });
    } catch {
      showToast("Impossible de copier — sélectionne manuellement.", { type: "error" });
    }
  });
}

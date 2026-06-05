/**
 * Orchestrateur principal de la page room.html — Definitions.
 *
 * Calque sur petitbac/js/lobby.js :
 *   - lit le code de room (URL) + le pseudo (storage)
 *   - ouvre la connexion WebSocket (slug "definitions")
 *   - maintient un objet `state` partage avec les vues
 *   - dispatche les messages serveur vers les vues
 *   - bascule entre les 5 vues (lobby / writing / voting / scoring / finished)
 */

import { RoomConnection } from "../../shared/js/ws.js";
import { showToast } from "../../shared/js/toast.js";
import { initLobbyView } from "./view-lobby.js";
import { initWritingView } from "./view-round.js";
import { initVotingView } from "./view-voting.js";
import { initScoringView } from "./view-scoring.js";
import { initFinishedView } from "./view-finished.js";

const params = new URLSearchParams(window.location.search);

const storage = (() => {
  function tryStorage(s) {
    try {
      const k = "__def_test__";
      s.setItem(k, "1");
      s.removeItem(k);
      return s;
    } catch {
      return null;
    }
  }
  return tryStorage(window.localStorage) ?? tryStorage(window.sessionStorage) ?? {
    _m: new Map(),
    getItem(k) { return this._m.get(k) ?? null; },
    setItem(k, v) { this._m.set(k, v); },
    removeItem(k) { this._m.delete(k); },
  };
})();

const roomCode = (params.get("code") || storage.getItem("definitions_room") || "").toUpperCase();
const pseudo = storage.getItem("definitions_pseudo") || "";
// Mode passe via ?mode= (uniquement pour l'hote qui CREE la room ; pour un
// invite, c'est null et le mode sera fixe par l'etat de la room recu en push).
const urlModeRaw = params.get("mode");
const urlMode = (urlModeRaw === "chill" || urlModeRaw === "competitive") ? urlModeRaw : null;

if (!roomCode || !pseudo) {
  window.location.href = "index.html";
}
storage.setItem("definitions_room", roomCode);

// ===========================================
// Etat partage avec les vues
// ===========================================

const state = {
  myPseudo: pseudo,
  isHost: false,
  hostPseudo: "",
  players: [],
  phase: "lobby",
  config: null,
  currentRound: 0,
  word: null,
  // Mode demande a la creation (uniquement pour l'hote, via ?mode= dans l'URL).
  // Pour un invite : null -> on prendra le mode de la room recue.
  createMode: urlMode,
};

// ===========================================
// Gestion des vues (clé = nom de phase serveur)
// ===========================================

const views = {
  lobby: document.getElementById("view-lobby"),
  writing: document.getElementById("view-writing"),
  voting: document.getElementById("view-voting"),
  scoring: document.getElementById("view-scoring"),
  finished: document.getElementById("view-finished"),
};

function showView(phase) {
  for (const [key, el] of Object.entries(views)) {
    if (el) el.style.display = key === phase ? "block" : "none";
  }
  // Stoppe le countdown si on quitte la phase d'écriture
  if (phase !== "writing" && state.stopWritingCountdown) {
    state.stopWritingCountdown();
  }
}

// ===========================================
// Initialisation
// ===========================================

const conn = new RoomConnection(roomCode, "definitions");

initLobbyView(state, conn, roomCode);
initWritingView(state, conn);
initVotingView(state, conn);
initScoringView(state, conn);
initFinishedView(state, conn);

// ===========================================
// Indicateur de connexion
// ===========================================

const connectionStatusEl = document.getElementById("connection-status");
conn.onStatus((status) => {
  connectionStatusEl.classList.remove("connected", "connecting", "disconnected");
  const textEl = connectionStatusEl.querySelector(".text");
  if (status === "open") {
    connectionStatusEl.classList.add("connected");
    textEl.textContent = "connecté";
    conn.send({ type: "join", pseudo: state.myPseudo });
  } else if (status === "connecting") {
    connectionStatusEl.classList.add("connecting");
    textEl.textContent = "connexion…";
  } else {
    connectionStatusEl.classList.add("disconnected");
    textEl.textContent = "déconnecté (reconnexion auto)";
  }
});

// ===========================================
// Dispatch des messages serveur
// ===========================================

conn.on("joined", (msg) => {
  state.isHost = msg.isHost;
  state.hostPseudo = msg.hostPseudo;
  state.players = msg.players;
  state.phase = msg.phase;
  state.config = msg.config;
  state.currentRound = msg.currentRound;
  state.word = msg.word;

  state.renderPlayers();
  state.clearError && state.clearError();

  if (msg.isHost && msg.phase === "lobby" && msg.config && state.applyConfigToHostInputs) {
    state.applyConfigToHostInputs(msg.config);
  }
  if (!msg.isHost && msg.phase === "lobby" && msg.config && state.applyGuestConfig) {
    state.applyGuestConfig(msg.config);
  }
  if (msg.isHost && msg.phase === "lobby" && state.pushHostConfigNow) {
    state.pushHostConfigNow();
  }

  // Reconstruire la vue active si on rejoint en cours de partie
  if (msg.phase === "writing" && msg.word && msg.config) {
    state.renderRoundStart({
      roundNumber: msg.currentRound,
      totalRounds: msg.config.totalRounds,
      word: msg.word,
      timerSeconds: msg.config.timerSeconds,
      roundEndsAt: msg.roundEndsAt ?? null,
      previousDefinition: msg.myDefinition ?? null,
    });
  } else if (msg.phase === "voting" && msg.currentResult) {
    state.renderVotingStart({
      reason: "all_locked",
      word: msg.currentResult.word,
      realDefinitions: msg.currentResult.realDefinitions,
      totalRounds: msg.config?.totalRounds ?? 0,
      result: msg.currentResult,
    });
  } else if (msg.phase === "scoring" && msg.currentResult) {
    state.renderScoring({
      totalRounds: msg.config?.totalRounds ?? 0,
      result: msg.currentResult,
      players: msg.players,
    });
  } else if (msg.phase === "finished" && msg.finalRanking) {
    state.renderFinished(msg.finalRanking);
  }

  showView(msg.phase);
});

conn.on("room_state", (msg) => {
  state.players = msg.players;
  state.hostPseudo = msg.hostPseudo;
  const me = msg.players.find((p) => p.pseudo === state.myPseudo);
  const wasHost = state.isHost;
  state.isHost = me ? me.isHost : false;

  if (!wasHost && state.isHost) {
    showToast("Tu es devenu l'hôte.", { type: "success" });
    if (state.phase === "lobby" && state.config && state.applyConfigToHostInputs) {
      state.applyConfigToHostInputs(state.config);
    }
    if (state.phase === "lobby" && state.pushHostConfigNow) {
      state.pushHostConfigNow();
    }
  }

  state.phase = msg.phase;

  if (msg.phase === "lobby") {
    state.renderPlayers();
  }
  if (state.refreshVotingHostState) state.refreshVotingHostState();
  if (state.refreshScoringHostState) state.refreshScoringHostState();
  if (state.refreshFinishedHostState) state.refreshFinishedHostState();

  // Si un joueur disparaît pendant voting/scoring, retirer sa ligne/contenu
  if (msg.phase === "voting" && state.refreshVotingTable) {
    state.refreshVotingTable();
  }
  if (msg.phase === "scoring" && state.refreshScoringTable) {
    state.refreshScoringTable();
  }

  showView(msg.phase);
});

conn.on("kicked", (msg) => {
  conn.close();
  showToast(`L'hôte t'a exclu de la partie. ${msg.reason ? "Raison : " + msg.reason : ""}`.trim(), { type: "error", duration: 3000 });
  setTimeout(() => { window.location.href = "index.html"; }, 2500);
});

conn.on("error", (msg) => {
  console.warn("Erreur serveur :", msg);
  switch (msg.code) {
    case "PSEUDO_TAKEN":
      state.showError && state.showError("Ce pseudo est déjà pris.");
      conn.close();
      setTimeout(() => (window.location.href = "index.html"), 2500);
      break;
    case "ROOM_FULL":
    case "ROOM_NOT_FOUND":
    case "PSEUDO_INVALID":
      state.showError && state.showError(msg.message || "Erreur.");
      conn.close();
      setTimeout(() => (window.location.href = "index.html"), 2500);
      break;
    case "WRONG_PHASE":
      if (state.phase === "lobby") {
        showToast(msg.message || "Action impossible dans cette phase.", { type: "error" });
      } else {
        state.showError && state.showError(msg.message || "Une partie est déjà en cours.");
        conn.close();
        setTimeout(() => (window.location.href = "index.html"), 2500);
      }
      break;
    case "NOT_HOST":
      showToast("Seul l'hôte peut faire ça.", { type: "error" });
      break;
    default:
      showToast(msg.message || "Erreur.", { type: "error" });
  }
});

conn.on("config_update", (msg) => {
  state.config = msg.config;
  if (!state.isHost && state.applyGuestConfig) {
    state.applyGuestConfig(msg.config);
  }
});

conn.on("round_started", (msg) => {
  state.phase = "writing";
  state.currentRound = msg.roundNumber;
  state.word = msg.word;
  if (state.config) state.config.totalRounds = msg.totalRounds ?? state.config.totalRounds;
  state.renderRoundStart(msg);
  showView("writing");
});

conn.on("definition_locked", (msg) => {
  if (state.onDefinitionLocked) state.onDefinitionLocked(msg.pseudo);
});

conn.on("round_ended", (msg) => {
  state.phase = "voting";
  if (state.config) state.config.totalRounds = msg.totalRounds ?? state.config.totalRounds;
  state.renderVotingStart(msg);
  showView("voting");
});

conn.on("vote_update", (msg) => {
  if (state.applyVoteUpdate) state.applyVoteUpdate(msg.votes);
});

conn.on("round_scored", (msg) => {
  state.phase = "scoring";
  state.players = msg.players;
  if (state.config) state.config.totalRounds = msg.totalRounds ?? state.config.totalRounds;
  state.renderScoring(msg);
  showView("scoring");
});

conn.on("game_finished", (msg) => {
  state.phase = "finished";
  state.renderFinished(msg.ranking);
  showView("finished");
});

// ===========================================
// Lien d'invitation
// ===========================================

function buildInviteUrl(code) {
  const origin = window.location.origin || "";
  let path = window.location.pathname || "/";
  if (path.endsWith("room.html")) {
    path = path.replace(/room\.html$/, "index.html");
  } else if (path.endsWith("/")) {
    path = path + "index.html";
  }
  return `${origin}${path}#${code}`;
}

const inviteUrl = buildInviteUrl(roomCode);
const inviteUrlEl = document.getElementById("invite-url");
if (inviteUrlEl) inviteUrlEl.textContent = inviteUrl;

const copyBtn = document.getElementById("copy-btn");
copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(inviteUrl);
    showToast("Lien copié !", { type: "success", duration: 1500 });
  } catch {
    if (inviteUrlEl) {
      const range = document.createRange();
      range.selectNode(inviteUrlEl);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      showToast("Sélectionne et copie le lien (Ctrl+C).", { duration: 2500 });
    } else {
      showToast("Impossible de copier automatiquement.", { type: "error" });
    }
  }
});

// ===========================================
// Cleanup + connexion
// ===========================================

window.addEventListener("beforeunload", () => {
  conn.close();
});

conn.connect();

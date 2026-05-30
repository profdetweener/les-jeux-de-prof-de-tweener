/**
 * Orchestrateur principal de la page room.html.
 *
 * Role :
 *   - lit le code de room (URL) et le pseudo (sessionStorage)
 *   - ouvre la connexion WebSocket via RoomConnection
 *   - maintient un objet `state` partage avec les vues
 *   - dispatche les messages serveur vers les modules de vue appropries
 *   - bascule entre les 5 vues (lobby / round / validating / scoring / finished)
 */

import { RoomConnection } from "../../shared/js/ws.js";
import { showToast } from "../../shared/js/toast.js";
import { initLobbyView } from "./view-lobby.js";
import { initRoundView } from "./view-round.js";
import { initValidatingView } from "./view-validating.js";
import { initScoringView } from "./view-scoring.js";
import { initFinishedView } from "./view-finished.js";

// ===========================================
// 1. Contexte initial
// ===========================================

const params = new URLSearchParams(window.location.search);

// --- Helper de stockage (meme implementation que home.js) ---
const storage = (() => {
  function tryStorage(s) {
    try {
      const k = "__pbac_test__";
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

const roomCode = (params.get("code") || storage.getItem("petitbac_room") || "").toUpperCase();
const pseudo = storage.getItem("petitbac_pseudo") || "";

if (!roomCode || !pseudo) {
  window.location.href = "index.html";
}

// On (re)stocke en localStorage : si l'utilisateur arrive ici via un lien
// direct (?code=XXX) sans passer par l'accueil, ca permet la reprise plus tard.
storage.setItem("petitbac_room", roomCode);

// ===========================================
// 2. Etat partage avec les vues
// ===========================================

const state = {
  myPseudo: pseudo,
  isHost: false,
  hostPseudo: "",
  players: [],
  phase: "lobby",
  config: null,
  currentRound: 0,
  letter: null,
  // Methodes implementees par les vues (renderPlayers, showError, ...)
};

// ===========================================
// 3. Gestion des vues
// ===========================================

const views = {
  lobby: document.getElementById("view-lobby"),
  in_round: document.getElementById("view-round"),
  validating: document.getElementById("view-validating"),
  scoring: document.getElementById("view-scoring"),
  finished: document.getElementById("view-finished"),
};

function showView(phase) {
  for (const [key, el] of Object.entries(views)) {
    el.style.display = key === phase ? "block" : "none";
  }
  // Stop le countdown si on quitte in_round
  if (phase !== "in_round" && state.stopRoundCountdown) {
    state.stopRoundCountdown();
  }
}

// ===========================================
// 4. Initialisation des vues
// ===========================================

const conn = new RoomConnection(roomCode, "petitbac");

initLobbyView(state, conn, roomCode);
initRoundView(state, conn);
initValidatingView(state, conn);
initScoringView(state, conn);
initFinishedView(state, conn);

// ===========================================
// 5. Indicateur de connexion
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
// 6. Dispatch des messages serveur
// ===========================================

conn.on("joined", (msg) => {
  state.isHost = msg.isHost;
  state.hostPseudo = msg.hostPseudo;
  state.players = msg.players;
  state.phase = msg.phase;
  state.config = msg.config;
  state.currentRound = msg.currentRound;
  state.letter = msg.letter;

  state.renderPlayers();
  state.clearError && state.clearError();

  // Si je suis host et qu'une config existe deja (cas migration host en lobby),
  // synchroniser mes inputs avec la config courante
  if (msg.isHost && msg.phase === "lobby" && msg.config && state.applyConfigToHostInputs) {
    state.applyConfigToHostInputs(msg.config);
  }
  // Si je ne suis pas host et qu'une config existe deja, l'afficher en lecture seule
  if (!msg.isHost && msg.phase === "lobby" && msg.config && state.applyGuestConfig) {
    state.applyGuestConfig(msg.config);
  }

  // Si je suis host et qu'on est en lobby, pousser immediatement ma config
  // courante au serveur. Ca couvre :
  //   - le 1er chargement de la page (server.config = null au demarrage)
  //   - une migration d'hote (l'ancien hote a quitte, le nouveau pousse sa
  //     config locale, qui peut differer de la derniere connue du serveur)
  // De cette facon, les futurs joueurs qui rejoignent voient bien la config.
  if (msg.isHost && msg.phase === "lobby" && state.pushHostConfigNow) {
    state.pushHostConfigNow();
  }

  // Si on rejoint en cours de partie, reconstruire l'etat de la vue active
  if (msg.phase === "in_round" && msg.letter && msg.config) {
    state.renderRoundStart({
      roundNumber: msg.currentRound,
      totalRounds: msg.config.totalRounds,
      letter: msg.letter,
      categories: msg.config.categories,
      timerSeconds: msg.config.timerSeconds,
      roundEndsAt: msg.roundEndsAt ?? Date.now(),
      // Reconnexion / refresh : pre-remplit la grille avec les reponses
      // que le serveur a deja recues de notre part. null si on n'avait
      // rien envoye, ou si on rejoint pour la premiere fois en cours
      // de manche (on n'aura alors pas encore d'historique).
      previousAnswers: msg.myAnswers ?? null,
    });
  } else if (msg.phase === "validating" && msg.currentResult) {
    // Reconnexion mid-validating : on derive le reason a partir du stoppedBy connu
    // sur le RoundResult (au lieu de hardcoder "all_submitted").
    const derivedReason = msg.currentResult.stoppedBy ? "stop" : "all_submitted";
    state.renderValidationStart({
      reason: derivedReason,
      stoppedBy: msg.currentResult.stoppedBy,
      categories: msg.config?.categories ?? [],
      totalRounds: msg.config?.totalRounds ?? 0,
      result: msg.currentResult,
    });
  } else if (msg.phase === "scoring" && msg.currentResult) {
    state.renderScoring({
      categories: msg.config?.categories ?? [],
      totalRounds: msg.config?.totalRounds ?? 0,
      result: msg.currentResult,
      players: msg.players,
    });
  } else if (msg.phase === "finished" && msg.finalRanking) {
    // Memoriser les lettres tirees pour la prochaine partie (joueur arrivant
    // alors qu'une partie vient de se terminer). Accumulation par roomCode.
    if (Array.isArray(msg.drawnLetters) && state.saveLastGameLetters) {
      state.saveLastGameLetters(msg.drawnLetters, roomCode);
    }
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
    // Migration d'hote en lobby : nos inputs affichaient la version "guest"
    // (lecture seule). On les synchronise avec la derniere config connue
    // pour que le nouvel hote reprenne exactement la config qui etait
    // en cours d'edition, et non les defauts locaux (sinon on perdrait
    // par exemple les categories ajoutees, le bareme modifie, etc.).
    if (state.phase === "lobby" && state.config && state.applyConfigToHostInputs) {
      state.applyConfigToHostInputs(state.config);
    }
    // Puis on pousse cette config au serveur pour rester source de verite
    // et pour que les futurs joueurs la voient bien.
    if (state.phase === "lobby" && state.pushHostConfigNow) {
      state.pushHostConfigNow();
    }
  }

  state.phase = msg.phase;

  // Le rendu depend de la phase active
  if (msg.phase === "lobby") {
    state.renderPlayers();
    // Si on est l'hote qui revient au lobby apres une partie, rafraichir
    // le rendu des lettres pour afficher le badge "dernieres lettres".
    if (state.isHost && state.refreshLobbyLettersFromStorage) {
      state.refreshLobbyLettersFromStorage();
    }
  }
  // Mettre a jour l'affichage des actions host pour les autres vues
  if (state.refreshValidationHostState) state.refreshValidationHostState();
  if (state.refreshScoringHostState) state.refreshScoringHostState();
  if (state.refreshFinishedHostState) state.refreshFinishedHostState();

  // Si un joueur a disparu (kick mid-game ou deconnexion definitive) pendant
  // validating/scoring, on demande aux vues de retirer sa ligne. Sans ca, la
  // grille resterait affichee avec son contenu (potentiellement obscene)
  // jusqu'au prochain round_started.
  if (msg.phase === "validating" && state.refreshValidationTable) {
    state.refreshValidationTable();
  }
  if (msg.phase === "scoring" && state.refreshScoringTable) {
    state.refreshScoringTable();
  }

  showView(msg.phase);
});

conn.on("kicked", (msg) => {
  conn.close();
  // Toast plutot qu'alert : moins agressif, et on laisse 2.5 s au joueur
  // pour lire la raison avant la redirection.
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
      // Cas typique : on essaie de rejoindre une partie en cours
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
    case "TARGET_NOT_FOUND":
    case "CANNOT_KICK_SELF":
    case "ALREADY_SUBMITTED":
    case "INVALID_CONFIG":
    case "NOT_ENOUGH_PLAYERS":
      showToast(msg.message || "Erreur.", { type: "error" });
      break;
    default:
      showToast(msg.message || "Erreur inconnue.", { type: "error" });
  }
});

// === Phase 4 ===

conn.on("config_update", (msg) => {
  console.log("[lobby] config_update reçu", {
    isHost: state.isHost,
    myPseudo: state.myPseudo,
    hasConfig: !!msg.config,
    categoriesLen: msg.config?.categories?.length ?? 0,
  });
  // Diffuse par le host : on met a jour notre state.config et la vue lecture seule
  state.config = msg.config;
  if (!state.isHost && state.applyGuestConfig) {
    state.applyGuestConfig(msg.config);
  }
});

conn.on("round_started", (msg) => {
  state.phase = "in_round";
  state.currentRound = msg.roundNumber;
  state.letter = msg.letter;
  // Garde la config a jour avec les donnees du message (defensif)
  if (msg.categories && state.config) {
    state.config.categories = msg.categories;
    state.config.totalRounds = msg.totalRounds ?? state.config.totalRounds;
  }
  state.renderRoundStart(msg);
  showView("in_round");
});

conn.on("answers_received", (msg) => {
  if (state.onAnswersReceived) state.onAnswersReceived(msg.pseudo);
});

conn.on("round_ended", (msg) => {
  state.phase = "validating";
  if (msg.categories && state.config) {
    state.config.categories = msg.categories;
    state.config.totalRounds = msg.totalRounds ?? state.config.totalRounds;
  }
  state.renderValidationStart(msg);
  showView("validating");
});

conn.on("cell_state_update", (msg) => {
  if (state.applyCellStateUpdate) state.applyCellStateUpdate(msg.cellStates);
});

conn.on("cheater_cheats_update", (msg) => {
  if (state.applyCheaterCountUpdate) state.applyCheaterCountUpdate(msg.count);
});

conn.on("round_scored", (msg) => {
  state.phase = "scoring";
  state.players = msg.players;
  if (msg.categories && state.config) {
    state.config.categories = msg.categories;
    state.config.totalRounds = msg.totalRounds ?? state.config.totalRounds;
  }
  state.renderScoring(msg);
  showView("scoring");
});

conn.on("game_finished", (msg) => {
  state.phase = "finished";
  // Memoriser les lettres tirees pour la prochaine partie (UI lobby host).
  // On accumule par roomCode : tant qu'on reste dans la meme room, les
  // lettres s'ajoutent au fil des parties successives.
  if (Array.isArray(msg.drawnLetters) && state.saveLastGameLetters) {
    state.saveLastGameLetters(msg.drawnLetters, roomCode);
  }
  state.renderFinished(msg.ranking);
  showView("finished");
});

// ===========================================
// 7. Bouton "Copier le lien d'invitation"
// ===========================================

/**
 * Construit l'URL d'invitation a partager.
 *
 * On part de window.location.origin + window.location.pathname, et on remplace
 * room.html par index.html, puis on ajoute #CODE en hash.
 * Exemple :
 *   https://profdetweener.github.io/petitbac/room.html?code=ABC123
 *   -> https://profdetweener.github.io/petitbac/index.html#ABC123
 */
function buildInviteUrl(code) {
  const origin = window.location.origin || "";
  let path = window.location.pathname || "/";
  // On normalise : room.html -> index.html. Si la page est servie sans nom de
  // fichier (path se termine par "/"), on ajoute index.html par securite.
  if (path.endsWith("room.html")) {
    path = path.replace(/room\.html$/, "index.html");
  } else if (path.endsWith("/")) {
    path = path + "index.html";
  }
  return `${origin}${path}#${code}`;
}

const inviteUrl = buildInviteUrl(roomCode);

// Affichage du lien dans le bandeau de la room
const inviteUrlEl = document.getElementById("invite-url");
if (inviteUrlEl) inviteUrlEl.textContent = inviteUrl;

const copyBtn = document.getElementById("copy-btn");
copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(inviteUrl);
    showToast("Lien copié !", { type: "success", duration: 1500 });
  } catch {
    // Fallback : on selectionne le span avec l'URL pour copier a la main
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
// 8. Cleanup
// ===========================================

window.addEventListener("beforeunload", () => {
  conn.close();
});

// ===========================================
// 9. Connexion
// ===========================================

conn.connect();

/**
 * Vue Lobby Motus :
 *   - Liste des joueurs
 *   - Config de la partie (longueur du mot, nombre d'essais) — editable host
 *   - Bouton "Demarrer" pour l'hote
 */

import { showToast } from "../../shared/js/toast.js";

const MIN_WORD_LEN = 5;
const MAX_WORD_LEN = 10;
const MIN_ATTEMPTS = 4;
const MAX_ATTEMPTS = 8;
const DEFAULT_CONFIG = { wordLength: 7, maxAttempts: 6, mode: "coop_stream" };

export function initLobbyView(state, conn) {
  const playerListEl = document.getElementById("player-list");
  const playerCountEl = document.getElementById("player-count");

  const wordLengthInput = document.getElementById("word-length-input");
  const maxAttemptsInput = document.getElementById("max-attempts-input");
  const wordLengthDisplay = document.getElementById("word-length-display");
  const maxAttemptsDisplay = document.getElementById("max-attempts-display");
  const hostConfigEl = document.getElementById("host-config");
  const guestConfigEl = document.getElementById("guest-config");
  const startBtn = document.getElementById("start-btn");
  const startHintEl = document.getElementById("start-hint");

  // Etat local
  const localConfig = { ...DEFAULT_CONFIG };
  let pushTimer = null;

  function pushConfigSoon() {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = null;
      conn.send({ type: "config_update", config: localConfig });
    }, 200);
  }

  function clampInt(v, min, max, fallback) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  wordLengthInput.addEventListener("input", () => {
    localConfig.wordLength = clampInt(wordLengthInput.value, MIN_WORD_LEN, MAX_WORD_LEN, 7);
    pushConfigSoon();
  });
  wordLengthInput.addEventListener("change", () => {
    wordLengthInput.value = String(localConfig.wordLength);
  });

  maxAttemptsInput.addEventListener("input", () => {
    localConfig.maxAttempts = clampInt(maxAttemptsInput.value, MIN_ATTEMPTS, MAX_ATTEMPTS, 6);
    pushConfigSoon();
  });
  maxAttemptsInput.addEventListener("change", () => {
    maxAttemptsInput.value = String(localConfig.maxAttempts);
  });

  startBtn.addEventListener("click", () => {
    if (!state.isHost) return;
    if (state.players.length < 2) {
      showToast("Il faut au moins 2 joueurs pour démarrer.", { type: "error" });
      return;
    }
    conn.send({ type: "start_game", config: localConfig });
  });

  function refresh() {
    // Liste joueurs
    playerCountEl.textContent = state.players.length;
    playerListEl.innerHTML = "";
    for (const p of state.players) {
      const li = document.createElement("li");
      li.className = "player-item";
      const label = document.createElement("span");
      label.className = "player-name";
      label.textContent = p.pseudo;
      if (p.isHost) {
        const tag = document.createElement("span");
        tag.className = "player-tag host";
        tag.textContent = "hôte";
        label.appendChild(tag);
      }
      if (!p.isConnected) {
        const tag = document.createElement("span");
        tag.className = "player-tag offline";
        tag.textContent = "déconnecté";
        label.appendChild(tag);
      }
      li.appendChild(label);

      // Bouton kick (uniquement pour l'hote, et pas sur soi-meme)
      if (state.isHost && p.pseudo !== state.pseudo) {
        const kick = document.createElement("button");
        kick.className = "btn btn-secondary btn-sm";
        kick.textContent = "kick";
        kick.title = `Retirer ${p.pseudo}`;
        kick.addEventListener("click", () => {
          if (confirm(`Kicker ${p.pseudo} ?`)) {
            conn.send({ type: "kick", targetPseudo: p.pseudo });
          }
        });
        li.appendChild(kick);
      }
      playerListEl.appendChild(li);
    }

    // Config
    if (state.config) {
      // Si le serveur nous envoie une config qu'on n'a pas encore vue, on l'adopte
      if (
        state.config.wordLength !== localConfig.wordLength ||
        state.config.maxAttempts !== localConfig.maxAttempts
      ) {
        Object.assign(localConfig, state.config);
        wordLengthInput.value = String(localConfig.wordLength);
        maxAttemptsInput.value = String(localConfig.maxAttempts);
      }
    }
    wordLengthDisplay.textContent = localConfig.wordLength;
    maxAttemptsDisplay.textContent = localConfig.maxAttempts;

    if (state.isHost) {
      hostConfigEl.style.display = "";
      guestConfigEl.style.display = "none";
      startBtn.style.display = "";
      startBtn.disabled = state.players.length < 2;
      startHintEl.textContent =
        state.players.length < 2
          ? "Au moins 2 joueurs requis (le mode coop est conçu pour le stream)."
          : "Tu vas saisir les essais. Les autres regardent et proposent à l'oral / dans le chat.";
    } else {
      hostConfigEl.style.display = "none";
      guestConfigEl.style.display = "";
      startBtn.style.display = "none";
      startHintEl.textContent =
        `${state.hostPseudo || "L'hôte"} va lancer la partie. Tu suivras la grille en direct.`;
    }
  }

  return { refresh };
}

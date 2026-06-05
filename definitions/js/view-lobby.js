/**
 * Vue "lobby" — Definitions.
 * Liste des joueurs + configuration (hôte) ou visualisation (invité).
 */

import { LIMITS, AGGREGATION_LABELS, AGGREGATION_HINTS, MODE_LABELS } from "./constants.js";
import { showToast } from "../../shared/js/toast.js";

export function initLobbyView(state, conn, roomCode) {
  const playersListEl = document.getElementById("players-list");
  const playersCountEl = document.getElementById("players-count");
  const hostActionsEl = document.getElementById("host-actions");
  const guestConfigEl = document.getElementById("guest-config");
  const errorBox = document.getElementById("error-box");

  // Inputs hôte
  const modeInputs = Array.from(document.querySelectorAll("input[name='mode-input']"));
  const modeToggleEl = document.querySelector(".mode-toggle");
  const modeLabelEl = document.getElementById("mode-locked-label");
  const modePillEl = document.getElementById("host-mode-pill");
  const modePillValEl = document.getElementById("host-mode-pill-value");
  const competOnlyEls = Array.from(document.querySelectorAll("[data-only-mode='competitive']"));
  const chillBanner = document.getElementById("chill-mode-banner");
  const roundsInput = document.getElementById("rounds-input");
  const roundsUnlimitedInput = document.getElementById("rounds-unlimited-input");
  const timerInput = document.getElementById("timer-input");
  const aggregationInput = document.getElementById("aggregation-input");
  const aggregationHint = document.getElementById("aggregation-hint");
  const startBtn = document.getElementById("btn-start-game");

  // Affichage invité
  const guestMode = document.getElementById("guest-mode");
  const guestRounds = document.getElementById("guest-rounds");
  const guestTimer = document.getElementById("guest-timer");
  const guestAggregation = document.getElementById("guest-aggregation");
  const guestCompetOnly = Array.from(document.querySelectorAll("[data-guest-only-mode='competitive']"));

  let configPushTimer = null;

  function currentMode() {
    // Si le mode a ete fige a la creation (via ?mode=), il prime sur les radios
    if (state.createMode === "chill" || state.createMode === "competitive") {
      return state.createMode;
    }
    const el = modeInputs.find((i) => i.checked);
    return el ? el.value : "competitive";
  }

  function applyModeVisibility() {
    const mode = currentMode();
    const isChill = mode === "chill";
    for (const el of competOnlyEls) {
      el.style.display = isChill ? "none" : "";
    }
    if (chillBanner) chillBanner.style.display = isChill ? "block" : "none";
    // Pill mode (affichee a l'hote)
    if (modePillEl && modePillValEl) {
      modePillValEl.textContent = isChill ? "Chill 🛋️" : "Compétitif ⚔️";
      modePillEl.classList.toggle("mode-chill", isChill);
      modePillEl.classList.toggle("mode-compet", !isChill);
    }
  }

  // Verrouille le mode s'il a ete fixe par l'URL (i.e. par le picker).
  // On masque le toggle radio et on affiche un label/pill en lecture seule.
  function applyLockedModeIfAny() {
    const locked = state.createMode === "chill" || state.createMode === "competitive";
    if (!locked) return;
    for (const r of modeInputs) r.checked = r.value === state.createMode;
    if (modeToggleEl) modeToggleEl.style.display = "none";
    if (modeLabelEl) modeLabelEl.style.display = "none";
    if (modePillEl) modePillEl.style.display = "inline-flex";
  }

  // --- Rendu de la liste des joueurs ---
  state.renderPlayers = function () {
    const players = state.players;
    playersCountEl.textContent = `${players.length} joueur${players.length > 1 ? "s" : ""}`;
    playersListEl.innerHTML = "";
    for (const p of players) {
      const li = document.createElement("li");
      li.className = "player-item";
      if (p.isHost) li.classList.add("is-host");
      if (p.pseudo === state.myPseudo) li.classList.add("is-self");
      if (!p.isConnected) li.classList.add("disconnected");

      const info = document.createElement("div");
      info.className = "player-info";
      const name = document.createElement("span");
      name.textContent = p.pseudo;
      info.appendChild(name);
      if (p.isHost) {
        const b = document.createElement("span");
        b.className = "player-badge host";
        b.textContent = "Hôte";
        info.appendChild(b);
      }
      if (p.pseudo === state.myPseudo) {
        const b = document.createElement("span");
        b.className = "player-badge self";
        b.textContent = "Toi";
        info.appendChild(b);
      }
      if (!p.isConnected) {
        const b = document.createElement("span");
        b.className = "player-badge disconnected";
        b.textContent = "Hors ligne";
        info.appendChild(b);
      }
      li.appendChild(info);

      // Bouton kick (hôte uniquement, sur les autres)
      if (state.isHost && p.pseudo !== state.myPseudo) {
        const kickBtn = document.createElement("button");
        kickBtn.className = "btn btn-danger btn-sm";
        kickBtn.textContent = "Exclure";
        kickBtn.addEventListener("click", () => {
          if (confirm(`Exclure ${p.pseudo} de la partie ?`)) {
            conn.send({ type: "kick", targetPseudo: p.pseudo });
          }
        });
        li.appendChild(kickBtn);
      }
      playersListEl.appendChild(li);
    }

    // Affiche le bon panneau de config selon le rôle
    if (state.isHost) {
      hostActionsEl.style.display = "block";
      guestConfigEl.style.display = "none";
    } else {
      hostActionsEl.style.display = "none";
      guestConfigEl.style.display = "block";
      if (state.config) state.applyGuestConfig(state.config);
    }
  };

  state.showError = function (msg) {
    errorBox.textContent = msg;
    errorBox.classList.add("show");
  };
  state.clearError = function () {
    errorBox.classList.remove("show");
    errorBox.textContent = "";
  };

  // --- Construction de la config depuis les inputs ---
  function buildConfig() {
    const mode = currentMode();

    const unlimited = roundsUnlimitedInput.checked;
    let totalRounds = unlimited ? 0 : parseInt(roundsInput.value, 10);
    if (!Number.isFinite(totalRounds) || totalRounds < 0) totalRounds = 5;
    if (totalRounds > LIMITS.MAX_ROUNDS) totalRounds = LIMITS.MAX_ROUNDS;

    let timerSeconds = parseInt(timerInput.value, 10);
    if (!Number.isFinite(timerSeconds)) timerSeconds = LIMITS.DEFAULT_TIMER_SEC;
    timerSeconds = Math.max(LIMITS.MIN_TIMER_SEC, Math.min(LIMITS.MAX_TIMER_SEC, timerSeconds));

    const aggregation = ["robust", "mean", "median"].includes(aggregationInput.value)
      ? aggregationInput.value
      : "robust";

    // En chill, on force l'illimite (le worker fera pareil mais autant ne pas
    // tromper l'invite cote affichage).
    if (mode === "chill") totalRounds = 0;

    return { mode, totalRounds, timerSeconds, aggregation };
  }

  function updateAggregationHint() {
    const v = aggregationInput.value;
    aggregationHint.textContent = AGGREGATION_HINTS[v] ?? "";
  }

  // --- Pousse la config courante au serveur (live) ---
  state.pushHostConfigNow = function () {
    if (!state.isHost) return;
    const config = buildConfig();
    state.config = config;
    conn.send({ type: "config_update", config });
  };

  function scheduleConfigPush() {
    if (!state.isHost) return;
    updateAggregationHint();
    applyModeVisibility();
    if (configPushTimer) clearTimeout(configPushTimer);
    configPushTimer = setTimeout(() => state.pushHostConfigNow(), 300);
  }

  // --- Applique une config aux inputs hôte (migration d'hôte) ---
  state.applyConfigToHostInputs = function (config) {
    if (!config) return;
    const mode = config.mode === "chill" ? "chill" : "competitive";
    for (const r of modeInputs) r.checked = r.value === mode;
    if (config.totalRounds === 0) {
      roundsUnlimitedInput.checked = true;
      roundsInput.disabled = true;
    } else {
      roundsUnlimitedInput.checked = false;
      roundsInput.disabled = false;
      roundsInput.value = config.totalRounds;
    }
    timerInput.value = config.timerSeconds;
    // Compat ascendante : si une vieille config "trimmed" arrive, on bascule sur robust
    const agg = config.aggregation === "trimmed" ? "robust" : config.aggregation;
    aggregationInput.value = agg;
    updateAggregationHint();
    applyModeVisibility();
  };

  // --- Affiche une config en lecture seule (invité) ---
  state.applyGuestConfig = function (config) {
    if (!config) return;
    const mode = config.mode === "chill" ? "chill" : "competitive";
    const isChill = mode === "chill";
    if (guestMode) guestMode.textContent = MODE_LABELS[mode] ?? mode;
    guestRounds.textContent = config.totalRounds === 0 ? "Illimité" : String(config.totalRounds);
    guestTimer.textContent = isChill ? "Désactivé" : `${config.timerSeconds} sec`;
    const aggKey = config.aggregation === "trimmed" ? "robust" : config.aggregation;
    guestAggregation.textContent = AGGREGATION_LABELS[aggKey] ?? aggKey;
    for (const el of guestCompetOnly) {
      el.style.display = isChill ? "none" : "";
    }
  };

  // --- Écouteurs sur les inputs hôte ---
  for (const r of modeInputs) {
    r.addEventListener("change", scheduleConfigPush);
  }
  roundsUnlimitedInput.addEventListener("change", () => {
    roundsInput.disabled = roundsUnlimitedInput.checked;
    scheduleConfigPush();
  });
  for (const el of [roundsInput, timerInput]) {
    el.addEventListener("input", scheduleConfigPush);
  }
  aggregationInput.addEventListener("change", scheduleConfigPush);

  updateAggregationHint();
  applyLockedModeIfAny();
  applyModeVisibility();

  // --- Démarrer la partie ---
  startBtn.addEventListener("click", () => {
    const connected = state.players.filter((p) => p.isConnected).length;
    if (connected < 2) {
      showToast("Il faut au moins 2 joueurs connectés.", { type: "error" });
      return;
    }
    conn.send({ type: "start_game", config: buildConfig() });
  });
}

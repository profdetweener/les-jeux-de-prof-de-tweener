/**
 * Vue Lobby Motus — gere les deux modes (coop_stream / competitive).
 *
 * Le mode est determine par state.config.mode au moment du premier `joined`.
 * Il est fige : la room a ete creee en coop OU en comp, on ne switche pas
 * en cours de session. Cette vue se contente d'afficher le bon panneau de
 * config selon ce mode.
 *
 * Architecture interne :
 *   - `coopConfig` : etat local de la config coop, push debounce 200ms
 *   - `compConfig` : etat local de la config comp, idem
 *   - `refresh()` : reconcile l'UI avec state.players / state.config
 *
 * Mode coop : longueur + nb essais, identique a v8.
 *
 * Mode comp : presets + reglages communs + bloc "avance" replie.
 *   - Cliquer sur un preset met TOUS les champs aux valeurs du preset
 *     (sauf wordLength/maxAttempts qui restent libres).
 *   - Cliquer sur "Custom" deplie le bloc avance et laisse tout libre.
 *   - Modifier manuellement un champ du bloc avance bascule en preset "custom"
 *     automatiquement (le serveur refuserait un preset non-custom si les
 *     valeurs ne matchent pas exactement).
 */

import { showToast } from "../../shared/js/toast.js";

const MIN_WORD_LEN = 5;
const MAX_WORD_LEN = 10;
const MIN_ATTEMPTS = 4;
const MAX_ATTEMPTS = 8;

// Doit matcher COMP_PRESETS cote worker. Si ces valeurs changent cote serveur,
// les modifier ici aussi (et le serveur refusera de toute facon les configs
// incoherentes avec son propre preset, donc on est protege).
const COMP_PRESETS = {
  speed: {
    endCondition: "first_finds",
    timerSeconds: null,
    scoring: "binary",
    format: "fixed_rounds",
    maxRounds: 5,
  },
  chrono: {
    endCondition: "timer_only",
    timerSeconds: 90,
    scoring: "combo",
    format: "fixed_rounds",
    maxRounds: 5,
  },
  marathon: {
    endCondition: "everyone_done",
    timerSeconds: null,
    scoring: "attempts_left",
    format: "unlimited",
    maxRounds: 0,
  },
};

const DEFAULT_COOP = { wordLength: 7, maxAttempts: 6, mode: "coop_stream" };
const DEFAULT_COMP = {
  wordLength: 7,
  maxAttempts: 6,
  mode: "competitive",
  preset: "speed",
  ...COMP_PRESETS.speed,
  pointsTarget: 10,
};

// Libelles pour le resume cote guest.
const END_CONDITION_LABELS = {
  first_finds: "Premier qui trouve",
  everyone_done: "Tout le monde finit",
  timer_only: "À la fin du timer",
};
const SCORING_LABELS = {
  position: "Position (3/2/1)",
  binary: "Binaire (1er = 1 pt)",
  attempts_left: "Essais restants",
  combo: "Combiné (essais + bonus)",
};
const FORMAT_LABELS = {
  fixed_rounds: "Manches fixes",
  unlimited: "Manches illimitées",
  first_to_points: "Premier à X points",
};
const PRESET_LABELS = {
  speed: "⚡ Speed",
  chrono: "⏱️ Chrono",
  marathon: "🏃 Marathon",
  custom: "🛠️ Custom",
};

export function initLobbyView(state, conn) {
  // =========================================================================
  // Refs DOM communes
  // =========================================================================
  const playerListEl = document.getElementById("player-list");
  const playerCountEl = document.getElementById("player-count");
  const startBtn = document.getElementById("start-btn");
  const startHintEl = document.getElementById("start-hint");

  const configCoopEl = document.getElementById("config-coop");
  const configCompEl = document.getElementById("config-comp");

  // Refs mode coop
  const hostCoopEl = document.getElementById("host-config");
  const guestCoopEl = document.getElementById("guest-config");
  const wordLengthInput = document.getElementById("word-length-input");
  const maxAttemptsInput = document.getElementById("max-attempts-input");
  const wordLengthDisplay = document.getElementById("word-length-display");
  const maxAttemptsDisplay = document.getElementById("max-attempts-display");

  // Refs mode comp
  const hostCompEl = document.getElementById("host-comp-config");
  const guestCompEl = document.getElementById("guest-comp-config");
  const presetButtons = Array.from(document.querySelectorAll(".preset-card[data-preset]"));
  const compWordLengthInput = document.getElementById("comp-word-length-input");
  const compMaxAttemptsInput = document.getElementById("comp-max-attempts-input");
  const advancedBlock = document.getElementById("advanced-block");
  const endConditionSel = document.getElementById("comp-end-condition");
  const scoringSel = document.getElementById("comp-scoring");
  const timerSel = document.getElementById("comp-timer-seconds");
  const formatSel = document.getElementById("comp-format");
  const maxRoundsInput = document.getElementById("comp-max-rounds");
  const pointsTargetInput = document.getElementById("comp-points-target");
  const formGroupMaxRounds = document.getElementById("form-group-max-rounds");
  const formGroupPointsTarget = document.getElementById("form-group-points-target");
  const guestCompSummary = document.getElementById("guest-comp-summary");

  // =========================================================================
  // Etat local et debounce des push de config
  // =========================================================================
  const coopConfig = { ...DEFAULT_COOP };
  const compConfig = { ...DEFAULT_COMP };
  let pushTimer = null;

  function pushConfigSoon() {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = null;
      const cfg = state.config?.mode === "competitive" ? compConfig : coopConfig;
      conn.send({ type: "config_update", config: cfg });
    }, 200);
  }

  function clampInt(v, min, max, fallback) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  // =========================================================================
  // Handlers config COOP
  // =========================================================================

  wordLengthInput.addEventListener("input", () => {
    coopConfig.wordLength = clampInt(wordLengthInput.value, MIN_WORD_LEN, MAX_WORD_LEN, 7);
    pushConfigSoon();
  });
  wordLengthInput.addEventListener("change", () => {
    wordLengthInput.value = String(coopConfig.wordLength);
  });
  maxAttemptsInput.addEventListener("input", () => {
    coopConfig.maxAttempts = clampInt(maxAttemptsInput.value, MIN_ATTEMPTS, MAX_ATTEMPTS, 6);
    pushConfigSoon();
  });
  maxAttemptsInput.addEventListener("change", () => {
    maxAttemptsInput.value = String(coopConfig.maxAttempts);
  });

  // =========================================================================
  // Handlers config COMP
  // =========================================================================

  // --- Presets ---
  for (const btn of presetButtons) {
    btn.addEventListener("click", () => {
      const preset = btn.dataset.preset;
      applyPreset(preset);
      pushConfigSoon();
    });
  }

  function applyPreset(preset) {
    compConfig.preset = preset;
    if (preset !== "custom") {
      // On applique les valeurs du preset
      const p = COMP_PRESETS[preset];
      if (p) {
        compConfig.endCondition = p.endCondition;
        compConfig.timerSeconds = p.timerSeconds;
        compConfig.scoring = p.scoring;
        compConfig.format = p.format;
        compConfig.maxRounds = p.maxRounds;
      }
    }
    // En mode custom : le bloc avance s'affiche. Sinon il reste masque.
    updateAdvancedVisibility();
    syncCompUIFromConfig();
    updatePresetButtonsUI();
  }

  // --- Champs communs (longueur, essais) ---
  compWordLengthInput.addEventListener("input", () => {
    compConfig.wordLength = clampInt(compWordLengthInput.value, MIN_WORD_LEN, MAX_WORD_LEN, 7);
    pushConfigSoon();
  });
  compWordLengthInput.addEventListener("change", () => {
    compWordLengthInput.value = String(compConfig.wordLength);
  });
  compMaxAttemptsInput.addEventListener("input", () => {
    compConfig.maxAttempts = clampInt(compMaxAttemptsInput.value, MIN_ATTEMPTS, MAX_ATTEMPTS, 6);
    pushConfigSoon();
  });
  compMaxAttemptsInput.addEventListener("change", () => {
    compMaxAttemptsInput.value = String(compConfig.maxAttempts);
  });

  // --- Visibilite du bloc avance : uniquement en preset Custom ---
  function updateAdvancedVisibility() {
    advancedBlock.hidden = compConfig.preset !== "custom";
  }

  // --- Champs du bloc avance ---
  // Modifier l'un quelconque bascule automatiquement en preset "custom",
  // car les valeurs ne matchent plus le preset selectionne.
  function onAdvancedFieldChanged() {
    compConfig.preset = "custom";
    updatePresetButtonsUI();
    pushConfigSoon();
  }

  endConditionSel.addEventListener("change", () => {
    compConfig.endCondition = endConditionSel.value;
    // Applique les regles de coherence (scorings autorises, timer obligatoire)
    applyCoherenceRules();
    onAdvancedFieldChanged();
  });
  scoringSel.addEventListener("change", () => {
    compConfig.scoring = scoringSel.value;
    onAdvancedFieldChanged();
  });
  timerSel.addEventListener("change", () => {
    const v = timerSel.value;
    compConfig.timerSeconds = v === "" ? null : parseInt(v, 10);
    onAdvancedFieldChanged();
  });
  formatSel.addEventListener("change", () => {
    compConfig.format = formatSel.value;
    updateFormatFieldsVisibility();
    onAdvancedFieldChanged();
  });
  maxRoundsInput.addEventListener("input", () => {
    compConfig.maxRounds = clampInt(maxRoundsInput.value, 1, 50, 5);
    onAdvancedFieldChanged();
  });
  maxRoundsInput.addEventListener("change", () => {
    maxRoundsInput.value = String(compConfig.maxRounds);
  });
  pointsTargetInput.addEventListener("input", () => {
    compConfig.pointsTarget = clampInt(pointsTargetInput.value, 1, 100, 10);
    onAdvancedFieldChanged();
  });
  pointsTargetInput.addEventListener("change", () => {
    pointsTargetInput.value = String(compConfig.pointsTarget);
  });

  // =========================================================================
  // Regles de coherence entre parametres
  // =========================================================================
  //
  // La condition de fin de manche contraint les scorings possibles :
  //   - first_finds   : on ne connait que le gagnant -> binary OU attempts_left
  //                     (les deux ne concernent que le 1er). Timer optionnel
  //                     (agit comme limite : personne ne trouve = manche nulle).
  //   - everyone_done : on connait tout le monde -> tous les scorings. Timer
  //                     optionnel (securite anti-AFK).
  //   - timer_only    : tout le monde joue jusqu'au bout -> tous les scorings.
  //                     Timer OBLIGATOIRE (c'est le coeur du mode).
  const ALLOWED_SCORINGS = {
    first_finds: ["binary", "attempts_left"],
    everyone_done: ["position", "attempts_left", "combo", "binary"],
    timer_only: ["position", "attempts_left", "combo", "binary"],
  };

  /**
   * Applique les contraintes de coherence apres un changement de endCondition :
   *   1. grise les options de scoring non autorisees
   *   2. si le scoring courant n'est plus autorise, bascule sur le 1er autorise
   *   3. rend le timer obligatoire si endCondition === timer_only (retire l'option
   *      "Aucun" et force une valeur par defaut si besoin)
   */
  function applyCoherenceRules() {
    const allowed = ALLOWED_SCORINGS[compConfig.endCondition] || ["binary"];

    // 1+2. Grise les <option> de scoring non autorisees
    for (const opt of scoringSel.options) {
      const ok = allowed.includes(opt.value);
      opt.disabled = !ok;
    }
    if (!allowed.includes(compConfig.scoring)) {
      compConfig.scoring = allowed[0];
      scoringSel.value = compConfig.scoring;
    }

    // 3. Timer obligatoire en mode timer_only
    const timerRequired = compConfig.endCondition === "timer_only";
    // L'option "Aucun" (value="") est desactivee si le timer est requis
    for (const opt of timerSel.options) {
      if (opt.value === "") opt.disabled = timerRequired;
    }
    if (timerRequired && (compConfig.timerSeconds === null || compConfig.timerSeconds === undefined)) {
      compConfig.timerSeconds = 90;
      timerSel.value = "90";
    }
  }

  // =========================================================================
  // Sync UI <-> compConfig
  // =========================================================================

  function syncCompUIFromConfig() {
    compWordLengthInput.value = String(compConfig.wordLength);
    compMaxAttemptsInput.value = String(compConfig.maxAttempts);
    endConditionSel.value = compConfig.endCondition;
    scoringSel.value = compConfig.scoring;
    timerSel.value = compConfig.timerSeconds === null || compConfig.timerSeconds === undefined
      ? ""
      : String(compConfig.timerSeconds);
    formatSel.value = compConfig.format;
    maxRoundsInput.value = String(compConfig.maxRounds || 5);
    pointsTargetInput.value = String(compConfig.pointsTarget || 10);
    updateFormatFieldsVisibility();
    // Reapplique le grisage a chaque sync (preset applique, config serveur recue...)
    applyCoherenceRules();
  }

  function updateFormatFieldsVisibility() {
    formGroupMaxRounds.style.display = compConfig.format === "fixed_rounds" ? "" : "none";
    formGroupPointsTarget.style.display = compConfig.format === "first_to_points" ? "" : "none";
  }

  function updatePresetButtonsUI() {
    for (const btn of presetButtons) {
      const isActive = btn.dataset.preset === compConfig.preset;
      btn.classList.toggle("is-active", isActive);
      btn.setAttribute("aria-checked", isActive ? "true" : "false");
    }
  }

  // =========================================================================
  // Bouton "Demarrer la partie"
  // =========================================================================

  startBtn.addEventListener("click", () => {
    if (!state.isHost) return;
    if (state.players.length < 2) {
      showToast("Il faut au moins 2 joueurs pour démarrer.", { type: "error" });
      return;
    }
    const cfg = state.config?.mode === "competitive" ? compConfig : coopConfig;
    conn.send({ type: "start_game", config: cfg });
  });

  // =========================================================================
  // refresh() : appele a chaque changement d'etat (joined, room_state, config_update)
  // =========================================================================

  function refresh() {
    // --- Liste joueurs ---
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
      if (state.isHost && p.pseudo !== state.pseudo) {
        const kick = document.createElement("button");
        kick.className = "btn btn-secondary btn-sm";
        kick.textContent = "Retirer";
        kick.title = `Retirer ${p.pseudo} du salon`;
        kick.addEventListener("click", () => {
          if (confirm(`Retirer ${p.pseudo} du salon ?`)) {
            conn.send({ type: "kick", targetPseudo: p.pseudo });
          }
        });
        li.appendChild(kick);
      }
      playerListEl.appendChild(li);
    }

    // --- Determine le mode actif (depend de la room) ---
    const mode = state.config?.mode || "coop_stream";

    // --- Affiche le bon bloc de config ---
    configCoopEl.style.display = mode === "coop_stream" ? "" : "none";
    configCompEl.style.display = mode === "competitive" ? "" : "none";

    if (mode === "coop_stream") {
      refreshCoop();
    } else {
      refreshComp();
    }

    // --- Bouton demarrer ---
    if (state.isHost) {
      startBtn.style.display = "";
      startBtn.disabled = state.players.length < 2;
      if (mode === "coop_stream") {
        startHintEl.textContent =
          state.players.length < 2
            ? "Au moins 2 joueurs requis (le mode coop est conçu pour le stream)."
            : "Tu vas saisir les essais. Les autres regardent et proposent à l'oral / dans le chat.";
      } else {
        startHintEl.textContent =
          state.players.length < 2
            ? "Au moins 2 joueurs requis."
            : "La mécanique de partie compétitive arrive bientôt. La config est validée et synchronisée entre joueurs.";
      }
    } else {
      startBtn.style.display = "none";
      startHintEl.textContent =
        `${state.hostPseudo || "L'hôte"} va lancer la partie.`;
    }
  }

  function refreshCoop() {
    if (state.isHost) {
      hostCoopEl.style.display = "";
      guestCoopEl.style.display = "none";
    } else {
      hostCoopEl.style.display = "none";
      guestCoopEl.style.display = "";
    }
    // Sync coopConfig <- state.config si serveur l'a poussee
    if (state.config && state.config.mode === "coop_stream") {
      if (
        state.config.wordLength !== coopConfig.wordLength ||
        state.config.maxAttempts !== coopConfig.maxAttempts
      ) {
        coopConfig.wordLength = state.config.wordLength;
        coopConfig.maxAttempts = state.config.maxAttempts;
        wordLengthInput.value = String(coopConfig.wordLength);
        maxAttemptsInput.value = String(coopConfig.maxAttempts);
      }
    }
    wordLengthDisplay.textContent = coopConfig.wordLength;
    maxAttemptsDisplay.textContent = coopConfig.maxAttempts;
  }

  function refreshComp() {
    if (state.isHost) {
      hostCompEl.style.display = "";
      guestCompEl.style.display = "none";
    } else {
      hostCompEl.style.display = "none";
      guestCompEl.style.display = "";
    }
    // Sync compConfig <- state.config si serveur l'a poussee
    if (state.config && state.config.mode === "competitive") {
      // On adopte la config serveur si elle diverge sur n'importe quel champ
      // pertinent. NB : maxRounds n'est pertinent que pour format=fixed_rounds,
      // et pointsTarget que pour format=first_to_points — comparer en dehors de
      // ces cas creerait des fausses divergences (le serveur renvoie 0 quand
      // c'est inapplicable).
      const s = state.config;
      const sMaxRounds = s.format === "fixed_rounds" ? s.maxRounds : null;
      const cMaxRounds = compConfig.format === "fixed_rounds" ? compConfig.maxRounds : null;
      const sPointsTarget = s.format === "first_to_points" ? s.pointsTarget : null;
      const cPointsTarget = compConfig.format === "first_to_points" ? compConfig.pointsTarget : null;
      const diverges =
        s.wordLength !== compConfig.wordLength ||
        s.maxAttempts !== compConfig.maxAttempts ||
        (s.preset ?? "custom") !== compConfig.preset ||
        s.endCondition !== compConfig.endCondition ||
        (s.timerSeconds ?? null) !== (compConfig.timerSeconds ?? null) ||
        s.scoring !== compConfig.scoring ||
        s.format !== compConfig.format ||
        sMaxRounds !== cMaxRounds ||
        sPointsTarget !== cPointsTarget;
      if (diverges) {
        Object.assign(compConfig, {
          wordLength: s.wordLength,
          maxAttempts: s.maxAttempts,
          preset: s.preset ?? "custom",
          endCondition: s.endCondition,
          timerSeconds: s.timerSeconds ?? null,
          scoring: s.scoring,
          format: s.format,
          maxRounds: s.format === "fixed_rounds" && s.maxRounds ? s.maxRounds : compConfig.maxRounds,
          pointsTarget: s.format === "first_to_points" && s.pointsTarget ? s.pointsTarget : compConfig.pointsTarget,
        });
        syncCompUIFromConfig();
        updatePresetButtonsUI();
        updateAdvancedVisibility();
      }
    } else {
      // Pas encore de config serveur : on initialise les inputs depuis compConfig
      syncCompUIFromConfig();
      updatePresetButtonsUI();
      updateAdvancedVisibility();
    }

    // Resume pour les guests
    if (!state.isHost) {
      renderGuestCompSummary();
    }
  }

  function renderGuestCompSummary() {
    const items = [
      ["Préset", PRESET_LABELS[compConfig.preset] || "—"],
      ["Mot", `${compConfig.wordLength} lettres, ${compConfig.maxAttempts} essais`],
      ["Fin de manche", END_CONDITION_LABELS[compConfig.endCondition] || "—"],
      ["Score", SCORING_LABELS[compConfig.scoring] || "—"],
      ["Timer", compConfig.timerSeconds ? `${compConfig.timerSeconds}s` : "—"],
      ["Format", FORMAT_LABELS[compConfig.format] || "—"],
    ];
    if (compConfig.format === "fixed_rounds") {
      items.push(["Manches", String(compConfig.maxRounds)]);
    } else if (compConfig.format === "first_to_points") {
      items.push(["Seuil", `${compConfig.pointsTarget} pts`]);
    }
    guestCompSummary.innerHTML = "";
    for (const [k, v] of items) {
      const li = document.createElement("li");
      const ks = document.createElement("span");
      ks.className = "summary-key";
      ks.textContent = k;
      const vs = document.createElement("span");
      vs.className = "summary-val";
      vs.textContent = v;
      li.appendChild(ks);
      li.appendChild(vs);
      guestCompSummary.appendChild(li);
    }
  }

  // Init initiale des selects/inputs au chargement (avant le premier joined)
  syncCompUIFromConfig();
  updatePresetButtonsUI();
  updateAdvancedVisibility();

  return { refresh };
}

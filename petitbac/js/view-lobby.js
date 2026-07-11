/**
 * Vue "lobby" : liste des joueurs, code de room, configuration de partie.
 *
 * Deux modes selon que le joueur est host ou non :
 *   - host   : edite la config, chaque modif est diffusee aux autres via config_update
 *   - autre  : voit la config en lecture seule, mise a jour en temps reel
 */

import { CATEGORY_PRESETS, LIMITS, describeLengthConstraint } from "./constants.js";
import { showToast } from "../../shared/js/toast.js";

export function initLobbyView(state, conn, currentRoomCode) {
  // --- References DOM (host) ---
  const playersListEl = document.getElementById("players-list");
  const playersCountEl = document.getElementById("players-count");
  const hostActionsEl = document.getElementById("host-actions");
  const guestConfigEl = document.getElementById("guest-config");
  const errorBox = document.getElementById("error-box");
  const infoBox = document.getElementById("info-box");
  const presetsContainer = document.getElementById("categories-presets");
  const customInput = document.getElementById("custom-category-input");
  const addCategoryBtn = document.getElementById("add-category-btn");
  const selectedList = document.getElementById("categories-selected");
  const roundsInput = document.getElementById("rounds-input");
  const roundsUnlimitedInput = document.getElementById("rounds-unlimited-input");
  const timerInput = document.getElementById("timer-input");
  const endModeInput = document.getElementById("end-mode-input");
  const lengthValueInput = document.getElementById("length-value-input");
  const lengthUnitLabel = document.getElementById("length-unit-label");
  const lengthModeRadios = document.querySelectorAll('input[name="length-mode"]');
  const scoreInputs = {
    aloneInCategory: document.getElementById("score-alone"),
    uniqueAnswer: document.getElementById("score-unique"),
    duplicateAnswer: document.getElementById("score-duplicate"),
    invalidOrEmpty: document.getElementById("score-invalid"),
    cheaterPenaltyPerCheat: document.getElementById("score-cheater"),
  };
  const startGameBtn = document.getElementById("btn-start-game");

  // --- References DOM lettres (host) ---
  const lettersGridEl = document.getElementById("letters-grid");
  const lettersSelectAllBtn = document.getElementById("letters-select-all");
  const lettersSelectNoneBtn = document.getElementById("letters-select-none");
  const lettersSelectDefaultBtn = document.getElementById("letters-select-default");
  const lettersDeselectLastBtn = document.getElementById("letters-deselect-last");
  const lettersLastInfoEl = document.getElementById("letters-last-info");

  // --- References DOM (guest) ---
  const guestEls = {
    categories: document.getElementById("guest-categories"),
    rounds: document.getElementById("guest-rounds"),
    timer: document.getElementById("guest-timer"),
    endMode: document.getElementById("guest-end-mode"),
    scoreAlone: document.getElementById("guest-score-alone"),
    scoreUnique: document.getElementById("guest-score-unique"),
    scoreDuplicate: document.getElementById("guest-score-duplicate"),
    scoreInvalid: document.getElementById("guest-score-invalid"),
    scoreCheater: document.getElementById("guest-score-cheater"),
    lengthConstraint: document.getElementById("guest-length-constraint"),
    letters: document.getElementById("guest-letters"),
  };

  // --- Constantes lettres ---
  // Alphabet francais complet (26 lettres) pour les chips de selection
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  // Pool par defaut (mirror de ROUND_CONFIG.LETTERS cote serveur)
  const DEFAULT_POOL = "ABCDEFGHIJLMNOPRSTUV";

  // --- Etat local de la config (host uniquement) ---
  const localCategories = new Set();
  // Lettres autorisees pour le tirage. Initialisees au DEFAULT_POOL.
  const localLetters = new Set(DEFAULT_POOL.split(""));
  // Lettres tirees lors de la derniere partie (memorisees en localStorage).
  // Sert a afficher le bouton "Desactiver les lettres de la derniere partie".
  let lastGameLetters = [];

  // --- Mini helper localStorage (best-effort, fallback in-memory) ---
  const lobbyStorage = (() => {
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

  function loadLastGameLetters() {
    try {
      const raw = lobbyStorage.getItem("petitbac_last_letters");
      if (!raw) return { roomCode: null, letters: [] };
      const parsed = JSON.parse(raw);
      // Support de l'ancien format (array nu) pour les sessions deja en cours
      if (Array.isArray(parsed)) {
        return {
          roomCode: null,
          letters: parsed.filter((l) => typeof l === "string" && /^[A-Z]$/.test(l)),
        };
      }
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.letters)) {
        return {
          roomCode: typeof parsed.roomCode === "string" ? parsed.roomCode : null,
          letters: parsed.letters.filter((l) => typeof l === "string" && /^[A-Z]$/.test(l)),
        };
      }
      return { roomCode: null, letters: [] };
    } catch {
      return { roomCode: null, letters: [] };
    }
  }
  /**
   * Sauvegarde les lettres tirees lors d'une partie.
   *
   * Accumule les lettres tant qu'on reste dans la meme room (memes joueurs,
   * meme code). Si on detecte un changement de roomCode, on repart de zero.
   */
  function saveLastGameLetters(newLetters, roomCode) {
    try {
      const stored = loadLastGameLetters();
      let acc;
      if (stored.roomCode && stored.roomCode === roomCode) {
        // Meme room : on accumule (sans doublon, en preservant l'ordre d'apparition)
        const seen = new Set(stored.letters);
        acc = [...stored.letters];
        for (const l of newLetters) {
          if (typeof l === "string" && /^[A-Z]$/.test(l) && !seen.has(l)) {
            seen.add(l);
            acc.push(l);
          }
        }
      } else {
        // Room differente ou inconnue : on repart de zero
        const seen = new Set();
        acc = [];
        for (const l of newLetters) {
          if (typeof l === "string" && /^[A-Z]$/.test(l) && !seen.has(l)) {
            seen.add(l);
            acc.push(l);
          }
        }
      }
      lobbyStorage.setItem(
        "petitbac_last_letters",
        JSON.stringify({ roomCode: roomCode ?? null, letters: acc })
      );
    } catch {
      /* silencieux : pas grave si le storage refuse */
    }
  }
  // Expose pour pouvoir l'appeler depuis lobby.js a la fin d'une partie
  state.saveLastGameLetters = saveLastGameLetters;
  // Lit les lettres déjà sorties UNIQUEMENT si elles concernent la room courante.
  // Sinon (premiere partie de cette room, ou changement de room), on retourne [].
  // Ca evite que les lettres d'une room precedente s'affichent par erreur au
  // demarrage d'une nouvelle room.
  function loadLettersForCurrentRoom() {
    const stored = loadLastGameLetters();
    if (!stored.roomCode || !currentRoomCode) return [];
    if (stored.roomCode !== currentRoomCode) return [];
    return stored.letters;
  }
  // Expose pour rafraichir l'affichage des badges "lettres déjà sorties" quand
  // l'host revient au lobby apres une partie (les lettres viennent d'etre
  // memorisees en storage via game_finished).
  state.refreshLobbyLettersFromStorage = function () {
    lastGameLetters = loadLettersForCurrentRoom();
    renderLettersHost();
  };
  lastGameLetters = loadLettersForCurrentRoom();

  // --- Debounce pour ne pas spammer le serveur a chaque keystroke ---
  let pushConfigTimeoutId = null;
  function pushConfigSoon() {
    if (!state.isHost) return;
    if (pushConfigTimeoutId) clearTimeout(pushConfigTimeoutId);
    pushConfigTimeoutId = setTimeout(() => {
      const cfg = buildCurrentConfig();
      // BUG FIX : l'hote ne recoit pas son propre config_update du serveur
      // (broadcast excluding host), donc state.config restait sur la version
      // du snapshot initial. On la met a jour localement ici.
      state.config = cfg;
      conn.send({ type: "config_update", config: cfg });
    }, 150);
  }

  // Push immediat (utilise quand l'hote vient d'etre confirme via `joined`
  // ou via une migration d'hote, pour etre sur que le serveur ait notre
  // config avant que d'autres joueurs ne rejoignent).
  function pushConfigNow() {
    if (!state.isHost) return;
    if (pushConfigTimeoutId) {
      clearTimeout(pushConfigTimeoutId);
      pushConfigTimeoutId = null;
    }
    const cfg = buildCurrentConfig();
    state.config = cfg;
    conn.send({ type: "config_update", config: cfg });
  }
  state.pushHostConfigNow = pushConfigNow;

  function buildCurrentConfig() {
    // Nombre de manches : 0 = illimité côté protocole serveur.
    // Si la case "Illimité" est cochée, on force 0. Sinon on lit l'input
    // (et on garantit au minimum 1 manche pour ne pas envoyer une partie
    // vide par erreur de saisie).
    let totalRounds;
    if (roundsUnlimitedInput && roundsUnlimitedInput.checked) {
      totalRounds = 0;
    } else {
      const parsed = parseInt(roundsInput.value, 10);
      totalRounds = Number.isFinite(parsed) && parsed >= 1 ? parsed : 5;
    }
    const timerSeconds = parseInt(timerInput.value, 10);
    // L'utilisateur saisit un nombre positif (0-100). On le convertit en valeur
    // negative (= malus) pour le protocole serveur. Tolerant : si l'utilisateur
    // a saisi un negatif par erreur, on prend la valeur absolue.
    let cheaterRaw = parseInt(scoreInputs.cheaterPenaltyPerCheat.value, 10);
    if (!Number.isFinite(cheaterRaw)) cheaterRaw = 0;
    const cheaterAbs = Math.max(0, Math.min(100, Math.abs(cheaterRaw)));
    const cheaterPenaltyPerCheat = -cheaterAbs; // <= 0 cote serveur
    const scoring = {
      aloneInCategory: parseInt(scoreInputs.aloneInCategory.value, 10) || 0,
      uniqueAnswer: parseInt(scoreInputs.uniqueAnswer.value, 10) || 0,
      duplicateAnswer: parseInt(scoreInputs.duplicateAnswer.value, 10) || 0,
      invalidOrEmpty: parseInt(scoreInputs.invalidOrEmpty.value, 10) || 0,
      cheaterPenaltyPerCheat,
    };
    const endModeRaw = endModeInput.value;
    const endMode = endModeRaw === "timer_only" ? "timer_only" : "stop_or_timer";
    // Pool de lettres : on assemble en ordre alphabetique pour stabilite
    const letterPool = ALPHABET
      .split("")
      .filter((l) => localLetters.has(l))
      .join("");
    // Contrainte de longueur : lit le radio coche + l'input numerique.
    // En mode "none", on n'envoie pas du tout le champ (retro-compat avec
    // les anciens clients / le serveur qui traite l'absence comme "none").
    const lengthMode = (() => {
      for (const r of lengthModeRadios) {
        if (r.checked) return r.value;
      }
      return "none";
    })();
    let lengthConstraint = null;
    if (lengthMode === "min" || lengthMode === "max") {
      let v = parseInt(lengthValueInput.value, 10);
      if (!Number.isFinite(v)) v = lengthMode === "min" ? 4 : 8;
      v = Math.max(LIMITS.MIN_WORD_LEN_BOUND, Math.min(LIMITS.MAX_WORD_LEN_BOUND, v));
      lengthConstraint = { mode: lengthMode, value: v };
    }
    return {
      categories: [...localCategories],
      totalRounds,
      timerSeconds: Number.isFinite(timerSeconds) ? timerSeconds : 90,
      scoring,
      endMode,
      letterPool,
      ...(lengthConstraint ? { lengthConstraint } : {}),
    };
  }

  // --- Rendu des chips presets ---
  for (const cat of CATEGORY_PRESETS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "category-preset-btn";
    btn.textContent = cat;
    btn.dataset.category = cat;
    btn.addEventListener("click", () => {
      if (localCategories.has(cat)) {
        localCategories.delete(cat);
      } else {
        if (localCategories.size >= LIMITS.MAX_CATEGORIES) {
          showToast(`Max ${LIMITS.MAX_CATEGORIES} catégories.`, { type: "error" });
          return;
        }
        localCategories.add(cat);
      }
      renderCategoriesHost();
      pushConfigSoon();
    });
    presetsContainer.appendChild(btn);
  }

  function renderCategoriesHost() {
    for (const btn of presetsContainer.children) {
      btn.classList.toggle("selected", localCategories.has(btn.dataset.category));
    }
    selectedList.innerHTML = "";
    for (const cat of localCategories) {
      const li = document.createElement("li");
      li.textContent = cat;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.title = "Retirer";
      remove.addEventListener("click", () => {
        localCategories.delete(cat);
        renderCategoriesHost();
        pushConfigSoon();
      });
      li.appendChild(remove);
      selectedList.appendChild(li);
    }
  }

  // ==========================================================
  // Section "Lettres a utiliser" (host)
  // ==========================================================

  // Build initial : un chip par lettre de l'alphabet
  if (lettersGridEl) {
    for (const letter of ALPHABET) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "letter-btn";
      btn.dataset.letter = letter;
      btn.textContent = letter;
      btn.addEventListener("click", () => {
        if (localLetters.has(letter)) {
          if (localLetters.size <= 1) {
            showToast("Il faut au moins une lettre.", { type: "error" });
            return;
          }
          localLetters.delete(letter);
        } else {
          localLetters.add(letter);
        }
        renderLettersHost();
        pushConfigSoon();
      });
      lettersGridEl.appendChild(btn);
    }
  }

  function renderLettersHost() {
    if (!lettersGridEl) return;
    const lastSet = new Set(lastGameLetters);
    for (const btn of lettersGridEl.children) {
      const letter = btn.dataset.letter;
      btn.classList.toggle("selected", localLetters.has(letter));
      btn.classList.toggle("was-last-game", lastSet.has(letter));
    }
    // Affiche ou cache le bouton et le texte d'info "derniere partie"
    if (lettersDeselectLastBtn) {
      // Visible seulement s'il y a des lettres déjà sorties ET qu'au moins
      // une de ces lettres est actuellement selectionnee (sinon le bouton
      // ne ferait rien).
      const hasOverlap = lastGameLetters.some((l) => localLetters.has(l));
      lettersDeselectLastBtn.style.display = hasOverlap ? "" : "none";
    }
    if (lettersLastInfoEl) {
      if (lastGameLetters.length > 0) {
        lettersLastInfoEl.style.display = "";
        const sorted = [...lastGameLetters].sort();
        lettersLastInfoEl.textContent = `Lettres déjà sorties dans cette room : ${sorted.join(" ")}`;
      } else {
        lettersLastInfoEl.style.display = "none";
      }
    }
  }

  // Boutons d'action (toutes / aucune / defaut / desactiver les dernieres)
  if (lettersSelectAllBtn) {
    lettersSelectAllBtn.addEventListener("click", () => {
      localLetters.clear();
      for (const l of ALPHABET) localLetters.add(l);
      renderLettersHost();
      pushConfigSoon();
    });
  }
  if (lettersSelectNoneBtn) {
    lettersSelectNoneBtn.addEventListener("click", () => {
      // On garde au moins une lettre : A (sinon le serveur refusera la config).
      localLetters.clear();
      localLetters.add("A");
      renderLettersHost();
      pushConfigSoon();
    });
  }
  if (lettersSelectDefaultBtn) {
    lettersSelectDefaultBtn.addEventListener("click", () => {
      localLetters.clear();
      for (const l of DEFAULT_POOL) localLetters.add(l);
      renderLettersHost();
      pushConfigSoon();
    });
  }
  if (lettersDeselectLastBtn) {
    lettersDeselectLastBtn.addEventListener("click", () => {
      for (const l of lastGameLetters) localLetters.delete(l);
      // Garde-fou : si on se retrouve avec 0 lettre, on remet A
      if (localLetters.size === 0) localLetters.add("A");
      renderLettersHost();
      pushConfigSoon();
    });
  }

  function renderLettersGuest(letterPool) {
    if (!guestEls.letters) return;
    const pool = (typeof letterPool === "string" ? letterPool : DEFAULT_POOL)
      .toUpperCase().replace(/[^A-Z]/g, "");
    const poolSet = new Set(pool.split(""));
    guestEls.letters.innerHTML = "";
    for (const letter of ALPHABET) {
      const span = document.createElement("span");
      span.className = "letter-btn";
      if (poolSet.has(letter)) span.classList.add("selected");
      span.textContent = letter;
      guestEls.letters.appendChild(span);
    }
  }

  // --- Ajout categorie libre ---
  function addCustomCategory() {
    const value = customInput.value.trim();
    if (!value) return;
    if (value.length > 30) {
      showToast("Catégorie trop longue (max 30 caractères).", { type: "error" });
      return;
    }
    if (localCategories.size >= LIMITS.MAX_CATEGORIES) {
      showToast(`Max ${LIMITS.MAX_CATEGORIES} catégories.`, { type: "error" });
      return;
    }
    if ([...localCategories].some((c) => c.toLowerCase() === value.toLowerCase())) {
      showToast("Catégorie déjà sélectionnée.", { type: "error" });
      return;
    }
    localCategories.add(value);
    customInput.value = "";
    renderCategoriesHost();
    pushConfigSoon();
  }

  addCategoryBtn.addEventListener("click", addCustomCategory);
  customInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addCustomCategory();
    }
  });

  // --- Push de config a chaque modif des autres champs ---
  for (const el of [roundsInput, timerInput, endModeInput, ...Object.values(scoreInputs)]) {
    el.addEventListener("change", pushConfigSoon);
    el.addEventListener("input", pushConfigSoon);
  }

  // --- Contrainte de longueur : radio + input numerique ---
  // Le numero est grise si "Aucune", actif sinon. Le label dynamique ("min" /
  // "max" / "-") aide a la lisibilite.
  function syncLengthConstraintUI() {
    let mode = "none";
    for (const r of lengthModeRadios) {
      if (r.checked) {
        mode = r.value;
        break;
      }
    }
    lengthValueInput.disabled = mode === "none";
    if (lengthUnitLabel) {
      lengthUnitLabel.textContent = mode === "none" ? "lettres" : `lettres (${mode})`;
    }
  }
  for (const r of lengthModeRadios) {
    r.addEventListener("change", () => {
      syncLengthConstraintUI();
      pushConfigSoon();
    });
  }
  lengthValueInput.addEventListener("input", pushConfigSoon);
  lengthValueInput.addEventListener("change", pushConfigSoon);
  syncLengthConstraintUI();

  // --- Case "Illimité" pour le nombre de manches ---
  // Quand elle est cochée, l'input "nombre de manches" est grisé et ignoré
  // (totalRounds = 0 côté protocole).
  function syncRoundsUnlimitedUI() {
    if (!roundsUnlimitedInput) return;
    const unlimited = roundsUnlimitedInput.checked;
    roundsInput.disabled = unlimited;
  }
  if (roundsUnlimitedInput) {
    roundsUnlimitedInput.addEventListener("change", () => {
      syncRoundsUnlimitedUI();
      pushConfigSoon();
    });
  }
  syncRoundsUnlimitedUI();

  // --- Pre-selection : 5 categories classiques par defaut ---
  for (const c of ["Pays", "Ville", "Animal", "Prenom", "Metier"]) {
    localCategories.add(c);
  }
  renderCategoriesHost();
  renderLettersHost();

  // ===========================================
  // Rendu pour les non-hotes (lecture seule)
  // ===========================================

  state.applyGuestConfig = function (config) {
    if (!config) return;
    // Categories
    guestEls.categories.innerHTML = "";
    for (const cat of config.categories || []) {
      const li = document.createElement("li");
      li.textContent = cat;
      guestEls.categories.appendChild(li);
    }
    // Manches
    if (config.totalRounds === 0) {
      guestEls.rounds.textContent = "Illimité";
    } else {
      guestEls.rounds.textContent = `${config.totalRounds} manches`;
    }
    guestEls.timer.textContent = `${config.timerSeconds} sec`;
    // Mode de fin de manche
    if (guestEls.endMode) {
      const mode = config.endMode === "timer_only" ? "Timer uniquement" : "STOP ou timer";
      guestEls.endMode.textContent = mode;
    }
    if (config.scoring) {
      guestEls.scoreAlone.textContent = config.scoring.aloneInCategory;
      guestEls.scoreUnique.textContent = config.scoring.uniqueAnswer;
      guestEls.scoreDuplicate.textContent = config.scoring.duplicateAnswer;
      guestEls.scoreInvalid.textContent = config.scoring.invalidOrEmpty;
      if (guestEls.scoreCheater) {
        const cp = config.scoring.cheaterPenaltyPerCheat ?? 0;
        const cpAbs = Math.abs(cp);
        guestEls.scoreCheater.textContent = cpAbs === 0 ? "désactivé" : `-${cpAbs} pts / cat.`;
      }
    }
    // Lettres autorisees pour le tirage
    renderLettersGuest(config.letterPool);
    // Contrainte de longueur (lecture seule)
    if (guestEls.lengthConstraint) {
      const desc = describeLengthConstraint(config.lengthConstraint);
      guestEls.lengthConstraint.textContent = desc ?? "Aucune";
    }
  };

  // Si on rejoint et qu'on a deja recu une config (joined), on l'applique
  state.applyConfigToHostInputs = function (config) {
    // Utilise quand un nouveau host prend le relais (host migration en lobby)
    if (!config || !state.isHost) return;
    localCategories.clear();
    for (const c of config.categories || []) localCategories.add(c);
    renderCategoriesHost();
    if (config.totalRounds !== undefined) {
      // 0 cote serveur = illimité (case cochée, input grisé sur 5 par défaut
      // pour ne pas afficher 0 dans un input bizarre)
      if (config.totalRounds === 0) {
        if (roundsUnlimitedInput) roundsUnlimitedInput.checked = true;
        // On garde la valeur visible de l'input à 5 pour quand on décochera
        if (!roundsInput.value || roundsInput.value === "0") roundsInput.value = "5";
      } else {
        if (roundsUnlimitedInput) roundsUnlimitedInput.checked = false;
        roundsInput.value = String(config.totalRounds);
      }
      syncRoundsUnlimitedUI();
    }
    if (config.timerSeconds !== undefined) timerInput.value = String(config.timerSeconds);
    if (config.endMode === "timer_only" || config.endMode === "stop_or_timer") {
      endModeInput.value = config.endMode;
    } else {
      // Pas d'endMode dans la config (ancienne config) : on revient au defaut
      endModeInput.value = "stop_or_timer";
    }
    if (config.scoring) {
      scoreInputs.aloneInCategory.value = String(config.scoring.aloneInCategory);
      scoreInputs.uniqueAnswer.value = String(config.scoring.uniqueAnswer);
      scoreInputs.duplicateAnswer.value = String(config.scoring.duplicateAnswer);
      scoreInputs.invalidOrEmpty.value = String(config.scoring.invalidOrEmpty);
      // Le malus est stocke en negatif cote protocole, mais affiche en positif dans l'UI
      const cp = config.scoring.cheaterPenaltyPerCheat;
      const cpAbs = typeof cp === "number" ? Math.abs(cp) : 0;
      scoreInputs.cheaterPenaltyPerCheat.value = String(cpAbs);
    }
    // Lettres : si la config en contient, on les applique. Sinon (vieille
    // config), on retombe sur le pool par defaut.
    localLetters.clear();
    const incoming = (typeof config.letterPool === "string" ? config.letterPool : "")
      .toUpperCase().replace(/[^A-Z]/g, "");
    const source = incoming.length > 0 ? incoming : DEFAULT_POOL;
    for (const l of source) localLetters.add(l);
    if (localLetters.size === 0) localLetters.add("A");
    renderLettersHost();
    // Contrainte de longueur : restaure le radio + l'input numerique
    const lc = config.lengthConstraint;
    let restoreMode = "none";
    let restoreValue = 5;
    if (lc && (lc.mode === "min" || lc.mode === "max")) {
      restoreMode = lc.mode;
      if (typeof lc.value === "number" && Number.isFinite(lc.value)) {
        restoreValue = Math.max(
          LIMITS.MIN_WORD_LEN_BOUND,
          Math.min(LIMITS.MAX_WORD_LEN_BOUND, lc.value)
        );
      }
    }
    for (const r of lengthModeRadios) {
      r.checked = r.value === restoreMode;
    }
    lengthValueInput.value = String(restoreValue);
    syncLengthConstraintUI();
  };

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

    // Affiche la zone host OU la zone guest selon le role
    console.log("[lobby] renderPlayers", {
      isHost: state.isHost,
      hasConfig: !!state.config,
      configCategories: state.config?.categories?.length ?? 0,
      myPseudo: state.myPseudo,
    });
    if (state.isHost) {
      hostActionsEl.style.display = "block";
      guestConfigEl.style.display = "none";
    } else {
      hostActionsEl.style.display = "none";
      guestConfigEl.style.display = "block";
      // S'il n'y a pas encore de config diffusee, on utilise la config d'etat (ou rien)
      if (state.config) {
        state.applyGuestConfig(state.config);
      }
    }
  };

  // --- Bouton "Demarrer la partie" ---
  startGameBtn.addEventListener("click", () => {
    if (localCategories.size < LIMITS.MIN_CATEGORIES) {
      showToast(`Il faut au moins ${LIMITS.MIN_CATEGORIES} catégories.`, { type: "error" });
      return;
    }
    const config = buildCurrentConfig();
    if ([config.scoring.aloneInCategory, config.scoring.uniqueAnswer, config.scoring.duplicateAnswer, config.scoring.invalidOrEmpty].some((n) => Number.isNaN(n))) {
      showToast("Barème invalide.", { type: "error" });
      return;
    }
    // Idem que pushConfigSoon : on synchronise state.config localement
    // pour que la phase de validation puisse lire le bareme cote host.
    state.config = config;
    conn.send({ type: "start_game", config });
  });

  // Note : le push initial de la config par l'hote ne se fait pas ici (race
  // avec l'arrivee du message `joined` : si le timer fire avant `joined`,
  // state.isHost vaut encore false et pushConfigSoon ne fait rien, ce qui
  // laisse le serveur avec config=null et les guests qui rejoignent ensuite
  // n'ont pas la config). On declenche pushConfigNow() directement depuis
  // lobby.js dans le handler `joined` quand on est confirme hote.

  // --- Helpers messages ---
  state.showError = function (msg) {
    errorBox.textContent = msg;
    errorBox.classList.add("show");
    infoBox.classList.remove("show");
  };
  state.clearError = function () {
    errorBox.classList.remove("show");
  };
  state.showInfo = function (msg) {
    infoBox.textContent = msg;
    infoBox.classList.add("show");
  };
}

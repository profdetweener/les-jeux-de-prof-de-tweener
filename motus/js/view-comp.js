/**
 * Vue du mode COMPÉTITIF Motus.
 *
 * Trois sous-vues, pilotees par la phase :
 *   - in_round       -> #view-comp-game   (ma grille + clavier + miniatures adverses)
 *   - between_rounds -> #view-comp-recap  (recap de la manche + scores cumules)
 *   - finished       -> #view-comp-final  (podium final)
 *
 * Principe cle : sur ma grille je vois mes lettres + couleurs. Sur les
 * miniatures adverses je ne vois QUE les couleurs (jamais les lettres) —
 * c'est ce qui cree le stress sans permettre de tricher.
 *
 * Le serveur fait foi pour toute la logique (validation, coloration, scoring,
 * fin de manche). Cette vue ne fait qu'afficher et envoyer les essais.
 */

import { showToast } from "../../shared/js/toast.js";
import { fetchDefinition } from "../../shared/js/wiktionary.js?v=2";

const KEYBOARD_ROWS = [
  ["A", "Z", "E", "R", "T", "Y", "U", "I", "O", "P"],
  ["Q", "S", "D", "F", "G", "H", "J", "K", "L", "M"],
  ["DEL", "W", "X", "C", "V", "B", "N", "ENTER"],
];

// Delais d'animation pour la revelation lettre par lettre (identiques au chill)
const REVEAL_DELAY_MS = 400;
const POST_REVEAL_DELAY_MS = 400;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function initCompView(state, conn) {
  // --- Refs DOM ---
  const roundInfoEl = document.getElementById("comp-round-info");
  const timerEl = document.getElementById("comp-timer");
  const attemptInfoEl = document.getElementById("comp-attempt-info");
  const gridEl = document.getElementById("comp-grid");
  const selfNoticeEl = document.getElementById("comp-self-notice");
  const keyboardEl = document.getElementById("comp-keyboard");
  const opponentsEl = document.getElementById("comp-opponents");
  const nativeInput = document.getElementById("comp-native-input");
  const letterCounterEl = document.getElementById("comp-letter-counter");
  const soundToggleEl = document.getElementById("comp-sound-toggle");
  const soundIconEl = document.getElementById("comp-sound-icon");

  // Detection tactile : sur ces appareils on s'appuie sur le clavier natif du
  // telephone (input) plutot que sur le seul clavier visuel. Sur desktop,
  // l'input reste cache et on garde clavier physique + touches cliquables.
  const isTouch = window.matchMedia("(hover: none) and (pointer: coarse)").matches;

  // =========================================================================
  // Sons a la revelation des lettres : on charge les samples MP3 officiels
  // via Web Audio (decodeAudioData -> AudioBuffer). Avantages vs HTMLAudio :
  // latence quasi nulle, polyphonie naturelle (chaque play = nouveau
  // BufferSource), et compatibilite iOS une fois l'AudioContext debloque.
  //
  // Chargement paresseux : la requete fetch part au premier appel a
  // ensureAudioCtx() (donc des le premier geste utilisateur), pour ne pas
  // gaspiller de bande passante si le joueur ne fait que regarder.
  //
  // Si un buffer n'est pas encore pret au moment d'un tick, on retombe
  // silencieusement sur un beep synthetise pour ne jamais bloquer la
  // revelation.
  //
  // L'etat ON/OFF du bouton est persiste en localStorage : on mute une fois
  // et c'est memorise pour les prochaines parties (le joueur garde bien sur
  // le controle total et peut basculer a tout moment).
  // =========================================================================
  const SOUND_STORAGE_KEY = "motus_comp_sound";
  const SOUND_URLS = {
    good:      "sounds/Bonne_Lettre.mp3",
    misplaced: "sounds/Mal_Place.mp3",
    absent:    "sounds/Mauvaise_Lettre.mp3",
    found:     "sounds/Mot_Trouve.mp3",
  };
  /** @type {Object<string, AudioBuffer>} */
  const soundBuffers = {};
  let soundsLoading = false;

  let soundEnabled = (() => {
    try { return window.localStorage.getItem(SOUND_STORAGE_KEY) !== "0"; }
    catch { return true; }
  })();
  let audioCtx = null;

  function ensureAudioCtx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { audioCtx = new AC(); } catch { return null; }
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    // Premier appel : declenche le chargement des samples (en tache de fond).
    if (!soundsLoading) {
      soundsLoading = true;
      loadAllSounds();
    }
    return audioCtx;
  }

  async function loadOneSound(key, url) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) return;
      const arr = await resp.arrayBuffer();
      // Safari < 14.1 ne supporte que la signature callback ; on tente les deux.
      const buf = await new Promise((resolve, reject) => {
        const p = audioCtx.decodeAudioData(arr, resolve, reject);
        if (p && typeof p.then === "function") p.then(resolve, reject);
      });
      soundBuffers[key] = buf;
    } catch {
      // Echec silencieux : on retombera sur le bip synthetise.
    }
  }

  async function loadAllSounds() {
    if (!audioCtx) return;
    await Promise.all(Object.entries(SOUND_URLS).map(([k, u]) => loadOneSound(k, u)));
  }

  /** Joue un sample charge, ou retombe sur un bip synthetise en secours. */
  function playSound(key) {
    if (!soundEnabled) return;
    const ctx = ensureAudioCtx();
    if (!ctx) return;
    const buf = soundBuffers[key];
    if (buf) {
      try {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);
      } catch {}
      return;
    }
    // Fallback synthetise (utilise tant que les MP3 ne sont pas decodes, ou
    // si le decodage a echoue).
    try {
      const t0 = ctx.currentTime;
      let freq, peak, dur;
      if (key === "good")           { freq = 880; peak = 0.18; dur = 0.13; }
      else if (key === "misplaced") { freq = 587; peak = 0.15; dur = 0.12; }
      else if (key === "found")     { freq = 988; peak = 0.20; dur = 0.40; }
      else                          { freq = 280; peak = 0.10; dur = 0.10; }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    } catch {}
  }

  /** Joue le son associe au statut d'une case revelee. */
  function playTick(status) {
    playSound(status);
  }

  function updateSoundToggleUI() {
    if (!soundToggleEl) return;
    soundToggleEl.setAttribute("aria-pressed", soundEnabled ? "true" : "false");
    if (soundIconEl) soundIconEl.textContent = soundEnabled ? "🔊" : "🔇";
    soundToggleEl.title = soundEnabled
      ? "Sons activés — clic pour couper"
      : "Sons coupés — clic pour activer";
  }
  updateSoundToggleUI();

  if (soundToggleEl) {
    soundToggleEl.addEventListener("click", () => {
      soundEnabled = !soundEnabled;
      try { window.localStorage.setItem(SOUND_STORAGE_KEY, soundEnabled ? "1" : "0"); } catch {}
      updateSoundToggleUI();
      // En profite pour "unlocker" l'audio sur iOS et confirmer a l'oreille
      // que le son fonctionne quand on l'active.
      ensureAudioCtx();
      if (soundEnabled) playSound("good");
    });
  }

  const recapTitleEl = document.getElementById("comp-recap-title");
  const recapWordEl = document.getElementById("comp-recap-word");
  const recapTableEl = document.getElementById("comp-recap-table");
  const recapDefBtn = document.getElementById("comp-recap-def-btn");
  const recapDefPanel = document.getElementById("comp-recap-def-panel");
  const nextRoundBtn = document.getElementById("comp-next-round-btn");
  const skipFinalBtn = document.getElementById("comp-skip-final-btn");
  const endGameBtn = document.getElementById("comp-end-game-btn");
  const recapWaitingEl = document.getElementById("comp-recap-waiting");

  const podiumEl = document.getElementById("comp-podium");
  const finalTableEl = document.getElementById("comp-final-table");
  const finalWordEl = document.getElementById("comp-final-word");
  const finalDefWrap = document.getElementById("comp-final-definition");
  const finalDefBtn = document.getElementById("comp-final-def-btn");
  const finalDefPanel = document.getElementById("comp-final-def-panel");
  const backLobbyBtn = document.getElementById("comp-back-lobby-btn");
  const finalWaitingEl = document.getElementById("comp-final-waiting");

  // --- Etat local de la manche ---
  const round = {
    active: false,
    wordLength: 0,
    maxAttempts: 0,
    firstLetter: "",
    myAttempts: [],         // [{guess, feedback:[{letter,status,hasMore}]}]
    myStatus: "playing",    // playing | found | exhausted
    opponents: {},          // pseudo -> { rows:[{feedback,hasMore}], status, attemptsUsed }
    deadlineTs: null,
    revealing: false,      // true pendant l'animation de revelation d'une ligne
  };
  let typingBuffer = "";
  // Horodate du dernier submitGuess, pour deduplication du double-fire
  // keydown+blur sur iOS quand on tape le bouton "Go" du clavier natif.
  let lastSubmitTs = 0;
  let keyButtons = {};
  let timerInterval = null;
  // Memorise si le recap actuellement affiche correspond a la derniere manche
  // (pour ajuster les confirm dialogs et eviter "Sauter au classement final ?
  // Les manches restantes ne seront pas jouees." quand justement c'est deja
  // la fin).
  let isAtLastRoundRecap = false;

  // =========================================================================
  // Construction clavier
  // =========================================================================
  function buildKeyboard() {
    keyboardEl.innerHTML = "";
    keyButtons = {};
    for (const row of KEYBOARD_ROWS) {
      const rowEl = document.createElement("div");
      rowEl.className = "kb-row";
      for (const key of row) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "kb-key";
        btn.textContent = key;
        if (key === "ENTER" || key === "DEL") btn.classList.add("kb-key-wide");
        btn.addEventListener("click", () => onKeyPress(key));
        rowEl.appendChild(btn);
        if (key.length === 1) keyButtons[key] = btn;
      }
      keyboardEl.appendChild(rowEl);
    }
  }

  // Saisie clavier physique
  function onPhysicalKey(e) {
    if (!round.active || round.myStatus !== "playing" || round.revealing) return;
    if (state.phase !== "in_round") return;
    // N'intercepte pas la saisie dans un champ texte
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    const k = e.key.toUpperCase();
    if (k === "ENTER") { e.preventDefault(); onKeyPress("ENTER"); }
    else if (k === "BACKSPACE") { e.preventDefault(); onKeyPress("DEL"); }
    else if (/^[A-Z]$/.test(k)) { e.preventDefault(); onKeyPress(k); }
  }

  // =========================================================================
  // Saisie : source de verite unique (typingBuffer), alimentee soit par le
  // clavier visuel/physique, soit par l'input natif mobile.
  // =========================================================================
  function canType() {
    return (
      round.active &&
      round.myStatus === "playing" &&
      !round.revealing &&
      state.phase === "in_round"
    );
  }

  /** Met a jour le buffer (nettoye A-Z, borne a wordLength), synchronise
   *  l'input natif et redessine la grille. */
  function setTypingBuffer(next) {
    const clean = (next || "")
      .toUpperCase()
      .replace(/[^A-Z]/g, "")
      .slice(0, round.wordLength);
    typingBuffer = clean;
    if (nativeInput && nativeInput.value !== clean) nativeInput.value = clean;
    updateLetterCounter();
    renderMyGrid();
  }

  /** Met a jour le compteur de lettres "X / N" affiche dans la barre de
   *  saisie sur mobile. Bascule en "complete" (fond vert) quand le mot est
   *  termine, pour confirmer visuellement qu'on peut valider sans avoir a
   *  regarder la grille. */
  function updateLetterCounter() {
    if (!letterCounterEl) return;
    const total = round.wordLength || 0;
    const cur = typingBuffer.length;
    letterCounterEl.textContent = `${cur} / ${total}`;
    letterCounterEl.classList.toggle("complete", total > 0 && cur === total);
  }

  /** Redonne le focus a l'input natif (mobile) pour rouvrir le clavier. Best
   *  effort : iOS n'ouvre le clavier que sur un geste, mais Android suit. */
  function focusNativeInput() {
    if (!isTouch || !nativeInput) return;
    if (!canType()) return;
    try {
      nativeInput.focus({ preventScroll: true });
    } catch {
      nativeInput.focus();
    }
  }

  /** Ramene la ligne qui vient d'etre revelee au centre de la vue sur mobile,
   *  pour que le joueur voie tout de suite le resultat de son essai meme si
   *  iOS avait scrolle la page jusqu'au champ pendant la saisie. */
  function bringRowIntoView(rowIdx) {
    if (!isTouch) return;
    const rows = gridEl.querySelectorAll(".motus-row");
    const row = rows[rowIdx];
    if (row && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  function onKeyPress(key) {
    if (!canType()) return;
    if (key === "ENTER") {
      submitGuess();
    } else if (key === "DEL") {
      setTypingBuffer(typingBuffer.slice(0, -1));
    } else if (/^[A-Z]$/.test(key)) {
      if (typingBuffer.length < round.wordLength) {
        setTypingBuffer(typingBuffer + key);
      }
    }
  }

  function submitGuess() {
    if (typingBuffer.length !== round.wordLength) {
      showToast(`Le mot doit faire ${round.wordLength} lettres.`, { type: "error" });
      return;
    }
    if (typingBuffer[0] !== round.firstLetter) {
      showToast(`Le mot doit commencer par ${round.firstLetter}.`, { type: "error" });
      return;
    }
    // Horodate la soumission pour permettre au blur handler de dedupliquer
    // (cf. listener blur sur nativeInput plus bas).
    lastSubmitTs = Date.now();
    // Le submit est forcement consecutif a une gesture utilisateur (Enter,
    // coche iOS, ENTER du clavier visuel) : on en profite pour deverrouiller
    // l'AudioContext maintenant, avant que la reveal arrive en async.
    ensureAudioCtx();

    // Sur mobile : ferme le clavier natif et ramene la ligne en cours au
    // centre de la vue immediatement, au moment de la validation, plutot
    // qu'apres la revelation. Ainsi le joueur voit son essai prendre place
    // au bon endroit en temps reel pendant que les couleurs se devoilent.
    if (nativeInput) nativeInput.blur();
    bringRowIntoView(round.myAttempts.length);

    conn.send({ type: "submit_guess", guess: typingBuffer });
    // On ne vide pas le buffer tout de suite : on attend la reponse serveur
    // (guess_result) pour le consigner. Si refus (erreur), le buffer reste.
  }

  // =========================================================================
  // Coloration du clavier (regle de monotonie : on ne degrade jamais)
  // =========================================================================
  /**
   * Met a jour la couleur d'une touche selon le dernier feedback. Regle de
   * monotonie : absent < misplaced < good. On ne degrade jamais une touche.
   * hasMore est un raffinement de "good" qu'on conserve une fois pose.
   */
  function updateKeyColor(letter, status, hasMore = false) {
    const btn = keyButtons[letter];
    if (!btn) return;
    const order = { absent: 0, misplaced: 1, good: 2 };
    const current = ["absent", "misplaced", "good"].find((s) => btn.classList.contains(`kb-${s}`));
    if (!current || order[status] > order[current]) {
      btn.classList.remove("kb-absent", "kb-misplaced", "kb-good");
      btn.classList.add(`kb-${status}`);
    }
    if (status === "good" && hasMore) {
      btn.classList.add("kb-has-more");
    }
  }

  /**
   * Re-applique les couleurs du clavier d'apres tous les essais deja soumis.
   * Utilise apres construction du clavier (round_started, reconnexion).
   */
  function applyAllKeyColors() {
    for (const attempt of round.myAttempts) {
      for (const fb of attempt.feedback) {
        updateKeyColor(fb.letter, fb.status, fb.hasMore);
      }
    }
  }

  /**
   * Anime la revelation de la derniere ligne soumise : pose les lettres en
   * "remplies", puis revele case par case avec un delai. Colore aussi le
   * clavier au passage.
   *
   * IMPORTANT : pendant l'animation, on ne peut pas taper la ligne suivante
   * (round.myStatus reflete l'etat serveur mais on ajoute un flag d'animation
   * pour bloquer la saisie). Le buffer reste vide.
   */
  async function revealMyRowAnimated(attempt, attemptIndex) {
    // Trouve la rangee correspondante dans le DOM
    const rows = gridEl.querySelectorAll(".motus-row");
    const rowEl = rows[attemptIndex];
    if (!rowEl) return; // securite : la grille a ete reconstruite entre-temps
    const cells = rowEl.querySelectorAll(".motus-cell");

    // 1) Pose les lettres "remplies" (etat intermediaire), enleve la 1ere lettre
    //    indicee si elle y etait
    for (let c = 0; c < attempt.feedback.length; c++) {
      const cell = cells[c];
      if (!cell) continue;
      cell.classList.remove("locked-letter", "typing");
      cell.classList.add("filled");
      cell.textContent = attempt.feedback[c].letter;
    }

    // 2) Revele case par case avec un delai entre chaque
    for (let c = 0; c < attempt.feedback.length; c++) {
      const fb = attempt.feedback[c];
      const cell = cells[c];
      if (!cell) continue;
      cell.classList.add(`status-${fb.status}`);
      if (fb.status === "good" && fb.hasMore) cell.classList.add("has-more");
      updateKeyColor(fb.letter, fb.status, fb.hasMore);
      playTick(fb.status);
      await sleep(REVEAL_DELAY_MS);
    }
    await sleep(POST_REVEAL_DELAY_MS);
  }

  // =========================================================================
  // Calcule les "hints" affiches sur la ligne courante quand elle est vierge :
  // pour chaque colonne, la derniere lettre revelee comme "good" lors d'un essai
  // precedent. La 1ere lettre imposee est toujours dans le hint (col 0).
  // Equivalent du computeHintRow du mode chill.
  // =========================================================================
  function computeHintRow() {
    const hint = new Array(round.wordLength).fill("");
    if (round.firstLetter) hint[0] = round.firstLetter;
    for (const att of round.myAttempts) {
      if (!att || !att.feedback) continue;
      att.feedback.forEach((fb, col) => {
        if (fb.status === "good") hint[col] = fb.letter;
      });
    }
    return hint;
  }

  // =========================================================================
  // Rendu de MA grille
  // =========================================================================
  function renderMyGrid() {
    gridEl.innerHTML = "";
    gridEl.style.setProperty("--motus-cols", round.wordLength);
    // Aussi sur le parent .comp-main pour que sa max-width (et donc celle du
    // clavier qui est dedans) soit calee sur la grille
    const compMain = gridEl.closest(".comp-main");
    if (compMain) compMain.style.setProperty("--motus-cols", round.wordLength);
    // Hints affiches sur la ligne courante quand elle est encore vierge :
    // toutes les lettres deja revelees comme "good" lors des essais precedents,
    // a la maniere du mode chill. Aide visuelle uniquement, l'utilisateur peut
    // taper ce qu'il veut.
    const hintRow = computeHintRow();
    const showHints = typingBuffer.length === 0;
    for (let r = 0; r < round.maxAttempts; r++) {
      const rowEl = document.createElement("div");
      rowEl.className = "motus-row";
      const submitted = round.myAttempts[r];
      const isCurrentRow = r === round.myAttempts.length && round.myStatus === "playing";
      for (let c = 0; c < round.wordLength; c++) {
        const cell = document.createElement("div");
        cell.className = "motus-cell";
        if (submitted) {
          const fb = submitted.feedback[c];
          cell.textContent = fb.letter;
          cell.classList.add(`status-${fb.status}`);
          if (fb.status === "good" && fb.hasMore) cell.classList.add("has-more");
        } else if (isCurrentRow) {
          if (c < typingBuffer.length) {
            cell.textContent = typingBuffer[c];
            cell.classList.add("typing");
          } else if (showHints && hintRow[c]) {
            // Indice : lettre "good" deja revelee a cette position (ou 1ere
            // lettre du mot pour la col 0). Style locked-letter pour signaler
            // que c'est un pre-remplissage visuel.
            cell.textContent = hintRow[c];
            cell.classList.add("locked-letter");
          }
        }
        rowEl.appendChild(cell);
      }
      gridEl.appendChild(rowEl);
    }
    // Statut
    const used = round.myAttempts.length;
    attemptInfoEl.textContent = `Essai ${Math.min(used + 1, round.maxAttempts)} / ${round.maxAttempts}`;
    if (round.myStatus === "found") {
      selfNoticeEl.style.display = "";
      selfNoticeEl.textContent = "✅ Trouvé ! En attente des autres…";
    } else if (round.myStatus === "exhausted") {
      selfNoticeEl.style.display = "";
      selfNoticeEl.textContent = "❌ Essais épuisés. En attente des autres…";
    } else {
      selfNoticeEl.style.display = "none";
    }
  }

  // =========================================================================
  // Rendu des MINIATURES adverses (couleurs only)
  // =========================================================================
  function buildOpponents(pseudos) {
    opponentsEl.innerHTML = "";
    // Classe pour adapter le layout : a partir de 4 adversaires, on bascule en
    // grille fluide (qui pourra s'enrouler sous le clavier sur grand ecran).
    opponentsEl.classList.toggle("opps-many", pseudos.length >= 4);
    for (const pseudo of pseudos) {
      const card = document.createElement("div");
      card.className = "opp-card";
      card.dataset.pseudo = pseudo;

      const head = document.createElement("div");
      head.className = "opp-head";
      const name = document.createElement("span");
      name.className = "opp-name";
      name.textContent = pseudo;
      const status = document.createElement("span");
      status.className = "opp-status";
      status.textContent = "";
      head.appendChild(name);
      head.appendChild(status);

      const mini = document.createElement("div");
      mini.className = "opp-grid";

      card.appendChild(head);
      card.appendChild(mini);
      opponentsEl.appendChild(card);
    }
  }

  function renderOpponent(pseudo) {
    const opp = round.opponents[pseudo];
    if (!opp) return;
    const card = opponentsEl.querySelector(`.opp-card[data-pseudo="${cssEscape(pseudo)}"]`);
    if (!card) return;
    const mini = card.querySelector(".opp-grid");
    const statusEl = card.querySelector(".opp-status");
    mini.style.setProperty("--opp-cols", round.wordLength);
    mini.innerHTML = "";
    for (let r = 0; r < round.maxAttempts; r++) {
      const rowEl = document.createElement("div");
      rowEl.className = "opp-row";
      const submitted = opp.rows[r];
      for (let c = 0; c < round.wordLength; c++) {
        const cell = document.createElement("div");
        cell.className = "opp-cell";
        if (submitted) {
          cell.classList.add(`status-${submitted.feedback[c]}`);
          if (submitted.feedback[c] === "good" && submitted.hasMore[c]) {
            cell.classList.add("has-more");
          }
        }
        rowEl.appendChild(cell);
      }
      mini.appendChild(rowEl);
    }
    if (opp.status === "found") {
      statusEl.textContent = "✅";
      card.classList.add("opp-done");
    } else if (opp.status === "exhausted") {
      statusEl.textContent = "❌";
      card.classList.add("opp-done");
    } else {
      statusEl.textContent = `${opp.attemptsUsed}/${round.maxAttempts}`;
      card.classList.remove("opp-done");
    }
  }

  function cssEscape(s) {
    return String(s).replace(/["\\]/g, "\\$&");
  }

  // =========================================================================
  // Timer
  // =========================================================================
  function startTimer() {
    stopTimer();
    updateTimer();
    timerInterval = setInterval(updateTimer, 250);
  }
  function stopTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }
  function updateTimer() {
    if (round.deadlineTs === null) { timerEl.textContent = "--:--"; return; }
    const remaining = Math.max(0, round.deadlineTs - Date.now());
    const totalSec = Math.ceil(remaining / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    timerEl.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    // Clignote uniquement entre 1 et 10s ; a 0 on fige sans clignoter.
    timerEl.classList.toggle("comp-timer-urgent", totalSec > 0 && totalSec <= 10);
    timerEl.classList.toggle("comp-timer-zero", totalSec === 0);
    if (remaining <= 0) {
      stopTimer();
      // Safety net : si le serveur n'envoie pas round_ended dans les ~4s
      // (cas rare de retard d'alarme), on affiche un message d'attente pour
      // que le joueur sache que ce n'est pas fige.
      armRoundEndedSafetyNet();
    }
  }

  // Si on a atteint 0:00 cote client mais que round_ended/game_ended n'arrive
  // pas (retard d'alarme DO, perte de message), on affiche un hint d'attente
  // pour eviter l'impression de blocage. Le serveur reste la source de verite ;
  // si l'utilisateur est sur un mauvais reseau, la reconnexion auto rejouera
  // l'etat (compRound dans le "joined") et nous tirera de la.
  let safetyNetTimeout = null;
  function armRoundEndedSafetyNet() {
    if (safetyNetTimeout) return;
    safetyNetTimeout = setTimeout(() => {
      safetyNetTimeout = null;
      if (!round.active) return; // round_ended deja arrive, rien a faire
      if (state.phase !== "in_round") return;
      // Affiche un hint discret au-dessus du clavier
      selfNoticeEl.style.display = "";
      selfNoticeEl.textContent = "⏳ Fin de manche imminente — en attente du serveur…";
    }, 4000);
  }
  function clearRoundEndedSafetyNet() {
    if (safetyNetTimeout) { clearTimeout(safetyNetTimeout); safetyNetTimeout = null; }
  }

  // =========================================================================
  // Handlers de messages serveur
  // =========================================================================

  function onRoundStarted(msg) {
    round.active = true;
    round.revealing = false;
    round.wordLength = msg.wordLength;
    round.maxAttempts = msg.maxAttempts;
    round.firstLetter = msg.firstLetter;
    round.myAttempts = [];
    round.myStatus = "playing";
    round.deadlineTs = msg.deadlineTs;
    round.opponents = {};
    for (const p of msg.opponents) {
      round.opponents[p] = { rows: [], status: "playing", attemptsUsed: 0 };
    }
    typingBuffer = "";

    // Remet le scroll en haut : sinon la position du scroll de la manche
    // precedente (apres bringRowIntoView sur le dernier essai) se reporte
    // sur la nouvelle, et iOS Safari minimise sa barre d'URL ce qui fait
    // sauter visuellement l'en-tete (banderole haute partiellement cachee).
    window.scrollTo(0, 0);

    const totalTxt = msg.totalRounds ? ` / ${msg.totalRounds}` : "";
    roundInfoEl.textContent = `Manche ${msg.roundIndex}${totalTxt}`;

    buildKeyboard();
    buildOpponents(msg.opponents);
    renderMyGrid();
    applyAllKeyColors(); // vide en debut de manche, utile a la reconnexion
    for (const p of msg.opponents) renderOpponent(p);
    startTimer();

    if (nativeInput) {
      nativeInput.value = "";
      nativeInput.maxLength = round.wordLength;
    }
    updateLetterCounter();
    // Pas de focus automatique : iOS ouvrirait immediatement le clavier
    // (et sa barre d'accessoires), parasitant la vue avant meme la premiere
    // frappe. Le joueur touche le champ "Tape ton mot" (ou la grille) quand
    // il veut saisir.
  }

  async function onGuessResult(msg) {
    // Pose l'essai dans l'etat avant de l'animer
    round.myAttempts[msg.attemptIndex] = msg.attempt;
    typingBuffer = "";
    // Bloque la saisie pendant la revelation
    round.revealing = true;

    // Met a jour le compteur d'essais immediatement
    const used = round.myAttempts.length;
    attemptInfoEl.textContent = `Essai ${Math.min(used + 1, round.maxAttempts)} / ${round.maxAttempts}`;

    // Animation lettre par lettre + coloration clavier
    await revealMyRowAnimated(msg.attempt, msg.attemptIndex);

    // Statut final
    round.myStatus = msg.myStatus;
    round.revealing = false;
    renderMyGrid();

    // Jingle si le joueur a trouvé le mot ce coup-ci. On laisse un petit
    // souffle apres le dernier tick de la révélation pour que les deux sons
    // ne se chevauchent pas. Le worker envoie "found" (pas "won").
    if (msg.myStatus === "found") {
      setTimeout(() => playSound("found"), 120);
    }

    // Vide le buffer pour le prochain essai. Le clavier natif a deja ete
    // ferme et la grille deja repositionnee au moment du submit (cf.
    // submitGuess), donc rien d'autre a faire ici.
    if (nativeInput) {
      nativeInput.value = "";
    }
  }

  function onOpponentProgress(msg) {
    const opp = round.opponents[msg.playerId];
    if (!opp) return;
    opp.rows[msg.rowIndex] = msg.row;
    opp.status = msg.status;
    opp.attemptsUsed = msg.attemptsUsed;
    renderOpponent(msg.playerId);
  }

  async function onRoundEnded(msg) {
    // Si une revelation est en cours (cas typique : le joueur vient de
    // soumettre le mot gagnant, le worker a immediatement envoye
    // round_ended apres guess_result), on attend qu'elle se termine avant
    // de basculer vers le recap. Sinon l'animation est coupee a mi-parcours
    // et le joueur ne voit pas son resultat. Idem si le chrono tombe
    // pendant la revelation d'un essai.
    while (round.revealing) {
      await sleep(60);
    }
    // Petit souffle apres la revelation pour que la derniere case + le
    // jingle eventuel de victoire soient bien percus avant le basculement.
    await sleep(POST_REVEAL_DELAY_MS);

    round.active = false;
    stopTimer();
    clearRoundEndedSafetyNet();
    if (nativeInput) nativeInput.blur();
    renderRecap(msg);
  }

  async function onGameEnded(msg) {
    // Meme logique que onRoundEnded : attendre la fin de la revelation
    // pour ne pas couper l'animation du dernier essai.
    while (round.revealing) {
      await sleep(60);
    }
    await sleep(POST_REVEAL_DELAY_MS);

    round.active = false;
    stopTimer();
    clearRoundEndedSafetyNet();
    if (nativeInput) nativeInput.blur();
    renderFinal(msg.results);
  }

  // Memorise le dernier mot revele (pour la definition au final)
  let lastRevealedWord = null;
  // Cache du dernier message de recap, pour pouvoir re-rendre la table apres
  // un kick (le worker ne renvoie pas round_ended quand on kicke entre 2
  // manches, donc on doit rerender localement).
  let lastRecapMsg = null;

  /**
   * Affiche/cache un panneau de definition Wiktionary. Lazy : ne fetch qu'au
   * premier clic. Re-clic = bascule visible/cache.
   */
  function attachDefButton(btnEl, panelEl, getWord) {
    let loaded = false;
    let loading = false;
    btnEl.addEventListener("click", async () => {
      // Toggle si deja charge
      if (loaded) {
        panelEl.hidden = !panelEl.hidden;
        btnEl.textContent = panelEl.hidden ? "📖 Voir la définition" : "📖 Masquer la définition";
        return;
      }
      if (loading) return;
      const word = getWord();
      if (!word) return;
      loading = true;
      btnEl.disabled = true;
      btnEl.textContent = "📖 Chargement…";
      try {
        const data = await fetchDefinition(word);
        panelEl.innerHTML = renderDefinitionHtml(data);
        panelEl.hidden = false;
        loaded = true;
        btnEl.textContent = "📖 Masquer la définition";
      } catch (e) {
        panelEl.innerHTML = `<p class="def-error">${escapeHtml(e?.message || "Définition introuvable.")}</p>`;
        panelEl.hidden = false;
        loaded = true;
        btnEl.textContent = "📖 Masquer la définition";
      } finally {
        loading = false;
        btnEl.disabled = false;
      }
    });
  }

  function renderDefinitionHtml(data) {
    if (!data || !data.entries || data.entries.length === 0) {
      return `<p class="def-error">Aucune définition trouvée.</p>`;
    }
    let html = "";
    for (const entry of data.entries) {
      html += `<div class="def-entry"><div class="def-pos">${escapeHtml(entry.partOfSpeech)}</div><ol class="def-list">`;
      for (const d of entry.definitions) {
        html += `<li>${escapeHtml(d.text)}`;
        if (d.examples && d.examples.length > 0) {
          html += `<ul class="def-examples">`;
          for (const ex of d.examples.slice(0, 2)) {
            html += `<li>${escapeHtml(ex)}</li>`;
          }
          html += `</ul>`;
        }
        html += `</li>`;
      }
      html += `</ol></div>`;
    }
    html += `<p class="def-source"><a href="${data.sourceUrl}" target="_blank" rel="noopener">Voir sur Wiktionary →</a></p>`;
    return html;
  }

  // Attache une seule fois les handlers de definition (pas a chaque manche)
  attachDefButton(recapDefBtn, recapDefPanel, () => lastRevealedWord);
  attachDefButton(finalDefBtn, finalDefPanel, () => lastRevealedWord);

  // =========================================================================
  // Recap entre manches
  // =========================================================================
  function renderRecap(msg) {
    // Remet le scroll en haut : meme raison qu'a l'entree de in_round, on
    // ne veut pas que la position du scroll de la manche precedente saute
    // visuellement la banderole sur iOS.
    window.scrollTo(0, 0);
    lastRevealedWord = msg.revealedWord;
    lastRecapMsg = msg;
    isAtLastRoundRecap = !!msg.isLastRound;
    recapTitleEl.textContent = msg.isLastRound
      ? "Dernière manche terminée"
      : `Manche ${msg.roundIndex} terminée`;
    recapWordEl.innerHTML = `Le mot était <strong>${escapeHtml(msg.revealedWord)}</strong>`;
    recapTableEl.innerHTML = buildScoreTable(msg.results, true);

    // Reset de la definition (nouveau mot a chaque manche)
    recapDefPanel.hidden = true;
    recapDefPanel.innerHTML = "";
    recapDefBtn.textContent = "📖 Voir la définition";
    // Force la re-attache en revertant l'etat "loaded" : pas possible avec
    // closure -> on detache et reattache un nouveau handler. Plus simple :
    // on stocke loaded sur l'element et on le reset ici.
    // (attachDefButton ci-dessus utilise une closure, donc on doit la "re-armer".
    // Plus simple : on force le bouton a redeclencher un fetch en relançant le clone.)
    recapDefBtn.replaceWith(recapDefBtn.cloneNode(true));
    const freshBtn = document.getElementById("comp-recap-def-btn");
    attachDefButton(freshBtn, recapDefPanel, () => lastRevealedWord);

    // Boutons :
    //   - Hote, manche intermediaire : Manche suivante / Voir le classement / Quitter
    //   - Hote, derniere manche : Voir le classement / Quitter (pas de "Manche suivante")
    //   - Guest : tout cache, message d'attente
    if (state.isHost && !msg.isLastRound) {
      nextRoundBtn.style.display = "";
      skipFinalBtn.style.display = "";
      endGameBtn.style.display = "";
      recapWaitingEl.style.display = "none";
    } else if (state.isHost && msg.isLastRound) {
      nextRoundBtn.style.display = "none";
      // "Voir le classement final" devient l'action principale a la derniere
      // manche : on la met en avant en lui donnant temporairement le style
      // primaire (puis remis a son etat normal pour les manches suivantes).
      skipFinalBtn.style.display = "";
      skipFinalBtn.classList.remove("btn-secondary");
      skipFinalBtn.classList.add("btn-primary");
      skipFinalBtn.textContent = "Voir le classement final";
      endGameBtn.style.display = "";
      recapWaitingEl.style.display = "none";
    } else {
      nextRoundBtn.style.display = "none";
      skipFinalBtn.style.display = "none";
      endGameBtn.style.display = "none";
      recapWaitingEl.style.display = "";
      recapWaitingEl.textContent = `En attente de ${state.hostPseudo || "l'hôte"}…`;
    }
    // Quand on n'est PAS sur la derniere manche, on remet le bouton "Voir le
    // classement final" dans son etat secondaire d'origine.
    if (!msg.isLastRound) {
      skipFinalBtn.classList.remove("btn-primary");
      skipFinalBtn.classList.add("btn-secondary");
      skipFinalBtn.textContent = "Voir le classement final";
    }
  }

  /**
   * Calcule le rang de chaque joueur en gerant les ex-aequo (standard
   * "competition ranking" : 1, 1, 3 quand les deux premiers sont a egalite).
   * Retourne un tableau d'entiers parallele a `results` (suppose deja trie
   * par totalPoints decroissant).
   */
  function computeRanks(results) {
    const ranks = new Array(results.length);
    let currentRank = 0;
    let lastScore = null;
    for (let i = 0; i < results.length; i++) {
      if (lastScore === null || results[i].totalPoints !== lastScore) {
        currentRank = i + 1;
        lastScore = results[i].totalPoints;
      }
      ranks[i] = currentRank;
    }
    return ranks;
  }

  function renderFinal(results) {
    // Remet le scroll en haut a l'arrivee sur le podium (meme raison qu'au
    // recap : evite le saut visuel de l'en-tete iOS).
    window.scrollTo(0, 0);
    const ranks = computeRanks(results);

    // Podium : on prend tous les joueurs des 3 premiers rangs (= jusqu'au
    // rang 3 inclus), pas seulement les 3 premieres lignes. Ainsi en cas
    // d'egalite en 1ere place, on affiche bien les 2 (ou plus) ex-aequo
    // tous au rang 1 (medaille or, slot central).
    podiumEl.innerHTML = "";
    const medals = { 1: "🥇", 2: "🥈", 3: "🥉" };
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const rank = ranks[i];
      if (rank > 3) break; // on ne montre que les 3 premiers rangs sur le podium
      const slot = document.createElement("div");
      slot.className = `podium-slot podium-${rank}`;
      slot.innerHTML = `<div class="podium-medal">${medals[rank]}</div>` +
        `<div class="podium-name">${escapeHtml(r.playerId)}</div>` +
        `<div class="podium-score">${r.totalPoints} pts</div>`;
      podiumEl.appendChild(slot);
    }
    finalTableEl.innerHTML = buildScoreTable(results, false, ranks);

    // Definition du dernier mot reveille (s'il existe)
    if (lastRevealedWord) {
      finalWordEl.style.display = "";
      finalWordEl.innerHTML = `Dernier mot : <strong>${escapeHtml(lastRevealedWord)}</strong>`;
      finalDefWrap.style.display = "";
      // Reset bouton/panel comme pour recap
      finalDefPanel.hidden = true;
      finalDefPanel.innerHTML = "";
      finalDefBtn.replaceWith(finalDefBtn.cloneNode(true));
      const freshFinalBtn = document.getElementById("comp-final-def-btn");
      freshFinalBtn.textContent = "📖 Voir la définition";
      attachDefButton(freshFinalBtn, finalDefPanel, () => lastRevealedWord);
    } else {
      finalWordEl.style.display = "none";
      finalDefWrap.style.display = "none";
    }

    if (state.isHost) {
      backLobbyBtn.style.display = "";
      finalWaitingEl.style.display = "none";
    } else {
      backLobbyBtn.style.display = "none";
      finalWaitingEl.style.display = "";
      finalWaitingEl.textContent = `En attente de ${state.hostPseudo || "l'hôte"}…`;
    }
  }

  function buildScoreTable(results, showRoundPts, ranks) {
    // Si ranks n'est pas fourni, on calcule sur place (gestion ex-aequo
    // identique au podium : meme score = meme rang).
    const computed = ranks || computeRanks(results);
    let html = "<thead><tr><th>#</th><th>Joueur</th>";
    // Colonne "Essais" retiree : l'info apparait deja dans le breakdown
    // pour ceux qui ont trouve ("3 essais restants + 1 (trouvé) = 4 pts"),
    // et la colonne separee faisait deborder le tableau sur mobile.
    if (showRoundPts) html += "<th>Succès</th><th>Manche</th>";
    html += "<th>Total</th></tr></thead><tbody>";
    results.forEach((r, i) => {
      const pseudoHtml = escapeHtml(r.playerId);
      // Bouton "kick" inline a cote du pseudo : uniquement sur la table de
      // recap (showRoundPts=true), pour l'hote, et pas sur soi-meme. Sur le
      // podium final (showRoundPts=false), kicker n'a plus de sens.
      const showKick = showRoundPts && state.isHost && r.playerId !== state.myPseudo;
      const kickHtml = showKick
        ? ` <button type="button" class="kick-inline-btn" data-kick-target="${pseudoHtml}" title="Exclure ${pseudoHtml} de la partie" aria-label="Exclure ${pseudoHtml}">✕</button>`
        : "";
      html += `<tr><td>${computed[i]}</td><td><span class="pseudo-label">${pseudoHtml}</span>${kickHtml}</td>`;
      if (showRoundPts) {
        const detail = r.pointsBreakdown || (r.found ? "" : "—");
        html += `<td class="breakdown">${escapeHtml(detail)}</td><td>+${r.roundPoints}</td>`;
      }
      html += `<td><strong>${r.totalPoints}</strong></td></tr>`;
    });
    html += "</tbody>";
    return html;
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = String(s);
    return d.innerHTML;
  }

  // =========================================================================
  // Boutons hote
  // =========================================================================
  nextRoundBtn.addEventListener("click", () => {
    if (!state.isHost) return;
    conn.send({ type: "next_round" });
  });
  // Memorise si le recap actuellement affiche correspond a la derniere manche
  // (pour ajuster les confirm dialogs et eviter "Sauter au classement final ?
  // Les manches restantes ne seront pas jouees." quand justement c'est deja
  // la fin).
  // (declare en haut)

  skipFinalBtn.addEventListener("click", () => {
    if (!state.isHost) return;
    // A la derniere manche, c'est l'action attendue (passer au podium), pas de
    // confirm intrusif. Pour une manche intermediaire, on confirme parce qu'on
    // saute du contenu.
    if (isAtLastRoundRecap) {
      conn.send({ type: "skip_to_final" });
      return;
    }
    if (confirm("Sauter au classement final ? Les manches restantes ne seront pas jouées.")) {
      conn.send({ type: "skip_to_final" });
    }
  });
  endGameBtn.addEventListener("click", () => {
    if (!state.isHost) return;
    if (confirm("Quitter la partie maintenant ? Retour au salon.")) {
      conn.send({ type: "end_game" });
    }
  });
  backLobbyBtn.addEventListener("click", () => {
    if (!state.isHost) return;
    conn.send({ type: "end_game" });
  });

  // Event delegation pour les boutons "kick" inseres dans la table de recap.
  // Les boutons sont generes via innerHTML par buildScoreTable, donc on ne
  // peut pas leur attacher de listener individuel ; on ecoute le conteneur.
  recapTableEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".kick-inline-btn[data-kick-target]");
    if (!btn) return;
    const target = btn.getAttribute("data-kick-target");
    if (!target || target === state.myPseudo) return;
    if (!state.isHost) return;
    if (confirm(`Exclure ${target} de la partie ?`)) {
      conn.send({ type: "kick", targetPseudo: target });
    }
  });

  /**
   * Re-rend la table de recap apres un changement de la liste de joueurs
   * (kick, deconnexion definitive). Le worker ne renvoie pas round_ended
   * dans ce cas, donc on doit re-rendre nous-memes en filtrant les
   * resultats sur les joueurs encore presents.
   */
  function refreshRecapTable() {
    if (!lastRecapMsg) return;
    if (!Array.isArray(state.players)) return;
    const stillHere = new Set(state.players.map((p) => p.pseudo));
    const filtered = lastRecapMsg.results.filter((r) => stillHere.has(r.playerId));
    if (filtered.length === lastRecapMsg.results.length) return; // rien a faire
    lastRecapMsg = { ...lastRecapMsg, results: filtered };
    recapTableEl.innerHTML = buildScoreTable(filtered, true);
  }

  document.addEventListener("keydown", onPhysicalKey);

  // =========================================================================
  // Saisie via clavier natif (mobile) : l'input pilote le buffer.
  // =========================================================================
  if (nativeInput) {
    nativeInput.addEventListener("input", () => {
      if (!canType()) {
        nativeInput.value = typingBuffer;
        return;
      }
      setTypingBuffer(nativeInput.value);
    });
    // Entree / bouton "go" du clavier natif -> soumet l'essai.
    nativeInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (canType()) submitGuess();
      }
    });
    // La barre d'accessoire iOS (^ v ✓) declenche blur quand on tape la
    // coche "OK / Done". Si le mot est complet a ce moment-la, on soumet :
    // ainsi la coche valide au lieu de fermer le clavier sans rien faire.
    // Si le mot est incomplet, on ne fait rien (le buffer est preserve, le
    // joueur retouche la grille pour rouvrir le clavier).
    //
    // Garde-fou : sur iOS, taper le bouton "Go" du clavier natif declenche
    // SIMULTANEMENT keydown(Enter) puis blur. Sans dedupe, le mot etait
    // soumis deux fois (visible : la grille se remplissait sur 2 lignes).
    // On verifie qu'on n'a pas deja soumis dans les 300 derniers ms.
    nativeInput.addEventListener("blur", () => {
      if (!canType()) return;
      if (Date.now() - lastSubmitTs < 300) return;
      if (typingBuffer.length === round.wordLength) submitGuess();
    });
  }

  // Taper n'importe ou sur la grille redonne le focus a l'input (rouvre le
  // clavier natif si l'utilisateur l'avait ferme). Mobile uniquement.
  if (gridEl) {
    gridEl.addEventListener("click", () => focusNativeInput());
  }

  // Bouton "↺ reset" : vide entierement le buffer de la ligne courante.
  // Utile quand le curseur iOS se bloque dans l'input ou pour repartir
  // proprement. L'utilisateur devra retaper la 1ere lettre.
  const compResetBtn = document.getElementById("comp-reset-btn");
  if (compResetBtn) {
    compResetBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (!canType()) return;
      setTypingBuffer("");
      focusNativeInput();
    });
  }

  // =========================================================================
  // Reconnexion : restaure l'etat de la manche depuis joined.compRound
  // =========================================================================
  function restoreFromSnapshot(cr) {
    if (!cr) return;
    round.active = true;
    round.revealing = false;
    round.wordLength = cr.wordLength;
    round.maxAttempts = cr.maxAttempts;
    round.firstLetter = cr.firstLetter;
    round.myAttempts = cr.myAttempts || [];
    round.myStatus = cr.myStatus || "playing";
    round.deadlineTs = cr.deadlineTs;
    round.opponents = {};
    for (const o of cr.opponentStates || []) {
      round.opponents[o.playerId] = {
        rows: o.rows || [],
        status: o.status,
        attemptsUsed: o.attemptsUsed,
      };
    }
    typingBuffer = "";
    const totalTxt = cr.totalRounds ? ` / ${cr.totalRounds}` : "";
    roundInfoEl.textContent = `Manche ${cr.roundIndex}${totalTxt}`;
    buildKeyboard();
    buildOpponents(cr.opponents || []);
    renderMyGrid();
    applyAllKeyColors(); // recolore le clavier d'apres les essais soumis
    for (const p of (cr.opponents || [])) renderOpponent(p);
    startTimer();

    if (nativeInput) {
      nativeInput.value = "";
      nativeInput.maxLength = round.wordLength;
    }
    updateLetterCounter();
  }

  /**
   * Retire un adversaire de la course en cours : sa carte disparait. Appele
   * par room.js quand un room_state mid-partie indique qu'un joueur a ete
   * kicke ou s'est deconnecte definitivement (worker cote serveur a deja
   * nettoye compPlayers / compScores et appele maybeEndCompRound).
   */
  function removeOpponent(pseudo) {
    if (!pseudo) return;
    if (round.opponents && round.opponents[pseudo]) {
      delete round.opponents[pseudo];
    }
    const card = opponentsEl.querySelector(`.opp-card[data-pseudo="${cssEscape(pseudo)}"]`);
    if (card) card.remove();
    // Re-evalue la classe "opps-many" (>=4) suite a la suppression.
    const remaining = opponentsEl.querySelectorAll(".opp-card").length;
    opponentsEl.classList.toggle("opps-many", remaining >= 4);
  }

  // Expose les handlers au routeur (room.js)
  return {
    onRoundStarted,
    onGuessResult,
    onOpponentProgress,
    onRoundEnded,
    onGameEnded,
    restoreFromSnapshot,
    stopTimer,
    removeOpponent,
    refreshRecapTable,
    // Pour la safety net : permet a room.js de declencher des pings rapides
    // quand la deadline serveur est depassee sans round_ended.
    getDeadlineTs: () => round.deadlineTs,
  };
}

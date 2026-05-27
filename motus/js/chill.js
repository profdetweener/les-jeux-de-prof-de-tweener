/**
 * Motus chill — orchestrateur de la page solo.
 *
 * Pas de WebSocket, pas de room, pas de pseudo : tout passe par 2 endpoints
 * REST stateless du worker :
 *   - POST /motus/chill/draw   pour tirer un nouveau mot
 *   - POST /motus/chill/guess  pour valider et colorer un essai
 *
 * Mecaniques notables (Livraison 2.2) :
 *   - La 1ere lettre est affichee uniquement sur la ligne courante (pas toutes).
 *   - Les lettres trouvees "good" lors d'essais precedents sont affichees en
 *     "hint" sur la ligne courante TANT QUE l'utilisateur n'a rien tape. Des
 *     qu'il commence a taper, les hints disparaissent et la saisie est libre
 *     (sauf la 1ere lettre, toujours imposee par les regles Motus).
 *   - L'animation des couleurs apres un essai joue lettre par lettre, avec
 *     un petit delai entre chaque case.
 */

import { motusChillDraw, motusChillGuess, motusChillReveal, pingWorker } from "../../shared/js/api.js";
import { showToast } from "../../shared/js/toast.js";
import { fetchDefinition, prefetchDefinition } from "../../shared/js/wiktionary.js";

// =============================================================================
// Bornes et defauts (alignes avec MOTUS_CONFIG cote worker)
// =============================================================================

const MIN_WORD_LEN = 5;
const MAX_WORD_LEN = 10;
const MIN_ATTEMPTS = 4;
const MAX_ATTEMPTS = 8;
const DEFAULT_WORD_LEN = 7;
const DEFAULT_ATTEMPTS = 6;

// Delai entre 2 cases lors de l'animation de feedback (ms)
const REVEAL_DELAY_MS = 400;
// Delai apres la derniere case revelee avant de passer a la suite (ms)
const POST_REVEAL_DELAY_MS = 400;

const KEYBOARD_ROWS = [
  ["A", "Z", "E", "R", "T", "Y", "U", "I", "O", "P"],
  ["Q", "S", "D", "F", "G", "H", "J", "K", "L", "M"],
  ["DEL", "W", "X", "C", "V", "B", "N", "ENTER"],
];

// =============================================================================
// Etat global
// =============================================================================

const config = {
  wordLength: DEFAULT_WORD_LEN,
  maxAttempts: DEFAULT_ATTEMPTS,
};

const game = {
  token: null,
  firstLetter: null,
  wordLength: 0,
  maxAttempts: 0,
  attempts: [],
  status: "idle",
  revealedWord: null,

  /**
   * Positions VRAIMENT verrouillees pour la ligne courante : l'utilisateur
   * ne peut pas y ecrire ni effacer. En pratique : uniquement la position 0
   * (1ere lettre imposee par les regles Motus). Forme : array de longueur
   * wordLength, lettre ou chaine vide.
   */
  lockedRow: [],

  /**
   * Positions affichees comme "hint" (lettres deja trouvees "good" lors des
   * essais precedents). Visuellement identique a lockedRow (style locked-letter),
   * mais ne contraint pas la saisie. Affiche uniquement quand la ligne est vide
   * (l'utilisateur n'a encore rien tape). Forme : array de longueur wordLength.
   */
  hintRow: [],

  /**
   * Buffer de saisie de la ligne courante (longueur fixe wordLength).
   * Les positions verrouillees contiennent leur lettre. Les positions libres
   * contiennent "" tant que l'utilisateur n'a pas tape.
   */
  typingBuffer: [],
};

let keyButtons = {};

// =============================================================================
// Etat de la session (in-memory, perdu au reload)
//
// On enregistre chaque partie TERMINEE (trouvée ou ratée) dans `session.words`
// dans l'ordre chronologique. Les stats sont des compteurs derives recalcules
// a chaque fois pour eviter les desyncs.
// =============================================================================

const session = {
  /**
   * Liste des mots joues, du plus ancien au plus recent.
   * Forme : { word, found, attempts, wordLength, maxAttempts, durationMs }
   */
  words: [],

  /**
   * Serie en cours (mots trouves consecutifs). Reset a chaque mot rate.
   */
  currentStreak: 0,

  /**
   * Meilleure serie de la session.
   */
  bestStreak: 0,

  /**
   * Timestamp (ms) du debut de la partie en cours. null entre les parties.
   * Permet d'afficher un timer live et de calculer la duree finale a
   * l'enregistrement du mot.
   */
  currentStartTime: null,

  /**
   * Intervalle DOM-update du timer live (id renvoye par setInterval).
   */
  liveTimerId: null,
};

// =============================================================================
// References DOM (resolues a l'init)
// =============================================================================

const $ = (id) => document.getElementById(id);
const els = {};

// =============================================================================
// Vues : config / in-game / between
// =============================================================================

function showView(name) {
  const map = {
    config: "view-config",
    in_game: "view-in-game",
    between: "view-between",
  };
  for (const [k, id] of Object.entries(map)) {
    const el = $(id);
    if (el) el.style.display = k === name ? "" : "none";
  }
}

// =============================================================================
// Setup du clavier tactile
// =============================================================================

function buildKeyboard() {
  els.keyboard.innerHTML = "";
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
    els.keyboard.appendChild(rowEl);
  }
}

function resetKeyboardColors() {
  for (const btn of Object.values(keyButtons)) {
    btn.classList.remove("kb-absent", "kb-misplaced", "kb-good", "kb-has-more");
  }
}

/**
 * Met a jour la couleur d'une touche du clavier en fonction du dernier feedback.
 *
 * Regle de monotonie : on ne degrade jamais une couleur (absent < misplaced < good).
 * Le drapeau hasMore est un raffinement de "good" qui s'ajoute sans changer l'ordre.
 * Il est conserve tant que la touche reste "good" — c'est utile car la presence
 * d'une autre occurrence dans le mot ne change pas d'un essai a l'autre.
 *
 * @param {string} letter
 * @param {"absent"|"misplaced"|"good"} status
 * @param {boolean} [hasMore=false] uniquement pertinent quand status="good"
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
  // Drapeau has-more : se cumule avec kb-good. Une fois pose, on le garde
  // (sauf si la touche est ramenee en deçà de "good" — impossible par monotonie).
  if (status === "good" && hasMore) {
    btn.classList.add("kb-has-more");
  }
}

// =============================================================================
// Construction de la grille (vide, pas de pre-remplissage)
// =============================================================================

function rebuildGrid() {
  els.grid.innerHTML = "";
  if (!game.firstLetter) return;
  // --motus-cols est defini sur le parent .game-main pour que .motus-header
  // (frere de .motus-grid) puisse l'heriter aussi et caler sa max-width.
  const parent = els.grid.closest(".game-main") || els.grid.parentElement;
  if (parent) parent.style.setProperty("--motus-cols", String(game.wordLength));
  // Conserve aussi sur le grid (compat retrocompatible avec les regles existantes).
  els.grid.style.setProperty("--motus-cols", String(game.wordLength));

  for (let row = 0; row < game.maxAttempts; row++) {
    const rowEl = document.createElement("div");
    rowEl.className = "motus-row";
    rowEl.dataset.row = String(row);
    for (let col = 0; col < game.wordLength; col++) {
      const cell = document.createElement("div");
      cell.className = "motus-cell";
      cell.dataset.row = String(row);
      cell.dataset.col = String(col);
      rowEl.appendChild(cell);
    }
    els.grid.appendChild(rowEl);
  }
}

// =============================================================================
// Rendu des essais deja faits (re-painting sans animation, ex. apres erreur)
// =============================================================================

function repaintAllPastAttempts() {
  for (let i = 0; i < game.attempts.length; i++) {
    repaintAttemptRowInstant(i, game.attempts[i]);
  }
}

function repaintAttemptRowInstant(rowIndex, attempt) {
  const rowEl = els.grid.querySelector(`.motus-row[data-row="${rowIndex}"]`);
  if (!rowEl) return;
  const cells = rowEl.querySelectorAll(".motus-cell");
  attempt.feedback.forEach((fb, col) => {
    const cell = cells[col];
    if (!cell) return;
    cell.textContent = fb.letter;
    cell.classList.remove("locked-letter", "typing");
    cell.classList.add("filled", `status-${fb.status}`);
    if (fb.hasMore) cell.classList.add("has-more");
    updateKeyColor(fb.letter, fb.status, fb.hasMore);
  });
}

// =============================================================================
// Animation lettre par lettre du feedback
// =============================================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function animateAttemptRow(rowIndex, attempt) {
  const rowEl = els.grid.querySelector(`.motus-row[data-row="${rowIndex}"]`);
  if (!rowEl) return;
  const cells = rowEl.querySelectorAll(".motus-cell");

  // D'abord on s'assure que toutes les cases affichent la lettre tapee sans
  // coloration (etat de transition juste apres la soumission).
  attempt.feedback.forEach((fb, col) => {
    const cell = cells[col];
    if (!cell) return;
    cell.textContent = fb.letter;
    // Retire d'eventuels states de saisie
    cell.classList.remove("typing");
  });

  // Puis on revele case par case
  for (let col = 0; col < attempt.feedback.length; col++) {
    const fb = attempt.feedback[col];
    const cell = cells[col];
    if (!cell) continue;
    cell.classList.remove("locked-letter");
    cell.classList.add("filled", `status-${fb.status}`);
    if (fb.hasMore) cell.classList.add("has-more");
    updateKeyColor(fb.letter, fb.status, fb.hasMore);
    await sleep(REVEAL_DELAY_MS);
  }
  // Petit temps mort pour digerer le resultat avant la prochaine ligne
  await sleep(POST_REVEAL_DELAY_MS);
}

// =============================================================================
// Gestion de la ligne courante : verrouillage, hints, buffer
// =============================================================================

/**
 * Aucune position n'est verrouillee. Conformement aux regles Motus, la 1ere
 * lettre du mot est imposee, mais on prefere la pre-saisir dans typingBuffer
 * (geste "tape tout le mot, premiere lettre comprise" plus instinctif) plutot
 * que de la verrouiller. L'utilisateur peut l'effacer s'il le souhaite.
 *
 * Retourne un tableau toujours vide (de longueur wordLength) — on garde la
 * fonction et la propriete `lockedRow` pour minimiser les modifs ailleurs.
 */
function computeLockedRow() {
  return new Array(game.wordLength).fill("");
}

/**
 * Calcule les positions a afficher comme "hint" (suggestion visuelle, pas
 * contrainte) : ce sont les positions ou une lettre "good" a deja ete revelee
 * lors d'un essai precedent. Inclut aussi la position 0 (1ere lettre).
 */
function computeHintRow() {
  const hint = new Array(game.wordLength).fill("");
  hint[0] = game.firstLetter;
  for (const attempt of game.attempts) {
    attempt.feedback.forEach((fb, col) => {
      if (fb.status === "good") {
        hint[col] = fb.letter;
      }
    });
  }
  return hint;
}

/**
 * Vrai si l'utilisateur n'a encore rien tape "de son propre chef" sur la
 * ligne courante : on ignore la position 0 si elle contient encore la lettre
 * imposee (= etat initial juste apres resetTypingBuffer). Toutes les autres
 * positions doivent etre vides.
 *
 * Sert a decider si on affiche les hints (lettres "good" des essais
 * precedents) sur les positions libres.
 */
function isRowUntouched() {
  for (let i = 0; i < game.wordLength; i++) {
    if (i === 0) {
      // Position 0 : intacte si elle contient encore la 1ere lettre imposee
      if (game.typingBuffer[0] !== game.firstLetter) return false;
      continue;
    }
    if (game.typingBuffer[i]) return false;
  }
  return true;
}

/**
 * Affiche le contenu de la ligne courante en se basant sur :
 *   - typingBuffer (priorite)
 *   - hintRow (uniquement si la ligne est intacte)
 *   - vide sinon
 *
 * Cas particulier de la position 0 : si elle contient encore la 1ere lettre
 * imposee, on l'affiche en style "locked-letter" (visuel pre-rempli identique
 * a la v5). Si l'utilisateur l'a remplacee par autre chose, style "typing"
 * classique. Si vide, on l'affiche comme un hint (visuel locked-letter).
 *
 * Une position non-0 utilise le style "typing" si tapee, ou hint si vide
 * et que la ligne est intacte.
 */
function renderCurrentRow() {
  const idx = game.attempts.length;
  const rowEl = els.grid.querySelector(`.motus-row[data-row="${idx}"]`);
  if (!rowEl) return;
  const cells = rowEl.querySelectorAll(".motus-cell");
  const showHints = isRowUntouched();

  for (let col = 0; col < game.wordLength; col++) {
    const cell = cells[col];
    cell.classList.remove("filled", "typing", "status-good", "status-misplaced", "status-absent", "has-more", "locked-letter");

    if (game.typingBuffer[col]) {
      cell.textContent = game.typingBuffer[col];
      // Position 0 affichee en "locked-letter" quand elle contient encore
      // la lettre attendue, pour signaler visuellement que c'est un pre-remplissage.
      if (col === 0 && game.typingBuffer[0] === game.firstLetter && showHints) {
        cell.classList.add("locked-letter");
      } else {
        cell.classList.add("typing");
      }
    } else if (showHints && game.hintRow[col]) {
      cell.textContent = game.hintRow[col];
      cell.classList.add("locked-letter");
    } else {
      cell.textContent = "";
    }
  }
}

/**
 * Reinitialise le buffer de saisie. Comme aucune position n'est verrouillee,
 * on commence avec toutes les cases vides — sauf la position 0 qu'on
 * pre-remplit avec la 1ere lettre imposee (pure commodite, l'utilisateur peut
 * l'effacer pour la retaper s'il veut).
 */
function resetTypingBuffer() {
  game.typingBuffer = new Array(game.wordLength).fill("");
  game.typingBuffer[0] = game.firstLetter;
}

/**
 * Construit la chaine effective a envoyer au serveur.
 */
function buildGuessString() {
  return game.typingBuffer.join("");
}

/**
 * Vrai si toutes les positions du buffer sont remplies (verrouillees ou tapees).
 */
function isBufferComplete() {
  return game.typingBuffer.every((c) => c !== "");
}

/**
 * Renvoie l'indice de la prochaine position libre apres ou egale a `from`.
 * Une position est "libre" si elle est vide dans le buffer. Toutes les
 * positions sont desormais tapables (plus aucun verrouillage).
 */
function nextFreePos(from) {
  for (let i = from; i < game.wordLength; i++) {
    if (!game.typingBuffer[i]) return i;
  }
  return -1;
}

/**
 * Renvoie l'indice de la derniere position remplie du buffer, ou -1 si
 * tout est vide.
 */
function lastFilledFreePos() {
  for (let i = game.wordLength - 1; i >= 0; i--) {
    if (game.typingBuffer[i]) return i;
  }
  return -1;
}

// =============================================================================
// Saisie : clavier physique + tactile
// =============================================================================

function canType() {
  return game.status === "in_progress" && game.attempts.length < game.maxAttempts;
}

function onKeyPress(key) {
  if (!canType()) return;

  if (key === "ENTER") {
    submitGuess();
    return;
  }
  if (key === "DEL") {
    const idx = lastFilledFreePos();
    if (idx !== -1) {
      game.typingBuffer[idx] = "";
      renderCurrentRow();
    }
    return;
  }
  if (/^[A-Z]$/.test(key)) {
    // Geste instinctif : si la ligne est encore "intacte" (= seule la pre-saisie
    // de la 1ere lettre est presente), la 1ere frappe utilisateur efface cette
    // pre-saisie et redemarre la ligne en position 0. Le joueur tape ainsi le
    // mot complet, premiere lettre comprise.
    if (isRowUntouched() && game.typingBuffer[0] === game.firstLetter) {
      game.typingBuffer[0] = "";
    }
    const pos = nextFreePos(0);
    if (pos === -1) return; // plus de place libre
    game.typingBuffer[pos] = key;
    renderCurrentRow();
  }
}

async function submitGuess() {
  if (!canType()) return;
  if (!isBufferComplete()) {
    flashCurrentRow();
    return;
  }
  const guess = buildGuessString();

  game.status = "submitting";
  try {
    const res = await motusChillGuess(game.token, guess);

    game.attempts.push(res.attempt);
    const rowIndex = game.attempts.length - 1;

    // Animation lettre par lettre (bloque la saisie)
    game.status = "animating";
    await animateAttemptRow(rowIndex, res.attempt);

    // Cas mot trouve : on saute la suite et passe a la vue between
    if (res.status === "found") {
      game.status = "found";
      game.revealedWord = res.revealedWord;
      updateStatus();
      goBetween();
      return;
    }

    // Cas essais epuises : on demande le mot au serveur
    if (game.attempts.length >= game.maxAttempts) {
      try {
        const reveal = await motusChillReveal(game.token);
        game.revealedWord = reveal.revealedWord;
      } catch {
        game.revealedWord = null;
      }
      game.status = "exhausted";
      updateStatus();
      goBetween();
      return;
    }

    // Cas standard : on prepare la ligne suivante
    game.status = "in_progress";
    game.lockedRow = computeLockedRow();
    game.hintRow = computeHintRow();
    resetTypingBuffer();
    renderCurrentRow();
    updateStatus();
  } catch (err) {
    // Le serveur a refuse l'essai (mot pas dans le dico, etc.)
    game.status = "in_progress";
    showToast(err.message || "Essai refuse", { type: "error" });
    flashCurrentRow();
  }
}

function flashCurrentRow() {
  const idx = game.attempts.length;
  const rowEl = els.grid.querySelector(`.motus-row[data-row="${idx}"]`);
  if (!rowEl) return;
  rowEl.classList.add("flash-error");
  setTimeout(() => rowEl.classList.remove("flash-error"), 400);
}

function updateStatus() {
  if (!game.firstLetter) {
    els.statusLine.textContent = "";
    els.wordInfo.textContent = "";
    return;
  }
  els.wordInfo.textContent = `${game.wordLength} lettres`;
  if (game.status === "in_progress" || game.status === "submitting" || game.status === "animating") {
    els.statusLine.textContent = `Essai ${game.attempts.length + 1} / ${game.maxAttempts}`;
  } else if (game.status === "found") {
    const n = game.attempts.length;
    els.statusLine.textContent = `Trouvé en ${n} essai${n > 1 ? "s" : ""} !`;
  } else if (game.status === "exhausted") {
    els.statusLine.textContent = "Essais épuisés.";
  }
}

// =============================================================================
// Ecoute du clavier physique
// =============================================================================

document.addEventListener("keydown", (e) => {
  if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
  // Si la modale de définition est ouverte, on lui laisse la priorité
  // (Escape sera géré par son propre handler, le reste est ignoré).
  if (els.definitionOverlay && els.definitionOverlay.style.display !== "none") return;
  if (!canType()) return;
  if (e.key === "Enter") { onKeyPress("ENTER"); e.preventDefault(); return; }
  if (e.key === "Backspace") { onKeyPress("DEL"); e.preventDefault(); return; }
  const ch = e.key.toUpperCase();
  if (/^[A-Z]$/.test(ch)) {
    onKeyPress(ch);
    e.preventDefault();
  }
});

// =============================================================================
// Session : enregistrement d'une partie et mise a jour des stats
// =============================================================================

/**
 * Formate une duree (en ms) en chaine compacte :
 *   < 1 min : "47s"
 *   < 1 h   : "3m24s"
 *   sinon   : "1h12m"
 *
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec === 0 ? `${min}m` : `${min}m${String(sec).padStart(2, "0")}s`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}m`;
}

/**
 * Demarre le chrono pour une nouvelle partie. Lance le timer live qui
 * rafraichit l'affichage chaque seconde.
 */
function startTimer() {
  session.currentStartTime = Date.now();
  stopLiveTimer(); // au cas ou il en reste un de la partie precedente
  // Rafraichit l'affichage tout de suite puis chaque seconde
  renderStats();
  session.liveTimerId = setInterval(renderStats, 1000);
}

/**
 * Arrete le timer live (entre les parties). N'efface PAS currentStartTime —
 * la duree finale est calculee dans recordSessionWord.
 */
function stopLiveTimer() {
  if (session.liveTimerId !== null) {
    clearInterval(session.liveTimerId);
    session.liveTimerId = null;
  }
}

/**
 * Enregistre la partie qui vient de se terminer (appel depuis goBetween).
 * @param {{found: boolean, word: string, attempts: number, wordLength: number}} entry
 */
function recordSessionWord(entry) {
  session.words.push(entry);
  if (entry.found) {
    session.currentStreak += 1;
    if (session.currentStreak > session.bestStreak) {
      session.bestStreak = session.currentStreak;
    }
  } else {
    session.currentStreak = 0;
  }
  renderStats();
  renderWordList();
  // Prefetch de la def pour rendre le clic sur (i) instantane si l'utilisateur
  // ouvre tout de suite. Silencieux en cas d'echec.
  prefetchDefinition(entry.word);
}

/**
 * Recalcule et affiche toutes les stats a partir de session.words et de
 * l'etat du timer en cours.
 */
function renderStats() {
  const total = session.words.length;
  const foundList = session.words.filter((w) => w.found);
  const foundCount = foundList.length;
  const rate = total > 0 ? Math.round((foundCount / total) * 100) : null;
  const avgAttempts = foundCount > 0
    ? foundList.reduce((s, w) => s + w.attempts, 0) / foundCount
    : null;
  const best = foundCount > 0
    ? Math.min(...foundList.map((w) => w.attempts))
    : null;

  // Timers
  // Total = cumul des durees de TOUTES les parties terminees + duree de la
  //         partie en cours si applicable.
  const totalDurationTerminated = session.words.reduce(
    (s, w) => s + (w.durationMs || 0),
    0
  );
  const liveDuration = session.currentStartTime !== null
    ? Date.now() - session.currentStartTime
    : 0;
  const totalDuration = totalDurationTerminated + liveDuration;

  // Moyenne par mot trouve (sur les parties terminees uniquement).
  const foundDurations = foundList
    .map((w) => w.durationMs)
    .filter((d) => Number.isFinite(d) && d > 0);
  const avgDuration = foundDurations.length > 0
    ? foundDurations.reduce((s, d) => s + d, 0) / foundDurations.length
    : null;

  setText("stat-games", String(total));
  setText("stat-found", String(foundCount));
  setText("stat-rate", rate == null ? "—" : `${rate}%`);
  setText("stat-avg", avgAttempts == null ? "—" : avgAttempts.toFixed(1));
  setText("stat-best", best == null ? "—" : `${best} essai${best > 1 ? "s" : ""}`);
  setText("stat-streak", String(session.currentStreak));
  setText("stat-streak-best", String(session.bestStreak));

  // Timers
  setText("stat-time-total", totalDuration > 0 ? formatDuration(totalDuration) : "—");
  setText("stat-time-avg", avgDuration == null ? "—" : formatDuration(avgDuration));
  setText("stat-time-live", session.currentStartTime !== null
    ? formatDuration(liveDuration)
    : "—");
}

/**
 * Reconstruit la liste des mots joues dans la sidebar.
 */
function renderWordList() {
  const ul = els.wordList;
  if (!ul) return;
  ul.innerHTML = "";

  if (session.words.length === 0) {
    const empty = document.createElement("li");
    empty.className = "word-list-empty";
    empty.textContent = "Aucun mot joué pour l'instant.";
    ul.appendChild(empty);
    return;
  }

  // Plus recent en haut pour confort de lecture
  for (let i = session.words.length - 1; i >= 0; i--) {
    const entry = session.words[i];
    const li = document.createElement("li");
    li.className = "word-item";
    if (Number.isFinite(entry.durationMs) && entry.durationMs > 0) {
      li.title = `Trouvé en ${formatDuration(entry.durationMs)}`;
      if (!entry.found) {
        li.title = `Manqué après ${formatDuration(entry.durationMs)}`;
      }
    }

    const left = document.createElement("span");
    left.className = "word-item-text";

    const status = document.createElement("span");
    status.className = `word-item-status ${entry.found ? "found" : "missed"}`;
    status.textContent = entry.found ? "✓" : "✗";
    status.setAttribute("aria-label", entry.found ? "trouvé" : "manqué");

    const word = document.createElement("span");
    word.className = "word-item-word";
    word.textContent = entry.word;

    const attempts = document.createElement("span");
    attempts.className = "word-item-attempts";
    if (entry.found) {
      attempts.textContent = `${entry.attempts}/${entry.maxAttempts}`;
    } else {
      attempts.textContent = "raté";
    }

    left.appendChild(status);
    left.appendChild(word);
    left.appendChild(attempts);

    const info = document.createElement("button");
    info.type = "button";
    info.className = "word-item-info";
    info.textContent = "i";
    info.setAttribute("aria-label", `Voir la définition de ${entry.word}`);
    info.addEventListener("click", () => openDefinition(entry.word));

    li.appendChild(left);
    li.appendChild(info);
    ul.appendChild(li);
  }
}

function setText(id, txt) {
  const el = document.getElementById(id);
  if (el) el.textContent = txt;
}

// =============================================================================
// Modale de definition (Wiktionary)
// =============================================================================

let lastFocusedBeforeModal = null;

async function openDefinition(word) {
  const overlay = els.definitionOverlay;
  const title = els.definitionTitle;
  const body = els.definitionBody;
  const sourceLink = els.definitionSourceLink;
  if (!overlay || !title || !body) return;

  lastFocusedBeforeModal = document.activeElement;

  title.textContent = word.toUpperCase();
  body.innerHTML = `<p class="definition-loading">Chargement de la définition…</p>`;
  sourceLink.href = `https://fr.wiktionary.org/wiki/${encodeURIComponent(word.toLowerCase())}`;
  overlay.style.display = "";
  // Focus le bouton de fermeture pour accessibilite
  setTimeout(() => els.definitionClose?.focus(), 0);

  try {
    const def = await fetchDefinition(word);
    sourceLink.href = def.sourceUrl;
    renderDefinitionEntries(def.entries, body);
  } catch (err) {
    body.innerHTML = "";
    const p = document.createElement("p");
    p.className = "definition-error";
    p.textContent = err.message || "Définition indisponible.";
    body.appendChild(p);
  }
}

function renderDefinitionEntries(entries, container) {
  container.innerHTML = "";
  for (const entry of entries) {
    const pos = document.createElement("p");
    pos.className = "def-pos";
    pos.textContent = entry.partOfSpeech;
    container.appendChild(pos);

    const ol = document.createElement("ol");
    for (const def of entry.definitions) {
      const li = document.createElement("li");
      li.textContent = def.text;
      for (const ex of def.examples) {
        const exEl = document.createElement("span");
        exEl.className = "def-example";
        exEl.textContent = `« ${ex} »`;
        li.appendChild(exEl);
      }
      ol.appendChild(li);
    }
    container.appendChild(ol);
  }
}

function closeDefinition() {
  const overlay = els.definitionOverlay;
  if (!overlay) return;
  overlay.style.display = "none";
  if (lastFocusedBeforeModal && typeof lastFocusedBeforeModal.focus === "function") {
    lastFocusedBeforeModal.focus();
  }
}

// =============================================================================
// Transitions de vues
// =============================================================================

function goBetween() {
  // Calcule la duree de la partie qui vient de se terminer (si on a un
  // startTime — sinon on stocke null, signalant une duree non mesurable).
  let durationMs = null;
  if (session.currentStartTime !== null) {
    durationMs = Date.now() - session.currentStartTime;
    session.currentStartTime = null;
  }
  stopLiveTimer();

  // Enregistre la partie dans la session (stats + word list).
  // On le fait ici et nulle part ailleurs pour eviter le double comptage :
  // c'est le seul point d'entree de la vue "between".
  if (game.firstLetter && game.revealedWord) {
    recordSessionWord({
      found: game.status === "found",
      word: game.revealedWord,
      attempts: game.attempts.length,
      wordLength: game.wordLength,
      maxAttempts: game.maxAttempts,
      durationMs,
    });
  }

  if (game.status === "found") {
    els.betweenSummary.textContent = "Tu as trouvé le mot ! 🎉";
    els.betweenSummary.className = "between-summary success";
  } else {
    els.betweenSummary.textContent = "Essais épuisés. Le mot était :";
    els.betweenSummary.className = "between-summary failure";
  }
  els.betweenWord.textContent = game.revealedWord || "?";
  showView("between");
}

async function startNewWord() {
  // Reset etat du round
  game.attempts = [];
  game.status = "in_progress";
  game.revealedWord = null;
  resetKeyboardColors();

  els.startBtn.disabled = true;
  const previousLabel = els.startBtn.textContent;
  els.startBtn.textContent = "Tirage…";

  try {
    const res = await motusChillDraw(config.wordLength, config.maxAttempts);
    game.token = res.token;
    game.firstLetter = res.firstLetter;
    game.wordLength = res.wordLength;
    game.maxAttempts = res.maxAttempts;

    rebuildGrid();
    // Initialise la ligne courante : 1ere lettre verrouillee, pas de hints (1er tour)
    game.lockedRow = computeLockedRow();
    game.hintRow = computeHintRow();
    resetTypingBuffer();
    renderCurrentRow();
    updateStatus();
    showView("in_game");
    // Demarre le chrono pour cette partie (et lance le timer live)
    startTimer();
  } catch (err) {
    showError(err.message || "Impossible de tirer un mot.");
  } finally {
    els.startBtn.disabled = false;
    els.startBtn.textContent = previousLabel;
  }
}

// =============================================================================
// Config view : lecture des inputs + lancement
// =============================================================================

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function readConfigFromInputs() {
  config.wordLength = clampInt(els.wordLengthInput.value, MIN_WORD_LEN, MAX_WORD_LEN, DEFAULT_WORD_LEN);
  config.maxAttempts = clampInt(els.maxAttemptsInput.value, MIN_ATTEMPTS, MAX_ATTEMPTS, DEFAULT_ATTEMPTS);
  els.wordLengthInput.value = String(config.wordLength);
  els.maxAttemptsInput.value = String(config.maxAttempts);
}

function showError(msg) {
  els.errorBox.textContent = msg;
  els.errorBox.classList.add("show");
}

function clearError() {
  els.errorBox.classList.remove("show");
  els.errorBox.textContent = "";
}

// =============================================================================
// Init
// =============================================================================

function bindElements() {
  els.serverStatus = $("server-status");
  els.errorBox = $("error-box");

  els.wordLengthInput = $("word-length-input");
  els.maxAttemptsInput = $("max-attempts-input");
  els.startBtn = $("start-btn");

  els.grid = $("motus-grid");
  els.keyboard = $("motus-keyboard");
  els.statusLine = $("motus-status");
  els.wordInfo = $("motus-word-info");

  els.betweenSummary = $("between-summary");
  els.betweenWord = $("between-word");
  els.nextWordBtn = $("next-word-btn");
  els.backToConfigBtn = $("back-to-config-btn");

  // Sidebar stats + word list
  els.wordList = $("word-list");

  // Modale definition
  els.definitionOverlay = $("definition-overlay");
  els.definitionTitle = $("definition-title");
  els.definitionBody = $("definition-body");
  els.definitionSourceLink = $("definition-source-link");
  els.definitionClose = $("definition-close");
}

async function init() {
  bindElements();
  buildKeyboard();

  // Affiche les stats à zéro et la liste vide au démarrage
  renderStats();
  renderWordList();

  pingWorker().then((ok) => {
    els.serverStatus.textContent = ok ? "✓ serveur en ligne" : "✗ serveur injoignable";
    if (!ok) showError("Impossible de joindre le serveur. Vérifie ta connexion.");
  });

  els.startBtn.addEventListener("click", () => {
    clearError();
    readConfigFromInputs();
    startNewWord();
  });

  els.nextWordBtn.addEventListener("click", () => {
    startNewWord();
  });

  els.backToConfigBtn.addEventListener("click", () => {
    showView("config");
  });

  // Fermeture de la modale définition : bouton, clic overlay, touche Escape
  if (els.definitionClose) {
    els.definitionClose.addEventListener("click", closeDefinition);
  }
  if (els.definitionOverlay) {
    els.definitionOverlay.addEventListener("click", (e) => {
      // Ferme seulement si on clique sur le fond, pas sur le contenu de la modale
      if (e.target === els.definitionOverlay) closeDefinition();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && els.definitionOverlay && els.definitionOverlay.style.display !== "none") {
      closeDefinition();
    }
  });

  showView("config");
}

init();

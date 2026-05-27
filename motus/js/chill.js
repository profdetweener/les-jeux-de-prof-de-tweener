/**
 * Motus chill — orchestrateur de la page solo.
 *
 * Pas de WebSocket, pas de room, pas de pseudo : tout passe par 2 endpoints
 * REST stateless du worker :
 *   - POST /motus/chill/draw   pour tirer un nouveau mot
 *   - POST /motus/chill/guess  pour valider et colorer un essai
 *
 * Mecaniques notables (Livraison 2.1) :
 *   - La 1ere lettre est affichee uniquement sur la ligne courante (pas toutes).
 *   - Les lettres trouvees "good" (avec ou sans hasMore) sont reportees a la
 *     bonne position sur la ligne suivante, en lettres verrouillees blanches.
 *   - L'animation des couleurs apres un essai joue lettre par lettre, avec
 *     un petit delai entre chaque case.
 */

import { motusChillDraw, motusChillGuess, motusChillReveal, pingWorker } from "../../shared/js/api.js";
import { showToast } from "../../shared/js/toast.js";

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
const REVEAL_DELAY_MS = 220;
// Delai apres la derniere case revelee avant de passer a la suite (ms)
const POST_REVEAL_DELAY_MS = 300;

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
  token: null,         // token signe du worker
  firstLetter: null,   // premiere lettre imposee (= letter[0] du mot cible)
  wordLength: 0,
  maxAttempts: 0,
  attempts: [],        // [{guess, feedback}]
  status: "idle",      // idle | in_progress | submitting | animating | found | exhausted
  revealedWord: null,

  /**
   * Pour la ligne courante (= attempts.length), liste des positions verrouillees
   * avec leur lettre. Inclut toujours la position 0 (premiere lettre du mot) et,
   * apres au moins un essai, toutes les positions "good" des essais precedents.
   * Forme : array de longueur wordLength, chaque case vaut soit une lettre A-Z
   * soit la chaine vide.
   */
  lockedRow: [],

  /**
   * Buffer de saisie de la ligne courante (longueur fixe wordLength).
   * Les positions verrouillees contiennent la lettre (toujours egale a lockedRow[i]).
   * Les positions libres contiennent "" tant que l'utilisateur n'a pas tape.
   */
  typingBuffer: [],
};

let keyButtons = {};

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
    btn.classList.remove("kb-absent", "kb-misplaced", "kb-good");
  }
}

function updateKeyColor(letter, status) {
  const btn = keyButtons[letter];
  if (!btn) return;
  const order = { absent: 0, misplaced: 1, good: 2 };
  const current = ["absent", "misplaced", "good"].find((s) => btn.classList.contains(`kb-${s}`));
  if (!current || order[status] > order[current]) {
    btn.classList.remove("kb-absent", "kb-misplaced", "kb-good");
    btn.classList.add(`kb-${status}`);
  }
}

// =============================================================================
// Construction de la grille (vide, pas de pre-remplissage)
// =============================================================================

function rebuildGrid() {
  els.grid.innerHTML = "";
  if (!game.firstLetter) return;
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
    updateKeyColor(fb.letter, fb.status);
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
    updateKeyColor(fb.letter, fb.status);
    await sleep(REVEAL_DELAY_MS);
  }
  // Petit temps mort pour digerer le resultat avant la prochaine ligne
  await sleep(POST_REVEAL_DELAY_MS);
}

// =============================================================================
// Gestion de la ligne courante : lettres verrouillees + buffer
// =============================================================================

/**
 * Calcule les positions verrouillees pour la ligne d'index donne, en se basant
 * sur les essais precedents. Position 0 toujours verrouillee avec firstLetter.
 * Autres positions verrouillees si une lettre "good" y a deja ete trouvee.
 */
function computeLockedRow() {
  const locked = new Array(game.wordLength).fill("");
  locked[0] = game.firstLetter;
  for (const attempt of game.attempts) {
    attempt.feedback.forEach((fb, col) => {
      if (fb.status === "good") {
        locked[col] = fb.letter;
      }
    });
  }
  return locked;
}

/**
 * Affiche les lettres verrouillees sur la ligne courante (uniquement).
 * Ne touche pas aux lignes precedentes ni suivantes.
 */
function paintLockedRow() {
  const idx = game.attempts.length;
  const rowEl = els.grid.querySelector(`.motus-row[data-row="${idx}"]`);
  if (!rowEl) return;
  const cells = rowEl.querySelectorAll(".motus-cell");

  for (let col = 0; col < game.wordLength; col++) {
    const cell = cells[col];
    cell.classList.remove("filled", "typing", "status-good", "status-misplaced", "status-absent", "has-more");
    if (game.lockedRow[col]) {
      cell.textContent = game.lockedRow[col];
      cell.classList.add("locked-letter");
    } else {
      cell.textContent = "";
    }
  }
}

/**
 * Affiche les lettres "en cours de saisie" sur la ligne courante.
 * Les positions verrouillees gardent leur classe locked-letter ; les positions
 * libres remplies par l'utilisateur prennent la classe typing.
 */
function renderTypingRow() {
  const idx = game.attempts.length;
  const rowEl = els.grid.querySelector(`.motus-row[data-row="${idx}"]`);
  if (!rowEl) return;
  const cells = rowEl.querySelectorAll(".motus-cell");

  for (let col = 0; col < game.wordLength; col++) {
    const cell = cells[col];
    const isLocked = game.lockedRow[col] !== "";
    cell.classList.remove("filled", "status-good", "status-misplaced", "status-absent", "has-more");

    if (isLocked) {
      cell.textContent = game.lockedRow[col];
      cell.classList.add("locked-letter");
      cell.classList.remove("typing");
    } else if (game.typingBuffer[col]) {
      cell.textContent = game.typingBuffer[col];
      cell.classList.add("typing");
      cell.classList.remove("locked-letter");
    } else {
      cell.textContent = "";
      cell.classList.remove("locked-letter", "typing");
    }
  }
}

/**
 * Initialise le buffer de saisie pour la ligne courante : les positions
 * verrouillees prennent leur lettre, les autres restent vides.
 */
function resetTypingBuffer() {
  game.typingBuffer = game.lockedRow.map((l) => l);
}

/**
 * Construit la chaine effective a envoyer au serveur a partir du buffer.
 * Les positions verrouillees sont deja remplies, donc la chaine est complete
 * si toutes les positions libres ont ete remplies par l'utilisateur.
 */
function buildGuessString() {
  return game.typingBuffer.join("");
}

/**
 * Vrai si toutes les positions du buffer sont remplies (verrouillees ou non).
 */
function isBufferComplete() {
  return game.typingBuffer.every((c) => c !== "");
}

/**
 * Renvoie l'indice de la prochaine position libre apres ou egale a `from`,
 * ou -1 s'il n'y en a plus.
 */
function nextFreePos(from) {
  for (let i = from; i < game.wordLength; i++) {
    if (game.lockedRow[i] === "" && !game.typingBuffer[i]) return i;
  }
  return -1;
}

/**
 * Renvoie l'indice de la derniere position libre remplie (la plus a droite),
 * ou -1 si tout est vide ou tout verrouille.
 */
function lastFilledFreePos() {
  for (let i = game.wordLength - 1; i >= 0; i--) {
    if (game.lockedRow[i] === "" && game.typingBuffer[i]) return i;
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
      renderTypingRow();
    }
    return;
  }
  if (/^[A-Z]$/.test(key)) {
    const pos = nextFreePos(0);
    if (pos === -1) return; // plus de place libre
    game.typingBuffer[pos] = key;
    renderTypingRow();
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
    resetTypingBuffer();
    paintLockedRow();
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
// Transitions de vues
// =============================================================================

function goBetween() {
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
    // Initialise la ligne courante avec la 1ere lettre verrouillee
    game.lockedRow = computeLockedRow();
    resetTypingBuffer();
    paintLockedRow();
    updateStatus();
    showView("in_game");
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
}

async function init() {
  bindElements();
  buildKeyboard();

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

  showView("config");
}

init();

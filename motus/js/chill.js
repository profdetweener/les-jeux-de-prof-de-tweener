/**
 * Motus chill — orchestrateur de la page solo.
 *
 * Pas de WebSocket, pas de room, pas de pseudo : tout passe par 2 endpoints
 * REST stateless du worker :
 *   - POST /motus/chill/draw   pour tirer un nouveau mot
 *   - POST /motus/chill/guess  pour valider et colorer un essai
 *
 * Le mot est cache cote serveur via un token signe (HMAC). Le client envoie
 * le token avec chaque essai ; le serveur le verifie et renvoie la coloration.
 *
 * Le rendu (grille + clavier) reprend la meme logique visuelle que view-game.js
 * en multijoueur, mais simplifie pour le cas solo.
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
  firstLetter: null,   // premiere lettre imposee
  wordLength: 0,
  maxAttempts: 0,
  attempts: [],        // [{guess, feedback}]
  status: "idle",      // idle | in_progress | found | exhausted
  revealedWord: null,
};

let typingBuffer = "";
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
// Construction et rendu de la grille
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
      if (col === 0) {
        cell.textContent = game.firstLetter;
        cell.classList.add("locked-letter");
      }
      rowEl.appendChild(cell);
    }
    els.grid.appendChild(rowEl);
  }

  for (let i = 0; i < game.attempts.length; i++) {
    paintAttemptRow(i, game.attempts[i]);
  }
  renderCurrentTypingRow();
}

function paintAttemptRow(rowIndex, attempt) {
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
  });
  attempt.feedback.forEach((fb) => updateKeyColor(fb.letter, fb.status));
}

function renderCurrentTypingRow() {
  if (game.status !== "in_progress") return;
  const idx = game.attempts.length;
  const rowEl = els.grid.querySelector(`.motus-row[data-row="${idx}"]`);
  if (!rowEl) return;
  const cells = rowEl.querySelectorAll(".motus-cell");

  for (let col = 0; col < game.wordLength; col++) {
    const cell = cells[col];
    cell.classList.remove("filled", "typing", "status-good", "status-misplaced", "status-absent", "has-more");
    if (col === 0) {
      cell.textContent = game.firstLetter;
      cell.classList.add("locked-letter");
    } else if (col < typingBuffer.length) {
      cell.textContent = typingBuffer[col];
      cell.classList.add("typing");
    } else {
      cell.textContent = "";
    }
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
  if (game.status === "in_progress") {
    els.statusLine.textContent = `Essai ${game.attempts.length + 1} / ${game.maxAttempts}`;
  } else if (game.status === "found") {
    const n = game.attempts.length;
    els.statusLine.textContent = `Trouvé en ${n} essai${n > 1 ? "s" : ""} !`;
  } else if (game.status === "exhausted") {
    els.statusLine.textContent = "Essais épuisés.";
  }
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
    // On ne laisse pas effacer la 1ere lettre verrouillee
    if (typingBuffer.length > 1) {
      typingBuffer = typingBuffer.slice(0, -1);
    } else {
      typingBuffer = "";
    }
    renderCurrentTypingRow();
    return;
  }
  if (/^[A-Z]$/.test(key)) {
    if (typingBuffer.length === 0) {
      typingBuffer = game.firstLetter;
    }
    if (typingBuffer.length < game.wordLength) {
      typingBuffer += key;
      renderCurrentTypingRow();
    }
  }
}

async function submitGuess() {
  if (!canType()) return;
  if (typingBuffer.length !== game.wordLength) {
    flashCurrentRow();
    return;
  }
  const guess = typingBuffer;

  // Desactive temporairement la saisie pendant le round-trip serveur
  game.status = "submitting";
  try {
    const res = await motusChillGuess(game.token, guess);
    // Reactive
    game.status = "in_progress";

    game.attempts.push(res.attempt);
    paintAttemptRow(game.attempts.length - 1, res.attempt);
    typingBuffer = "";
    renderCurrentTypingRow();

    if (res.status === "found") {
      game.status = "found";
      game.revealedWord = res.revealedWord;
      updateStatus();
      setTimeout(() => goBetween(), 900);
      return;
    }

    // Essais epuises ? Le serveur renvoie in_progress meme dans ce cas, c'est
    // le client qui detecte. Si on vient d'utiliser le dernier essai, on demande
    // au serveur de reveler le mot.
    if (game.attempts.length >= game.maxAttempts) {
      try {
        const reveal = await motusChillReveal(game.token);
        game.revealedWord = reveal.revealedWord;
      } catch {
        game.revealedWord = null;
      }
      game.status = "exhausted";
      updateStatus();
      setTimeout(() => goBetween(), 900);
      return;
    }

    updateStatus();
  } catch (err) {
    game.status = "in_progress";
    showToast(err.message || "Essai refuse", { type: "error" });
    // Garde le buffer pour que l'utilisateur puisse corriger sans tout retaper
    flashCurrentRow();
  }
}

// =============================================================================
// Ecoute du clavier physique
// =============================================================================

document.addEventListener("keydown", (e) => {
  // Si on est dans un input (config), on ne capture pas
  if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
  if (game.status !== "in_progress") return;
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
  typingBuffer = "";
  resetKeyboardColors();

  // Desactive le bouton pendant le tirage pour eviter double-clic
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
  // Reflete les valeurs corrigees dans les inputs
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

  // Indique l'etat du serveur (purement informatif)
  pingWorker().then((ok) => {
    els.serverStatus.textContent = ok ? "✓ serveur en ligne" : "✗ serveur injoignable";
    if (!ok) {
      showError("Impossible de joindre le serveur. Vérifie ta connexion.");
    }
  });

  // Lance la partie depuis l'ecran de config
  els.startBtn.addEventListener("click", () => {
    clearError();
    readConfigFromInputs();
    startNewWord();
  });

  // Mot suivant : on garde la meme config, on tire un nouveau mot
  els.nextWordBtn.addEventListener("click", () => {
    startNewWord();
  });

  // Retour a la config (pour changer longueur du mot ou nb d'essais)
  els.backToConfigBtn.addEventListener("click", () => {
    showView("config");
  });

  showView("config");
}

init();

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
   * Forme : { word: "MAISON", found: true, attempts: 3, wordLength: 6 }
   * - attempts = nombre d'essais consommes (1..maxAttempts si found,
   *              = maxAttempts si raté).
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
// Gestion de la ligne courante : verrouillage, hints, buffer
// =============================================================================

/**
 * Calcule les positions VRAIMENT verrouillees. Conformement aux regles Motus,
 * seule la position 0 est imposee (= 1ere lettre du mot cible).
 */
function computeLockedRow() {
  const locked = new Array(game.wordLength).fill("");
  locked[0] = game.firstLetter;
  return locked;
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
 * Vrai si l'utilisateur n'a encore tape aucune lettre sur la ligne courante
 * (= toutes les positions libres sont vides). Sert a decider si on affiche
 * les hints ou non.
 */
function isRowUntouched() {
  for (let i = 0; i < game.wordLength; i++) {
    // On ignore les positions verrouillees (elles sont remplies par definition)
    if (game.lockedRow[i] !== "") continue;
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
 * Une position verrouillee ou un hint utilisent le style locked-letter
 * (texte bleu sombre sur fond blanc). Une lettre tapee par l'utilisateur
 * utilise le style typing (texte avec bordure bleu accent).
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

    if (game.lockedRow[col]) {
      cell.textContent = game.lockedRow[col];
      cell.classList.add("locked-letter");
    } else if (game.typingBuffer[col]) {
      cell.textContent = game.typingBuffer[col];
      cell.classList.add("typing");
    } else if (showHints && game.hintRow[col]) {
      cell.textContent = game.hintRow[col];
      cell.classList.add("locked-letter");
    } else {
      cell.textContent = "";
    }
  }
}

/**
 * Reinitialise le buffer de saisie : les positions verrouillees prennent
 * leur lettre, les autres restent vides.
 */
function resetTypingBuffer() {
  game.typingBuffer = game.lockedRow.map((l) => l);
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
 * Une position est "libre" si elle n'est pas verrouillee ET pas deja remplie
 * dans le buffer. Les hints ne comptent PAS comme remplissage (ils ne sont
 * pas dans typingBuffer).
 */
function nextFreePos(from) {
  for (let i = from; i < game.wordLength; i++) {
    if (game.lockedRow[i] === "" && !game.typingBuffer[i]) return i;
  }
  return -1;
}

/**
 * Renvoie l'indice de la derniere position remplie (non verrouillee) du
 * buffer, ou -1 si rien n'est rempli librement.
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
      renderCurrentRow();
    }
    return;
  }
  if (/^[A-Z]$/.test(key)) {
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
 * Recalcule et affiche toutes les stats a partir de session.words.
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

  setText("stat-games", String(total));
  setText("stat-found", String(foundCount));
  setText("stat-rate", rate == null ? "—" : `${rate}%`);
  setText("stat-avg", avgAttempts == null ? "—" : avgAttempts.toFixed(1));
  setText("stat-best", best == null ? "—" : `${best} essai${best > 1 ? "s" : ""}`);
  setText("stat-streak", String(session.currentStreak));
  setText("stat-streak-best", String(session.bestStreak));
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

/**
 * Mode chill solo de Definitions.
 *
 * Charge la banque de mots une fois au demarrage de la page (cf.
 * GET /definitions/words), puis shuffle cote client et iterare. Pas de
 * Durable Object, pas de WebSocket : tout est local. Les stats de session
 * sont gardees en memoire uniquement (pas de persistance entre sessions
 * pour rester simple ; on pourra ajouter du localStorage plus tard).
 *
 * Vues :
 *   - view-config   : choix du type d'entree (mots/expressions/all) + floutage
 *   - view-in-game  : un mot + sa definition + actions (connu / a retenir / suivant)
 *   - view-finished : banque epuisee (rare en pratique, mais propre)
 */

import { fetchDefinitionWords, pingWorker } from "../../shared/js/api.js";
import { showToast } from "../../shared/js/toast.js";

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const viewConfig = document.getElementById("view-config");
const viewInGame = document.getElementById("view-in-game");
const viewFinished = document.getElementById("view-finished");

const serverStatus = document.getElementById("server-status");
const errorBox = document.getElementById("error-box");

const entryTypeInput = document.getElementById("entry-type-input");
const entryTypeHint = document.getElementById("entry-type-hint");
const blurFirstInput = document.getElementById("blur-first-input");
const startBtn = document.getElementById("start-btn");

const wordEl = document.getElementById("chill-word");
const defBlock = document.getElementById("chill-def-block");
const defTextEl = document.getElementById("chill-def-text");
const defRevealBtn = document.getElementById("chill-def-reveal");
const counterEl = document.getElementById("chill-counter");

const statSeen = document.getElementById("stat-seen");
const statKnown = document.getElementById("stat-known");
const statUnknown = document.getElementById("stat-unknown");
const statRemaining = document.getElementById("stat-remaining");
const wordListEl = document.getElementById("word-list");

const btnMarkUnknown = document.getElementById("btn-mark-unknown");
const btnMarkKnown = document.getElementById("btn-mark-known");
const btnNext = document.getElementById("btn-next");
const btnBackConfig = document.getElementById("btn-back-config");
const btnRestart = document.getElementById("btn-restart");
const finishedCount = document.getElementById("finished-count");

// ---------------------------------------------------------------------------
// Etat session
// ---------------------------------------------------------------------------

/** Banque complete telechargee au demarrage. */
let allWords = [];
/** Sous-ensemble filtre selon le type d'entree, melange. */
let queue = [];
/** Position courante dans queue (index du mot affiche). */
let cursor = 0;
/** Mots de la session, en ordre d'apparition, avec statut. */
const sessionLog = [];
/** Si true, la def est floutee tant qu'on ne clique pas. */
let blurMode = false;

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

/** Une expression = un mot qui contient au moins un espace ou un trait d'union long. */
function isExpression(entry) {
  return /\s/.test(entry.word);
}

/** Fisher-Yates. */
function shuffle(arr) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.add("show");
}
function clearError() {
  errorBox.classList.remove("show");
  errorBox.textContent = "";
}

function updateEntryTypeHint() {
  if (!allWords.length) {
    entryTypeHint.textContent = "—";
    return;
  }
  const all = allWords.length;
  const expr = allWords.filter(isExpression).length;
  const words = all - expr;
  const v = entryTypeInput.value;
  if (v === "all") entryTypeHint.textContent = `${all} entrées disponibles`;
  else if (v === "words") entryTypeHint.textContent = `${words} mots disponibles`;
  else entryTypeHint.textContent = `${expr} expressions disponibles`;
}

// ---------------------------------------------------------------------------
// Vues
// ---------------------------------------------------------------------------

function showView(name) {
  viewConfig.style.display = name === "config" ? "block" : "none";
  viewInGame.style.display = name === "game" ? "block" : "none";
  viewFinished.style.display = name === "finished" ? "block" : "none";
}

// ---------------------------------------------------------------------------
// Demarrage : ping serveur + chargement banque
// ---------------------------------------------------------------------------

async function bootstrap() {
  const ok = await pingWorker();
  if (!ok) {
    serverStatus.textContent = "✗ serveur injoignable";
    showError(
      "Impossible de joindre le serveur pour charger la banque de mots. " +
      "Verifie ta connexion."
    );
    return;
  }
  serverStatus.textContent = "✓ chargement de la banque…";
  try {
    const { words } = await fetchDefinitionWords();
    if (!Array.isArray(words) || words.length === 0) {
      throw new Error("Banque vide");
    }
    allWords = words;
    serverStatus.textContent = `✓ ${words.length} entrées chargées`;
    startBtn.disabled = false;
    startBtn.textContent = "Lancer la partie";
    updateEntryTypeHint();
  } catch (err) {
    console.error(err);
    serverStatus.textContent = "✗ banque indisponible";
    showError("Impossible de charger la banque de mots. Reessaie plus tard.");
  }
}

// ---------------------------------------------------------------------------
// Logique de jeu
// ---------------------------------------------------------------------------

function startGame() {
  clearError();
  // Filtrage selon le type choisi
  const v = entryTypeInput.value;
  let pool;
  if (v === "words") pool = allWords.filter((e) => !isExpression(e));
  else if (v === "expressions") pool = allWords.filter(isExpression);
  else pool = allWords.slice();

  if (pool.length === 0) {
    showError("Aucune entrée disponible pour ce filtre.");
    return;
  }

  queue = shuffle(pool);
  cursor = 0;
  sessionLog.length = 0;
  blurMode = blurFirstInput.checked;
  renderWordList();
  updateStats();
  showView("game");
  showCurrent();
}

function showCurrent() {
  if (cursor >= queue.length) {
    finishedCount.textContent = String(queue.length);
    showView("finished");
    return;
  }
  const entry = queue[cursor];
  wordEl.textContent = entry.word;
  defTextEl.textContent = entry.definition;
  counterEl.textContent = `Mot ${cursor + 1} / ${queue.length}`;
  // Reset etat de floutage
  if (blurMode) {
    defBlock.classList.add("is-blurred");
    defRevealBtn.style.display = "flex";
  } else {
    defBlock.classList.remove("is-blurred");
    defRevealBtn.style.display = "none";
  }
  updateStats();
}

function revealDef() {
  defBlock.classList.remove("is-blurred");
  defRevealBtn.style.display = "none";
}

/**
 * Avance au mot suivant. Si un statut est fourni (known/unknown), on l'ajoute
 * au journal de session ; sinon on passe simplement sans noter.
 */
function nextWord(status) {
  if (cursor >= queue.length) return;
  if (status) {
    sessionLog.push({ entry: queue[cursor], status });
    renderWordList();
  }
  cursor += 1;
  showCurrent();
}

function updateStats() {
  const seen = sessionLog.length;
  const known = sessionLog.filter((x) => x.status === "known").length;
  const unknown = sessionLog.filter((x) => x.status === "unknown").length;
  const remaining = Math.max(0, queue.length - cursor);
  statSeen.textContent = String(seen);
  statKnown.textContent = String(known);
  statUnknown.textContent = String(unknown);
  statRemaining.textContent = String(remaining);
}

function renderWordList() {
  if (sessionLog.length === 0) {
    wordListEl.innerHTML = '<li class="chill-word-list-empty">Aucun mot vu pour l\'instant.</li>';
    return;
  }
  // Plus recent en haut
  const items = sessionLog.slice().reverse().map((x) => {
    const cls = x.status === "known" ? "known" : "unknown";
    const icon = x.status === "known" ? "✓" : "📚";
    return `<li class="${cls}"><span class="word-status">${icon}</span><span>${escapeHtml(x.entry.word)}</span></li>`;
  });
  wordListEl.innerHTML = items.join("");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

entryTypeInput.addEventListener("change", updateEntryTypeHint);
startBtn.addEventListener("click", startGame);

btnMarkKnown.addEventListener("click", () => {
  // Si la def est encore floutee, on la revele d'abord (sinon "connu" sans avoir vu = bizarre)
  if (defBlock.classList.contains("is-blurred")) {
    revealDef();
    return;
  }
  nextWord("known");
});
btnMarkUnknown.addEventListener("click", () => {
  if (defBlock.classList.contains("is-blurred")) {
    revealDef();
    return;
  }
  nextWord("unknown");
});
btnNext.addEventListener("click", () => {
  // Bouton "neutre" : on saute au suivant sans rien noter
  if (defBlock.classList.contains("is-blurred")) {
    revealDef();
    return;
  }
  nextWord(null);
});

defRevealBtn.addEventListener("click", revealDef);

btnBackConfig.addEventListener("click", () => {
  // Demande confirmation si on a deja vu des mots dans la session
  if (sessionLog.length > 0) {
    if (!window.confirm("Retour aux options : la session actuelle sera perdue. Continuer ?")) {
      return;
    }
  }
  showView("config");
});

btnRestart.addEventListener("click", () => {
  startGame();
});

// Raccourcis clavier en mode jeu
document.addEventListener("keydown", (e) => {
  if (viewInGame.style.display === "none") return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  if (e.key === " " || e.key === "Enter") {
    e.preventDefault();
    btnNext.click();
  } else if (e.key.toLowerCase() === "k") {
    btnMarkKnown.click();
  } else if (e.key.toLowerCase() === "u" || e.key.toLowerCase() === "a") {
    btnMarkUnknown.click();
  } else if (e.key.toLowerCase() === "r" && defBlock.classList.contains("is-blurred")) {
    revealDef();
  }
});

bootstrap();

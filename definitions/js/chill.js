/**
 * Mode chill solo de Definitions.
 *
 * Charge la banque de mots une fois au demarrage (cf. GET /definitions/words),
 * shuffle cote client puis itere. Pas de Durable Object, pas de WebSocket :
 * tout est local. Pas de persistance entre sessions (pas de compte utilisateur
 * sur le site, donc rien a stocker durablement) - chaque session repart
 * sur la banque complete melangee.
 *
 * Vues :
 *   - view-config   : choix du type d'entree (mots/expressions/all)
 *   - view-in-game  : un mot + sa definition floutee (clic pour reveler)
 *                     + bouton "mot suivant"
 *   - view-finished : banque epuisee
 *
 * Le floutage est le comportement par defaut, pas une option. C'est ce qui
 * fait l'interet du jeu : on voit le mot, on essaye de deviner mentalement
 * (ou les viewers proposent dans le chat), puis on revele.
 */

import { fetchDefinitionWords, pingWorker } from "../../shared/js/api.js";

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const viewConfig = document.getElementById("view-config");
const viewInGame = document.getElementById("view-in-game");
const viewFinished = document.getElementById("view-finished");

const serverStatus = document.getElementById("server-status");
const errorBox = document.getElementById("error-box");

const entryTypeInput = document.getElementById("entry-type-input");
const diffMinInput = document.getElementById("diff-min-input");
const diffMaxInput = document.getElementById("diff-max-input");
const diffHint = document.getElementById("diff-hint");
const startBtn = document.getElementById("start-btn");

const wordEl = document.getElementById("chill-word");
const defBlock = document.getElementById("chill-def-block");
const defTextEl = document.getElementById("chill-def-text");
const defRevealBtn = document.getElementById("chill-def-reveal");
const counterEl = document.getElementById("chill-counter");

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

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

/** Une expression = un mot qui contient au moins un espace. */
function isExpression(entry) {
  return /\s/.test(entry.word);
}

/** Fisher-Yates shuffle. */
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
  serverStatus.textContent = "✓ chargement…";
  try {
    const { words } = await fetchDefinitionWords();
    if (!Array.isArray(words) || words.length === 0) {
      throw new Error("Banque vide");
    }
    allWords = words;
    serverStatus.textContent = `✓ prêt`;
    startBtn.disabled = false;
    startBtn.textContent = "Lancer la partie";
    updateDiffHint();
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
  const v = entryTypeInput.value;
  const dmin = parseInt(diffMinInput.value, 10);
  const dmax = parseInt(diffMaxInput.value, 10);
  if (dmin > dmax) {
    showError("La difficulté minimale ne peut pas dépasser la maximale.");
    return;
  }
  // Filtre type d'entree
  let pool;
  if (v === "words") pool = allWords.filter((e) => !isExpression(e));
  else if (v === "expressions") pool = allWords.filter(isExpression);
  else pool = allWords.slice();
  // Filtre difficulte (les entrees sans champ difficulty sont traitees comme 3)
  pool = pool.filter((e) => {
    const d = e.difficulty ?? 3;
    return d >= dmin && d <= dmax;
  });

  if (pool.length === 0) {
    showError("Aucune entrée disponible pour ce filtre.");
    return;
  }

  queue = shuffle(pool);
  cursor = 0;
  showView("game");
  showCurrent();
}

/**
 * Met a jour le hint sous le selecteur de difficulte : annonce combien
 * d'entrees correspondent au filtre actuel (type + difficulte).
 */
function updateDiffHint() {
  if (!allWords.length) {
    diffHint.textContent = "—";
    return;
  }
  const v = entryTypeInput.value;
  const dmin = parseInt(diffMinInput.value, 10);
  const dmax = parseInt(diffMaxInput.value, 10);
  let pool = allWords;
  if (v === "words") pool = pool.filter((e) => !isExpression(e));
  else if (v === "expressions") pool = pool.filter(isExpression);
  const matching = pool.filter((e) => {
    const d = e.difficulty ?? 3;
    return d >= dmin && d <= dmax;
  });
  if (dmin > dmax) {
    diffHint.textContent = "⚠ min > max, aucune entrée sélectionnée";
  } else {
    diffHint.textContent = `${matching.length} entrées correspondent à ce filtre`;
  }
}

function showCurrent() {
  if (cursor >= queue.length) {
    finishedCount.textContent = String(queue.length);
    showView("finished");
    return;
  }
  const entry = queue[cursor];
  wordEl.textContent = entry.word;
  // Affichage des definitions : si une seule, simple texte ; si plusieurs,
  // liste ordonnee (1. ... 2. ...) pour distinguer les differents sens.
  const defs = entry.definitions ?? [entry.definition]; // fallback retro-compat
  defTextEl.innerHTML = "";
  if (defs.length === 1) {
    defTextEl.textContent = defs[0];
  } else {
    const ol = document.createElement("ol");
    ol.className = "def-multi";
    for (const d of defs) {
      const li = document.createElement("li");
      li.textContent = d;
      ol.appendChild(li);
    }
    defTextEl.appendChild(ol);
  }
  counterEl.textContent = `Mot ${cursor + 1} / ${queue.length}`;
  // Reset au floutage initial pour chaque nouveau mot
  defBlock.classList.add("is-blurred");
  defRevealBtn.style.display = "flex";
}

function revealDef() {
  defBlock.classList.remove("is-blurred");
  defRevealBtn.style.display = "none";
}

function nextWord() {
  if (cursor >= queue.length) return;
  cursor += 1;
  showCurrent();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

startBtn.addEventListener("click", startGame);
entryTypeInput.addEventListener("change", updateDiffHint);
diffMinInput.addEventListener("change", updateDiffHint);
diffMaxInput.addEventListener("change", updateDiffHint);

btnNext.addEventListener("click", () => {
  // Si la def n'a pas encore ete revelee, on la revele d'abord pour
  // eviter de la louper. Au clic suivant, on passe au mot d'apres.
  if (defBlock.classList.contains("is-blurred")) {
    revealDef();
    return;
  }
  nextWord();
});

defRevealBtn.addEventListener("click", revealDef);

btnBackConfig.addEventListener("click", () => {
  // Demande confirmation si on a deja parcouru des mots dans la session
  if (cursor > 0) {
    if (!window.confirm("Retour aux options : la session actuelle sera perdue. Continuer ?")) {
      return;
    }
  }
  showView("config");
});

btnRestart.addEventListener("click", startGame);

// Raccourcis clavier en mode jeu : Espace / Entree = reveler puis passer
document.addEventListener("keydown", (e) => {
  if (viewInGame.style.display === "none") return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  if (e.key === " " || e.key === "Enter") {
    e.preventDefault();
    btnNext.click();
  }
});

bootstrap();

/**
 * Motus chill, orchestrateur de la page solo.
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
 *
 * Mode tchat Twitch (optionnel, choisi dans les options) :
 *   - Lecture anonyme du tchat via shared/js/twitch.js (aucun compte, aucun
 *     token : lecture seule, comme Mots meles).
 *   - Un message qui ressemble a un essai valide (bonne longueur, bonne 1ere
 *     lettre, pas deja tente) est soumis exactement comme si le streamer
 *     l'avait tape.
 *   - Apres chaque essai ACCEPTE (tchat ou clavier), le tchat est ferme
 *     pendant `cooldownSec` secondes, compte a partir de la fin de
 *     l'animation. Les messages recus pendant la pause sont ignores (pas mis
 *     en file) : le but est que chacun voie le resultat avant de reproposer.
 *   - Un mot refuse par le serveur (hors dictionnaire) ne consomme ni essai
 *     ni pause : on passe au candidat suivant arrive dans la meme fenetre.
 */

import { motusChillDraw, motusChillGuess, motusChillReveal, pingWorker } from "../../shared/js/api.js";
import { showToast } from "../../shared/js/toast.js";
import { fetchDefinition, prefetchDefinition } from "../../shared/js/wiktionary.js?v=2";
import { TwitchChat } from "../../shared/js/twitch.js";

// =============================================================================
// Bornes et defauts (alignes avec MOTUS_CONFIG cote worker)
// =============================================================================

const MIN_WORD_LEN = 5;
const MAX_WORD_LEN = 10;
const MIN_ATTEMPTS = 4;
const MAX_ATTEMPTS = 8;
const DEFAULT_WORD_LEN = 7;
const DEFAULT_ATTEMPTS = 6;

// Mode tchat : pause entre deux mots pris dans le tchat (secondes)
const MIN_COOLDOWN = 3;
const MAX_COOLDOWN = 30;
const DEFAULT_COOLDOWN = 8;
const DEFAULT_CHANNEL = "prof_de_tweener";
// Nombre max de candidats gardes dans la fenetre ouverte (si le 1er est hors
// dictionnaire, on essaie le suivant). Au-dela, on ignore : inutile de garder
// 50 messages d'un tchat qui spamme.
const CHAT_QUEUE_MAX = 5;
const CHAT_KEY = "motus_chill_chat";          // "1" = avec le tchat
const CHANNEL_KEY = "motus_channel";          // derniere chaine ecoutee
const COOLDOWN_KEY = "motus_chat_cooldown";   // derniere pause choisie

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
// Detection tactile + module audio (samples MP3 officiels Motus) + compteur de
// lettres mobile. Mirroir simplifie de view-comp.js : memes 4 sons, meme cle
// localStorage pour partager le reglage 🔊/🔇 entre les deux modes.
// =============================================================================

const isTouch = typeof window !== "undefined" &&
  window.matchMedia("(hover: none) and (pointer: coarse)").matches;

const SOUND_STORAGE_KEY = "motus_comp_sound";
const SOUND_URLS = {
  good:      "sounds/Bonne_Lettre.mp3",
  misplaced: "sounds/Mal_Place.mp3",
  absent:    "sounds/Mauvaise_Lettre.mp3",
  found:     "sounds/Mot_Trouve.mp3",
};
const soundBuffers = {};
let soundsLoading = false;
let soundEnabled = (() => {
  try { return window.localStorage.getItem(SOUND_STORAGE_KEY) !== "0"; }
  catch { return true; }
})();
let audioCtx = null;
// Horodate du dernier submit, pour deduplication du double-fire keydown+blur
// sur iOS quand on tape "Go" sur le clavier natif.
let lastSubmitTs = 0;

function ensureAudioCtx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { audioCtx = new AC(); } catch { return null; }
  }
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
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
    const buf = await new Promise((resolve, reject) => {
      const p = audioCtx.decodeAudioData(arr, resolve, reject);
      if (p && typeof p.then === "function") p.then(resolve, reject);
    });
    soundBuffers[key] = buf;
  } catch {}
}

async function loadAllSounds() {
  if (!audioCtx) return;
  await Promise.all(Object.entries(SOUND_URLS).map(([k, u]) => loadOneSound(k, u)));
}

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
  // Fallback synthetise : utilise tant que les MP3 ne sont pas decodes (cas
  // typique : 1ere manche sur reseau mobile lent). Sans ce fallback, le
  // joueur n'entend rien du tout pendant la 1ere revelation, donnant
  // l'impression que la fonctionnalite est cassee.
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

function updateSoundToggleUI() {
  if (!els.soundToggle) return;
  els.soundToggle.setAttribute("aria-pressed", soundEnabled ? "true" : "false");
  if (els.soundIcon) els.soundIcon.textContent = soundEnabled ? "🔊" : "🔇";
  els.soundToggle.title = soundEnabled
    ? "Sons activés, clic pour couper"
    : "Sons coupés, clic pour activer";
}

/** Met a jour le compteur "X / N" affiche dans la barre de saisie (mobile).
 *  Bascule en "complete" (fond vert) quand le mot est termine. */
function updateLetterCounter() {
  if (!els.letterCounter) return;
  const total = game.wordLength || 0;
  // Compte les lettres effectivement saisies dans le buffer.
  const cur = (game.typingBuffer || []).filter((c) => c).length;
  els.letterCounter.textContent = `${cur} / ${total}`;
  els.letterCounter.classList.toggle("complete", total > 0 && cur === total);
}

/** Synchronise la valeur de l'input natif avec le buffer. Utilise quand le
 *  buffer change suite a une frappe au clavier visuel ou physique, pour que
 *  l'input natif refete l'etat courant. */
function syncNativeInputFromBuffer() {
  if (!els.nativeInput) return;
  const v = (game.typingBuffer || []).join("");
  if (els.nativeInput.value !== v) els.nativeInput.value = v;
}

function bringCurrentRowIntoView() {
  if (!isTouch) return;
  const idx = game.attempts.length;
  const row = els.grid && els.grid.querySelector(`.motus-row[data-row="${idx}"]`);
  if (row && typeof row.scrollIntoView === "function") {
    row.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

function focusNativeInput() {
  if (!isTouch || !els.nativeInput) return;
  if (!canType()) return;
  try { els.nativeInput.focus({ preventScroll: true }); }
  catch { els.nativeInput.focus(); }
}

// =============================================================================
// Etat global
// =============================================================================

const config = {
  wordLength: DEFAULT_WORD_LEN,
  maxAttempts: DEFAULT_ATTEMPTS,
  chatOn: false,
  channel: DEFAULT_CHANNEL,
  cooldownSec: DEFAULT_COOLDOWN,
};

/**
 * Etat du tchat Twitch (mode "avec le tchat"). Rien de tout ca n'est envoye
 * au serveur : le worker chill reste stateless, tout se passe ici.
 */
const chat = {
  client: null,          // instance TwitchChat
  paused: false,         // pause manuelle du streamer (bouton ⏸)
  busy: false,           // un mot du tchat est en cours de soumission
  cooldownUntil: 0,      // timestamp (ms) avant lequel on ignore le tchat
  queue: [],             // candidats { name, word } recus fenetre ouverte
  tried: new Set(),      // mots deja testes ou refuses pour le mot en cours
  tickerId: null,        // rafraichissement du compte a rebours
};

const game = {
  token: null,
  firstLetter: null,
  wordLength: 0,
  maxAttempts: 0,
  attempts: [],
  /** Auteur de chaque essai (meme index que attempts) : pseudo Twitch, ou
   *  null quand c'est le streamer qui a tape. */
  attemptAuthors: [],
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

  /**
   * Drapeau "l'utilisateur a deja interagi avec la ligne courante" (au moins
   * une touche pressee ou un DEL). Sert a savoir si la pre-saisie de la 1ere
   * lettre a deja ete consommee : on ne peut pas se contenter de regarder
   * typingBuffer[0] === firstLetter, car cette egalite peut se reproduire
   * apres saisie (cas D-O-U-C-E ou D est la firstLetter mais aussi la touche
   * tapee en premier par l'utilisateur).
   *
   * Reset a chaque nouvelle ligne dans resetTypingBuffer().
   */
  rowDirty: false,
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
 * Il est conserve tant que la touche reste "good", c'est utile car la presence
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
  // Drapeau has-more : reflete le dernier essai connu pour cette lettre.
  // On l'ajoute tant qu'une occurrence en trop reste a placer, on le retire
  // des qu'un essai montre la lettre bien placee sans surplus. Sans ce retrait,
  // un ancien has-more resterait affiche a tort une fois toutes les occurrences trouvees.
  if (status === "good") {
    if (hasMore) btn.classList.add("kb-has-more");
    else btn.classList.remove("kb-has-more");
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
    playSound(fb.status);
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
 * Retourne un tableau toujours vide (de longueur wordLength), on garde la
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
 * Vrai si l'utilisateur n'a encore appuyé sur aucune touche depuis le debut
 * de la ligne courante. Determine via le drapeau game.rowDirty.
 *
 * Sert a decider si on affiche les hints (lettres "good" des essais
 * precedents) et si la 1ere frappe doit consommer la pre-saisie de la 1ere
 * lettre.
 */
function isRowUntouched() {
  return !game.rowDirty;
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
 * Reinitialise le buffer de saisie pour une nouvelle ligne. Pre-remplit
 * la position 0 avec la 1ere lettre imposee (pure commodite, l'utilisateur
 * peut l'effacer pour la retaper s'il veut). Reset egalement le drapeau
 * rowDirty.
 */
function resetTypingBuffer() {
  game.typingBuffer = new Array(game.wordLength).fill("");
  game.typingBuffer[0] = game.firstLetter;
  game.rowDirty = false;
  updateLetterCounter();
  syncNativeInputFromBuffer();
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
    // Toute interaction (y compris DEL) marque la ligne comme touchee.
    game.rowDirty = true;
    const idx = lastFilledFreePos();
    if (idx !== -1) {
      game.typingBuffer[idx] = "";
      renderCurrentRow();
    }
    updateLetterCounter();
    syncNativeInputFromBuffer();
    return;
  }
  if (/^[A-Z]$/.test(key)) {
    // Geste instinctif : a la TOUTE PREMIERE frappe de la ligne, on vide la
    // pre-saisie de la position 0 pour permettre au joueur de taper le mot
    // complet sans decalage. Ne se produit qu'une seule fois par ligne, grace
    // au drapeau rowDirty.
    if (!game.rowDirty) {
      game.typingBuffer[0] = "";
      game.rowDirty = true;
    }
    const pos = nextFreePos(0);
    if (pos === -1) return; // plus de place libre
    game.typingBuffer[pos] = key;
    renderCurrentRow();
    updateLetterCounter();
    syncNativeInputFromBuffer();
  }
}

/**
 * Soumet la ligne courante.
 *
 * @param {string|null} [author=null] pseudo Twitch si le mot vient du tchat,
 *   null si le streamer l'a tape lui-meme.
 * @returns {Promise<"accepted"|"rejected"|"noop">}
 *   accepted : l'essai a ete compte (et anime) ;
 *   rejected : le serveur l'a refuse (hors dico, etc.), aucun essai consomme ;
 *   noop     : rien n'a ete envoye (ligne incomplete, saisie bloquee).
 */
async function submitGuess(author = null) {
  if (!canType()) return "noop";
  if (!isBufferComplete()) {
    flashCurrentRow();
    return "noop";
  }
  const guess = buildGuessString();

  // Mirroir du comp : sur mobile on ferme le clavier natif et on ramene la
  // ligne courante au centre des la validation. L'AudioContext est
  // deverrouille maintenant pour que le 1er son joue sans latence iOS.
  lastSubmitTs = Date.now();
  ensureAudioCtx();
  if (els.nativeInput) els.nativeInput.blur();
  bringCurrentRowIntoView();

  game.status = "submitting";
  try {
    const res = await motusChillGuess(game.token, guess);

    game.attempts.push(res.attempt);
    game.attemptAuthors.push(author);
    chat.tried.add(guess);
    const rowIndex = game.attempts.length - 1;
    // Le pseudo s'affiche sur la ligne : pas besoin de le repeter sous la
    // barre, qui ne sert qu'a expliquer les refus.
    markRowAuthor(rowIndex, author);

    // Animation lettre par lettre (bloque la saisie)
    game.status = "animating";
    await animateAttemptRow(rowIndex, res.attempt);

    // La pause du tchat demarre une fois le resultat visible, que l'essai
    // vienne du tchat ou du clavier : tout le monde doit voir les couleurs
    // avant qu'un nouveau mot soit pris. Les candidats arrives pendant
    // l'animation sont jetes pour la meme raison.
    startChatCooldown();

    // Cas mot trouve : on saute la suite et passe a la vue between
    if (res.status === "found") {
      game.status = "found";
      game.revealedWord = res.revealedWord;
      // Jingle de victoire, decalle de 120ms pour ne pas se chevaucher avec
      // le dernier tick de la revelation.
      setTimeout(() => playSound("found"), 120);
      updateStatus();
      goBetween();
      return "accepted";
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
      return "accepted";
    }

    // Cas standard : on prepare la ligne suivante
    game.status = "in_progress";
    game.lockedRow = computeLockedRow();
    game.hintRow = computeHintRow();
    resetTypingBuffer();
    renderCurrentRow();
    updateStatus();
    return "accepted";
  } catch (err) {
    // Le serveur a refuse l'essai (mot pas dans le dico, etc.)
    game.status = "in_progress";
    if (author) {
      // Mot du tchat refuse : pas de toast (un tchat actif en ferait
      // pleuvoir), juste la ligne d'info sous la barre. On rend au streamer
      // une ligne propre plutot que de laisser le mot refuse affiche.
      chat.tried.add(guess);
      const why = err && err.code === "WORD_NOT_IN_DICTIONARY"
        ? "pas dans le dictionnaire"
        : (err && err.message) || "refusé";
      setChatLast(`${author} : ${guess}, ${why}`, "rejected");
      resetTypingBuffer();
      renderCurrentRow();
    } else {
      showToast(err.message || "Essai refuse", { type: "error" });
      flashCurrentRow();
    }
    return "rejected";
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
    if (els.firstLetterBadge) els.firstLetterBadge.dataset.letter = "";
    return;
  }
  els.wordInfo.textContent = `${game.wordLength} lettres`;
  if (els.firstLetterBadge) els.firstLetterBadge.dataset.letter = game.firstLetter;
  if (game.status === "in_progress" || game.status === "submitting" || game.status === "animating") {
    els.statusLine.textContent = `Essai ${game.attempts.length + 1} / ${game.maxAttempts}`;
  } else if (game.status === "found") {
    const n = game.attempts.length;
    els.statusLine.textContent = `Trouvé en ${n} essai${n > 1 ? "s" : ""} !`;
  } else if (game.status === "exhausted") {
    els.statusLine.textContent = "Essais épuisés.";
  }
  // Le bouton "Abandonner" n'est utile que pendant qu'on cherche encore.
  if (els.giveUpBtn) {
    els.giveUpBtn.disabled = game.status !== "in_progress";
  }
}

// =============================================================================
// Mode tchat Twitch
// =============================================================================

/**
 * Transforme un message du tchat en mot candidat, ou null s'il ne ressemble
 * pas a un essai. Meme normalisation que le worker (normalizeGuess) : accents
 * retires, majuscules. On tolere la ponctuation en bordure ("maison !" non,
 * car il y a un espace ; "maison!" oui) et les ligatures Œ/Æ.
 *
 * @param {string} text
 * @returns {string|null}
 */
function normalizeChatWord(text) {
  let t = String(text || "").trim();
  if (!t || t.startsWith("!")) return null;          // commandes de bot
  t = t.replace(/^["'«»“”.,;:!?]+|["'«»“”.,;:!?]+$/g, "");
  if (!t || /\s/.test(t)) return null;               // une phrase n'est pas un essai
  const w = t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/Œ/g, "OE")
    .replace(/Æ/g, "AE");
  return /^[A-Z]+$/.test(w) ? w : null;
}

/** Vrai si le mot peut etre tente sur la grille en cours. */
function isChatCandidate(word) {
  return !!word &&
    word.length === game.wordLength &&
    word[0] === game.firstLetter &&
    !chat.tried.has(word);
}

/** Le tchat ecoute-t-il en ce moment (hors pause, hors entre-deux-mots) ? */
function chatListening() {
  if (!config.chatOn || chat.paused) return false;
  if (Date.now() < chat.cooldownUntil) return false;
  return game.status === "in_progress" || game.status === "submitting" || game.status === "animating";
}

// Ecart de longueur max pour signaler "trop court / trop long". Au-dela, on
// considere que ce n'est pas une tentative ("tu", "gg", "trop bien"...).
const CHAT_LEN_TOLERANCE = 2;

/**
 * Explique pourquoi un mot du tchat ne peut pas etre tente.
 * Renvoie null si le mot est jouable, une raison a afficher si le message
 * ressemble a une vraie tentative, ou "" s'il faut l'ignorer en silence
 * (bavardage du tchat : on ne veut pas noyer la barre de refus).
 *
 * @param {string} word mot deja normalise (A-Z)
 * @returns {string|null}
 */
function chatRejectReason(word) {
  const okLen = word.length === game.wordLength;
  const okFirst = word[0] === game.firstLetter;
  if (okLen && okFirst) return chat.tried.has(word) ? "déjà tenté" : null;
  if (okFirst && Math.abs(word.length - game.wordLength) <= CHAT_LEN_TOLERANCE) {
    const n = word.length;
    return n < game.wordLength
      ? `trop court (${n} lettres au lieu de ${game.wordLength})`
      : `trop long (${n} lettres au lieu de ${game.wordLength})`;
  }
  if (okLen) return `ne commence pas par ${game.firstLetter}`;
  return "";
}

function onChatMessage(m) {
  if (!chatListening()) return;
  const word = normalizeChatWord(m.text);
  if (!word) return;
  const reason = chatRejectReason(word);
  if (reason !== null) {
    if (reason) setChatLast(`${m.name} : ${word}, ${reason}`, "rejected");
    return;
  }
  if (chat.queue.some((c) => c.word === word)) return;
  if (chat.queue.length >= CHAT_QUEUE_MAX) return;
  chat.queue.push({ name: m.name, word });
  pumpChat();
}

/**
 * Teste les candidats en file, un par un, tant que la fenetre est ouverte.
 * S'arrete des qu'un essai est accepte (la pause demarre et vide la file).
 * Un candidat refuse par le serveur laisse la place au suivant.
 */
async function pumpChat() {
  if (chat.busy) return;
  chat.busy = true;
  try {
    while (chat.queue.length > 0) {
      if (!config.chatOn || chat.paused) break;
      if (Date.now() < chat.cooldownUntil) { chat.queue = []; break; }
      if (game.status !== "in_progress") break; // le streamer soumet : on attend
      const c = chat.queue.shift();
      if (!isChatCandidate(c.word)) continue;
      // Le mot du tchat remplace ce que le streamer etait en train de taper.
      game.typingBuffer = c.word.split("");
      game.rowDirty = true;
      renderCurrentRow();
      updateLetterCounter();
      syncNativeInputFromBuffer();
      renderChatBar();
      const outcome = await submitGuess(c.name);
      if (outcome === "accepted") break;
    }
  } finally {
    chat.busy = false;
    renderChatBar();
  }
}

/** Ferme le tchat pendant cooldownSec et jette les candidats en attente. */
function startChatCooldown() {
  if (!config.chatOn) return;
  chat.cooldownUntil = Date.now() + config.cooldownSec * 1000;
  chat.queue = [];
  renderChatBar();
}

/** Remet le tchat a zero pour un nouveau mot (fenetre ouverte tout de suite). */
function resetChatForNewWord() {
  chat.cooldownUntil = 0;
  chat.queue = [];
  chat.tried.clear();
  setChatLast("", "");
  renderChatBar();
}

/** Affiche le pseudo de l'auteur sur la ligne (a droite si la place le permet). */
function markRowAuthor(rowIndex, author) {
  const rowEl = els.grid && els.grid.querySelector(`.motus-row[data-row="${rowIndex}"]`);
  if (!rowEl) return;
  if (author) {
    rowEl.dataset.author = author;
    rowEl.title = `Proposé par ${author}`;
  } else {
    delete rowEl.dataset.author;
    rowEl.removeAttribute("title");
  }
  updateAuthorPlacement();
}

// En dessous de cette marge libre a droite de la grille, le pseudo serait
// illisible : on garde la pastille sur le coin de la ligne.
const AUTHOR_SIDE_MIN_PX = 64;

/**
 * Mesure la place libre a droite de la grille (dans .game-main) et choisit
 * ou afficher les pseudos : a droite de la ligne si ca tient, sinon sur le
 * coin. Appele a l'affichage d'une grille, a chaque essai et au resize. Doit
 * tourner la vue visible (une vue en display:none mesure 0).
 */
function updateAuthorPlacement() {
  if (!els.grid) return;
  // On mesure jusqu'au bord de la carte (sa marge interieure compte) : la
  // pastille peut deborder de la colonne de jeu, pas de la carte.
  const box = els.grid.closest(".card") || els.grid.closest(".game-main") || els.grid.parentElement;
  const row = els.grid.querySelector(".motus-row");
  if (!box || !row || !row.offsetWidth) return;
  // 10 px d'ecart avec la ligne + 8 px de securite avant le bord de la carte.
  const free = box.getBoundingClientRect().right - row.getBoundingClientRect().right - 18;
  const side = free >= AUTHOR_SIDE_MIN_PX;
  els.grid.classList.toggle("authors-side", side);
  if (side) els.grid.style.setProperty("--author-space", `${Math.floor(free)}px`);
}

// Duree d'affichage d'un refus sous la barre du tchat (ms).
const CHAT_LOG_TTL_MS = 10000;

/**
 * Journal court sous la barre : les 2 derniers refus du tchat. Deux lignes
 * pour qu'un refus ne soit pas aussitot efface par le suivant. Chaque ligne
 * disparait seule au bout de CHAT_LOG_TTL_MS (purge par le ticker du tchat).
 * Appel avec un texte vide : vide le journal (nouveau mot).
 */
const chatLog = [];
function setChatLast(text, kind) {
  if (!els.chatLast) return;
  if (!text) chatLog.length = 0;
  else {
    chatLog.push({ text, kind, at: Date.now() });
    if (chatLog.length > 2) chatLog.shift();
  }
  renderChatLog();
}

function renderChatLog() {
  if (!els.chatLast) return;
  els.chatLast.replaceChildren(...chatLog.map((e) => {
    const line = document.createElement("div");
    line.className = "chill-chat-log" + (e.kind ? ` ${e.kind}` : "");
    line.textContent = e.text;
    return line;
  }));
}

/** Retire les refus affiches depuis plus de CHAT_LOG_TTL_MS. */
function pruneChatLog() {
  const limit = Date.now() - CHAT_LOG_TTL_MS;
  const before = chatLog.length;
  while (chatLog.length > 0 && chatLog[0].at <= limit) chatLog.shift();
  if (chatLog.length !== before) renderChatLog();
}

// Le module TwitchChat parle en wait/on/err ; la pastille reprend les classes
// .connection-status .dot de Sesame (meme rendu que Mots meles).
const CHAT_DOT_CLASS = { wait: "connecting", on: "open", err: "error" };

function setChatConn(state, text) {
  if (els.chatDot) {
    els.chatDot.className = "dot " + (CHAT_DOT_CLASS[state] || "");
    els.chatDot.title = text;
  }
  if (els.chatConnText) {
    els.chatConnText.textContent = text;
    // Connecte : la pastille verte suffit (nom de la chaine en infobulle),
    // on garde la place pour le compte a rebours. Le texte revient des
    // qu'il y a quelque chose a signaler (connexion, coupure).
    els.chatConnText.hidden = state === "on";
  }
}

/** Met a jour la barre du tchat : consigne, compte a rebours, bouton pause. */
function renderChatBar() {
  if (!els.chatBar) return;
  els.chatBar.hidden = !config.chatOn;
  if (!config.chatOn) return;

  const now = Date.now();
  const remaining = Math.max(0, chat.cooldownUntil - now);
  const total = config.cooldownSec * 1000;
  let turn = "";
  let state = "open";
  let fill = 0;

  if (chat.paused) {
    turn = "Tchat en pause";
    state = "paused";
  } else if (game.status === "submitting" || game.status === "animating") {
    turn = "Test du mot en cours…";
    state = "busy";
  } else if (remaining > 0) {
    turn = `Prochain mot dans ${Math.ceil(remaining / 1000)} s`;
    state = "cooldown";
    fill = total > 0 ? remaining / total : 0;
  } else if (game.status === "in_progress") {
    turn = `À vous le tchat : ${game.wordLength} lettres, commence par ${game.firstLetter}`;
  }

  if (els.chatTurn) {
    els.chatTurn.textContent = turn;
    els.chatTurn.dataset.state = state;
  }
  if (els.chatProgressFill) {
    els.chatProgressFill.style.transform = `scaleX(${fill})`;
  }
  if (els.chatPauseBtn) {
    els.chatPauseBtn.setAttribute("aria-pressed", chat.paused ? "true" : "false");
    els.chatPauseBtn.textContent = chat.paused ? "▶" : "⏸";
    els.chatPauseBtn.title = chat.paused ? "Rouvrir le tchat" : "Mettre le tchat en pause";
  }
}

function startChatTicker() {
  if (chat.tickerId !== null) return;
  // 4 rafraichissements par seconde : compte a rebours fluide, et relance de
  // la file si un candidat attendait la fin d'une soumission du streamer.
  chat.tickerId = setInterval(() => {
    renderChatBar();
    pruneChatLog();
    if (chat.queue.length > 0) pumpChat();
  }, 250);
}

function stopChatTicker() {
  if (chat.tickerId !== null) {
    clearInterval(chat.tickerId);
    chat.tickerId = null;
  }
}

/** Ouvre (ou garde) la connexion au tchat selon la config courante. */
function syncChatConnection() {
  const gameCard = document.getElementById("view-in-game");
  if (gameCard) gameCard.classList.toggle("chat-on", config.chatOn);
  if (!config.chatOn) {
    if (chat.client) { chat.client.close(); chat.client = null; }
    stopChatTicker();
    renderChatBar();
    return;
  }
  if (!chat.client || chat.client.channel !== config.channel) {
    if (chat.client) chat.client.close();
    chat.client = new TwitchChat(config.channel);
    chat.client.on("status", (s) => setChatConn(s.state, s.text));
    chat.client.on("message", onChatMessage);
    chat.client.connect();
  }
  startChatTicker();
  renderChatBar();
}

/** Bascule Sans / Avec le tchat dans la vue options. */
function setChatModeUI(on) {
  config.chatOn = !!on;
  if (els.chatModeSeg) {
    els.chatModeSeg.querySelectorAll("button[data-chat]").forEach((b) => {
      const active = (b.dataset.chat === "on") === config.chatOn;
      b.classList.toggle("on", active);
      b.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }
  if (els.chatOptions) els.chatOptions.hidden = !config.chatOn;
}

/** Recharge les derniers reglages tchat (par appareil, localStorage). */
function loadChatPrefs() {
  try {
    const on = window.localStorage.getItem(CHAT_KEY) === "1";
    const ch = (window.localStorage.getItem(CHANNEL_KEY) || "").trim();
    const cd = parseInt(window.localStorage.getItem(COOLDOWN_KEY) || "", 10);
    if (ch && els.channelInput) els.channelInput.value = ch;
    if (Number.isFinite(cd) && els.cooldownInput) els.cooldownInput.value = String(cd);
    setChatModeUI(on);
  } catch {
    setChatModeUI(false);
  }
}

function saveChatPrefs() {
  try {
    window.localStorage.setItem(CHAT_KEY, config.chatOn ? "1" : "0");
    if (config.chatOn) {
      window.localStorage.setItem(CHANNEL_KEY, config.channel);
      window.localStorage.setItem(COOLDOWN_KEY, String(config.cooldownSec));
    }
  } catch {}
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
  if (!Number.isFinite(ms) || ms < 0) return "-";
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
 * Arrete le timer live (entre les parties). N'efface PAS currentStartTime,
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
  setText("stat-rate", rate == null ? "-" : `${rate}%`);
  setText("stat-avg", avgAttempts == null ? "-" : avgAttempts.toFixed(1));
  setText("stat-best", best == null ? "-" : `${best} essai${best > 1 ? "s" : ""}`);
  setText("stat-streak", String(session.currentStreak));
  setText("stat-streak-best", String(session.bestStreak));

  // Timers
  setText("stat-time-total", totalDuration > 0 ? formatDuration(totalDuration) : "-");
  setText("stat-time-avg", avgDuration == null ? "-" : formatDuration(avgDuration));
  setText("stat-time-live", session.currentStartTime !== null
    ? formatDuration(liveDuration)
    : "-");
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
    if (entry.finder) {
      li.title = (li.title ? li.title + ", " : "") + `par ${entry.finder}`;
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
  // startTime, sinon on stocke null, signalant une duree non mesurable).
  let durationMs = null;
  if (session.currentStartTime !== null) {
    durationMs = Date.now() - session.currentStartTime;
    session.currentStartTime = null;
  }
  stopLiveTimer();

  // Enregistre la partie dans la session (stats + word list).
  // On le fait ici et nulle part ailleurs pour eviter le double comptage :
  // c'est le seul point d'entree de la vue "between".
  // Pseudo Twitch de celui qui a trouve (null si c'est le streamer ou si le
  // mot n'a pas ete trouve).
  const finder = game.status === "found"
    ? (game.attemptAuthors[game.attemptAuthors.length - 1] || null)
    : null;

  if (game.firstLetter && game.revealedWord) {
    recordSessionWord({
      found: game.status === "found",
      word: game.revealedWord,
      attempts: game.attempts.length,
      wordLength: game.wordLength,
      maxAttempts: game.maxAttempts,
      durationMs,
      finder,
    });
  }

  if (game.status === "found") {
    els.betweenSummary.textContent = finder
      ? `${finder} a trouvé le mot ! 🎉`
      : "Tu as trouvé le mot ! 🎉";
    els.betweenSummary.className = "between-summary success";
  } else {
    els.betweenSummary.textContent = "Essais épuisés. Le mot était :";
    els.betweenSummary.className = "between-summary failure";
  }
  els.betweenWord.textContent = game.revealedWord || "?";
  // Bouton "Voir la definition" : visible uniquement si on a un mot revele
  // (cas trouve OU abandonne OU essais epuises). Cache si pas de mot.
  if (els.betweenDefBtn) {
    if (game.revealedWord) {
      els.betweenDefBtn.style.display = "";
      // Pre-fetch en arriere-plan : ouverture instantanee de la modale au clic.
      prefetchDefinition(game.revealedWord);
    } else {
      els.betweenDefBtn.style.display = "none";
    }
  }
  // Remet le scroll en haut a l'arrivee sur la vue between : evite le saut
  // de la banderole iOS apres une animation de revelation qui aurait pu
  // pousser le scroll vers le bas.
  window.scrollTo(0, 0);
  showView("between");
}

/**
 * Abandon manuel : l'utilisateur clique "Abandonner, voir le mot". On demande
 * au serveur de reveler le mot (motusChillReveal), on marque la partie comme
 * "exhausted" (non trouvee), et on bascule vers la vue between. Equivalent
 * fonctionnel a avoir epuise les essais, en moins long.
 */
async function handleGiveUp() {
  // Garde-fou : seulement pendant une partie en cours
  if (game.status !== "in_progress") return;
  if (!game.token) return;
  // Confirmation legere (le joueur veut juste accelerer, pas surprise)
  if (!confirm("Abandonner cette partie et voir le mot ?")) return;

  game.status = "submitting";
  try {
    const reveal = await motusChillReveal(game.token);
    game.revealedWord = reveal.revealedWord;
  } catch {
    game.revealedWord = null;
  }
  game.status = "exhausted";
  updateStatus();
  goBetween();
}

async function startNewWord() {
  // Reset etat du round. Statut "idle" pendant le tirage : le tchat ne doit
  // rien soumettre tant que la nouvelle grille n'est pas prete.
  game.attempts = [];
  game.attemptAuthors = [];
  game.status = "idle";
  game.revealedWord = null;
  resetKeyboardColors();

  // Preload audio le plus tot possible : on est dans le handler du clic
  // "Lancer" / "Mot suivant" -> user gesture, donc on peut creer et resumer
  // l'AudioContext. Le decodage des MP3 demarre en tache de fond pendant
  // que l'utilisateur tape, ce qui evite le silence de la 1ere manche.
  ensureAudioCtx();

  els.startBtn.disabled = true;
  const previousLabel = els.startBtn.textContent;
  els.startBtn.textContent = "Tirage…";

  try {
    // Lit l'historique des premieres lettres recemment tirees pour ce mode
    // chill (5 dernieres conservees), afin de reduire les repetitions
    // d'initiale sur les tirages consecutifs. localStorage = par appareil.
    const RECENT_KEY = "motus_chill_recent_letters";
    let recent = [];
    try {
      const raw = window.localStorage.getItem(RECENT_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          recent = arr.filter((l) => typeof l === "string" && l.length === 1);
        }
      }
    } catch {}
    const res = await motusChillDraw(config.wordLength, config.maxAttempts, recent.slice(-5));
    game.token = res.token;
    game.firstLetter = res.firstLetter;
    game.wordLength = res.wordLength;
    game.maxAttempts = res.maxAttempts;
    // Met a jour l'historique. Fenetre glissante de 20.
    try {
      recent.push(res.firstLetter);
      if (recent.length > 20) recent = recent.slice(-20);
      window.localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    } catch {}

    game.status = "in_progress";
    rebuildGrid();
    // Nouveau mot : le tchat peut proposer tout de suite, sans pause.
    resetChatForNewWord();
    // Initialise la ligne courante : 1ere lettre verrouillee, pas de hints (1er tour)
    game.lockedRow = computeLockedRow();
    game.hintRow = computeHintRow();
    resetTypingBuffer();
    renderCurrentRow();
    updateStatus();
    // Remet le scroll en haut : evite le saut visuel de la banderole iOS au
    // demarrage d'un nouveau mot (la position de scroll de la fin du mot
    // precedent ne doit pas se reporter).
    window.scrollTo(0, 0);
    showView("in_game");
    updateAuthorPlacement();
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

  // Reglages tchat : uniquement lus si le mode tchat est actif.
  if (config.chatOn) {
    config.cooldownSec = clampInt(els.cooldownInput.value, MIN_COOLDOWN, MAX_COOLDOWN, DEFAULT_COOLDOWN);
    els.cooldownInput.value = String(config.cooldownSec);
    const ch = (els.channelInput.value || "").toLowerCase().replace(/^#/, "").trim();
    // Format des noms de chaine Twitch : lettres, chiffres, underscore.
    if (!/^[a-z0-9_]{3,25}$/.test(ch)) {
      return "Nom de chaîne Twitch invalide (lettres, chiffres et _ uniquement).";
    }
    config.channel = ch;
    els.channelInput.value = ch;
  }
  return null;
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
  els.firstLetterBadge = $("motus-first-letter");

  els.betweenSummary = $("between-summary");
  els.betweenWord = $("between-word");
  els.betweenDefBtn = $("between-def-btn");
  els.nextWordBtn = $("next-word-btn");
  els.backToConfigBtn = $("back-to-config-btn");
  els.giveUpBtn = $("give-up-btn");

  // Sidebar stats + word list
  els.wordList = $("word-list");

  // Modale definition
  els.definitionOverlay = $("definition-overlay");
  els.definitionTitle = $("definition-title");
  els.definitionBody = $("definition-body");
  els.definitionSourceLink = $("definition-source-link");
  els.definitionClose = $("definition-close");

  // Input natif mobile (clavier du telephone) + compteur de lettres et toggle son.
  // Tous optionnels : si l'element n'existe pas, les helpers degradent en no-op.
  els.nativeInput = $("chill-native-input");
  els.letterCounter = $("chill-letter-counter");
  els.resetBtn = $("chill-reset-btn");
  els.soundToggle = $("chill-sound-toggle");
  els.soundIcon = $("chill-sound-icon");

  // Mode tchat Twitch (options + barre en jeu)
  els.chatModeSeg = $("chat-mode-seg");
  els.chatOptions = $("chat-options");
  els.channelInput = $("channel-input");
  els.cooldownInput = $("cooldown-input");
  els.chatBar = $("chill-chat-bar");
  els.chatDot = $("chat-dot");
  els.chatConnText = $("chat-conn-text");
  els.chatTurn = $("chat-turn");
  els.chatPauseBtn = $("chat-pause-btn");
  els.chatProgressFill = $("chat-progress-fill");
  els.chatLast = $("chat-last");
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

  // Options tchat : reglages precedents + bascule Sans / Avec le tchat.
  loadChatPrefs();
  // Place des pseudos (a droite ou sur le coin) selon la largeur dispo.
  window.addEventListener("resize", updateAuthorPlacement);
  if (els.chatModeSeg) {
    els.chatModeSeg.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-chat]");
      if (btn) setChatModeUI(btn.dataset.chat === "on");
    });
  }
  if (els.chatPauseBtn) {
    els.chatPauseBtn.addEventListener("click", () => {
      chat.paused = !chat.paused;
      chat.queue = [];
      renderChatBar();
    });
  }

  els.startBtn.addEventListener("click", () => {
    clearError();
    const err = readConfigFromInputs();
    if (err) { showError(err); return; }
    saveChatPrefs();
    // Connexion (ou deconnexion) au tchat avant le tirage : le temps que
    // l'IRC reponde, la grille est deja prete.
    syncChatConnection();
    startNewWord();
  });

  els.nextWordBtn.addEventListener("click", () => {
    startNewWord();
  });

  els.backToConfigBtn.addEventListener("click", () => {
    showView("config");
  });

  // Clic sur "Voir la definition" du recap : ouvre la modale wiktionary.
  if (els.betweenDefBtn) {
    els.betweenDefBtn.addEventListener("click", () => {
      if (game.revealedWord) openDefinition(game.revealedWord);
    });
  }

  if (els.giveUpBtn) {
    els.giveUpBtn.addEventListener("click", () => {
      handleGiveUp();
    });
  }

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

  // =========================================================================
  // Mobile : clavier natif + compteur + toggle son. Mirroir simplifie de
  // view-comp.js (cf. ce fichier pour la doc detaillee de chaque hook).
  // =========================================================================
  updateSoundToggleUI();
  updateLetterCounter();

  if (els.soundToggle) {
    els.soundToggle.addEventListener("click", () => {
      soundEnabled = !soundEnabled;
      try { window.localStorage.setItem(SOUND_STORAGE_KEY, soundEnabled ? "1" : "0"); } catch {}
      updateSoundToggleUI();
      ensureAudioCtx();
      if (soundEnabled) playSound("good");
    });
  }

  if (els.nativeInput) {
    els.nativeInput.addEventListener("input", () => {
      if (!canType()) {
        els.nativeInput.value = (game.typingBuffer || []).join("");
        return;
      }
      // Reconstruit le buffer depuis la valeur de l'input : on prend les
      // lettres A-Z, on borne a wordLength, on padde a droite avec "".
      const clean = (els.nativeInput.value || "")
        .toUpperCase().replace(/[^A-Z]/g, "").slice(0, game.wordLength);
      game.rowDirty = true;
      game.typingBuffer = new Array(game.wordLength).fill("");
      for (let i = 0; i < clean.length; i++) game.typingBuffer[i] = clean[i];
      renderCurrentRow();
      updateLetterCounter();
      // Sync inverse : si on a normalise (e.g. accent retire), repercute.
      if (els.nativeInput.value !== clean) els.nativeInput.value = clean;
    });
    // Entree / "Go" du clavier natif : soumet l'essai.
    els.nativeInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (canType()) submitGuess();
      }
    });
    // iOS : la coche "Done" declenche blur. Si le mot est complet, on
    // soumet, sauf si on vient deja de soumettre (dedupe 300ms).
    els.nativeInput.addEventListener("blur", () => {
      if (!canType()) return;
      if (Date.now() - lastSubmitTs < 300) return;
      if (isBufferComplete()) submitGuess();
    });
  }

  // Tap sur la grille redonne le focus a l'input (rouvre le clavier natif).
  if (els.grid) {
    els.grid.addEventListener("click", () => focusNativeInput());
  }

  // Bouton "↺ reset" : remet la ligne courante a son etat initial (1ere
  // lettre pre-saisie, reste vide, rowDirty=false). Utile si le curseur
  // iOS se bloque ou si on veut repartir de zero sans avoir a effacer
  // case par case via DEL.
  if (els.resetBtn) {
    els.resetBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (!canType()) return;
      resetTypingBuffer();
      renderCurrentRow();
      focusNativeInput();
    });
  }
}

init();

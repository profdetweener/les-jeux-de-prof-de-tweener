/**
 * Vue Jeu Motus (in_game + between_words) :
 *
 *   - Grille des essais (centrale)
 *   - Clavier tactile (host uniquement en mode coop)
 *   - Bandeau "mot en cours / essai X/Y"
 *   - Vue between-words avec recap et bouton "mot suivant"
 *
 * En mode coop_stream, seul l'hote a le clavier actif. Les autres joueurs
 * voient la grille en read-only et reagissent oralement / dans le chat.
 */

const KEYBOARD_ROWS = [
  ["A", "Z", "E", "R", "T", "Y", "U", "I", "O", "P"],
  ["Q", "S", "D", "F", "G", "H", "J", "K", "L", "M"],
  ["DEL", "W", "X", "C", "V", "B", "N", "ENTER"],
];

export function initGameView(state, conn) {
  // Refs DOM
  const gridEl = document.getElementById("motus-grid");
  const keyboardEl = document.getElementById("motus-keyboard");
  const statusLineEl = document.getElementById("motus-status");
  const wordInfoEl = document.getElementById("motus-word-info");
  const guestNoticeEl = document.getElementById("motus-guest-notice");

  // Vue between-words
  const betweenSummaryEl = document.getElementById("between-summary");
  const betweenWordEl = document.getElementById("between-word");
  const nextWordBtn = document.getElementById("next-word-btn");
  const endGameBtn = document.getElementById("end-game-btn");
  const guestWaitingEl = document.getElementById("guest-waiting");

  // Etat local de l'essai en cours
  let typingBuffer = "";
  let keyButtons = {}; // letter -> HTMLElement, pour color tracking
  let lastFlashed = -1; // dernier index d'essai anime

  // ---- Construction du clavier tactile ----
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
  buildKeyboard();

  // ---- Saisie : clavier physique + tactile ----
  function onKeyPress(key) {
    if (!canType()) return;
    if (!state.currentWord) return;
    const wordLen = state.currentWord.wordLength;

    if (key === "ENTER") {
      submitGuess();
      return;
    }
    if (key === "DEL") {
      typingBuffer = typingBuffer.slice(0, -1);
      renderCurrentTypingRow();
      return;
    }
    if (/^[A-Z]$/.test(key)) {
      // Si on demarre la saisie, le 1er char est impose (la 1ere lettre du mot)
      // On force le 1er char en background : si typingBuffer est vide, on lui
      // injecte la 1ere lettre automatiquement. Le joueur n'a pas a la retaper.
      if (typingBuffer.length === 0) {
        typingBuffer = state.currentWord.firstLetter;
      }
      if (typingBuffer.length < wordLen) {
        typingBuffer += key;
        renderCurrentTypingRow();
      }
    }
  }

  function submitGuess() {
    if (!canType() || !state.currentWord) return;
    const wordLen = state.currentWord.wordLength;
    if (typingBuffer.length !== wordLen) {
      // Pas la bonne longueur : on flash la ligne courante en rouge
      flashCurrentRow("incomplete");
      return;
    }
    // On envoie l'essai au serveur, qui validera (dico, premiere lettre, etc.)
    conn.send({ type: "submit_guess", guess: typingBuffer });
    // On ne reset PAS le buffer ici : on attend la reponse "guess_resolved"
    // pour le faire (au cas ou le serveur refuse).
  }

  // Clavier physique
  document.addEventListener("keydown", (e) => {
    // Si on est dans un champ texte ailleurs (chat, etc., pas le cas ici mais
    // safety), on n'intercepte pas.
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    if (!canType()) return;
    if (state.phase !== "in_game") return;

    if (e.key === "Enter") { onKeyPress("ENTER"); e.preventDefault(); return; }
    if (e.key === "Backspace") { onKeyPress("DEL"); e.preventDefault(); return; }
    // Lettre A-Z (insensible a la casse, accents normalises plus tard cote serveur)
    const ch = e.key.toUpperCase();
    if (/^[A-Z]$/.test(ch)) {
      onKeyPress(ch);
      e.preventDefault();
    }
  });

  function canType() {
    if (state.phase !== "in_game") return false;
    if (!state.currentWord) return false;
    if (state.currentWord.status !== "in_progress") return false;
    // Mode coop : seul l'hote tape
    if (state.config && state.config.mode === "coop_stream" && !state.isHost) return false;
    // Si on a atteint le nb max d'essais (cas limite), bloque
    if (state.currentWord.attempts.length >= state.currentWord.maxAttempts) return false;
    return true;
  }

  // ---- Construction de la grille ----
  function rebuildGrid() {
    gridEl.innerHTML = "";
    if (!state.currentWord) return;
    const { wordLength, maxAttempts, firstLetter, attempts } = state.currentWord;
    gridEl.style.setProperty("--motus-cols", String(wordLength));

    for (let row = 0; row < maxAttempts; row++) {
      const rowEl = document.createElement("div");
      rowEl.className = "motus-row";
      rowEl.dataset.row = String(row);
      for (let col = 0; col < wordLength; col++) {
        const cell = document.createElement("div");
        cell.className = "motus-cell";
        cell.dataset.row = String(row);
        cell.dataset.col = String(col);
        // Pre-remplit la 1ere lettre sur la 1ere case (toujours visible)
        if (col === 0) {
          cell.textContent = firstLetter;
          cell.classList.add("locked-letter");
        }
        rowEl.appendChild(cell);
      }
      gridEl.appendChild(rowEl);
    }

    // Re-colorise les essais deja soumis
    for (let i = 0; i < attempts.length; i++) {
      paintAttemptRow(i, attempts[i]);
    }
    renderCurrentTypingRow();
  }

  function paintAttemptRow(rowIndex, attempt) {
    const rowEl = gridEl.querySelector(`.motus-row[data-row="${rowIndex}"]`);
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
    // Mise a jour des couleurs du clavier (pour l'hote)
    attempt.feedback.forEach((fb) => updateKeyColor(fb.letter, fb.status));
  }

  function renderCurrentTypingRow() {
    if (!state.currentWord) return;
    const idx = state.currentWord.attempts.length;
    const rowEl = gridEl.querySelector(`.motus-row[data-row="${idx}"]`);
    if (!rowEl) return;
    const cells = rowEl.querySelectorAll(".motus-cell");
    const { firstLetter, wordLength } = state.currentWord;

    // typingBuffer doit toujours commencer par la 1ere lettre (forcee)
    // Si vide on affiche juste la lettre verrouillee a position 0.
    for (let col = 0; col < wordLength; col++) {
      const cell = cells[col];
      cell.classList.remove("filled", "typing", "status-good", "status-misplaced", "status-absent", "has-more");
      if (col === 0) {
        cell.textContent = firstLetter;
        cell.classList.add("locked-letter");
      } else if (col < typingBuffer.length) {
        cell.textContent = typingBuffer[col];
        cell.classList.add("typing");
      } else {
        cell.textContent = "";
      }
    }
  }

  function updateKeyColor(letter, status) {
    const btn = keyButtons[letter];
    if (!btn) return;
    // Hierarchie : good > misplaced > absent. On ne degrade jamais.
    const order = { absent: 0, misplaced: 1, good: 2 };
    const current = ["absent", "misplaced", "good"].find((s) => btn.classList.contains(`kb-${s}`));
    if (!current || order[status] > order[current]) {
      btn.classList.remove("kb-absent", "kb-misplaced", "kb-good");
      btn.classList.add(`kb-${status}`);
    }
  }

  function flashCurrentRow(reason) {
    if (!state.currentWord) return;
    const idx = state.currentWord.attempts.length;
    const rowEl = gridEl.querySelector(`.motus-row[data-row="${idx}"]`);
    if (!rowEl) return;
    rowEl.classList.add("flash-error");
    setTimeout(() => rowEl.classList.remove("flash-error"), 400);
  }

  function resetKeyboardColors() {
    for (const btn of Object.values(keyButtons)) {
      btn.classList.remove("kb-absent", "kb-misplaced", "kb-good");
    }
  }

  // ---- Vue between-words ----
  function showBetweenSummary() {
    if (!state.currentWord) return;
    const { revealedWord, status, foundBy } = state.currentWord;
    if (status === "found") {
      betweenSummaryEl.textContent = foundBy ? `${foundBy} a trouvé le mot ! 🎉` : "Mot trouvé !";
      betweenSummaryEl.className = "between-summary success";
    } else {
      betweenSummaryEl.textContent = "Essais épuisés. Le mot était :";
      betweenSummaryEl.className = "between-summary failure";
    }
    betweenWordEl.textContent = revealedWord || "?";

    // Boutons "next" / "end" pour l'hote uniquement
    if (state.isHost) {
      nextWordBtn.style.display = "";
      endGameBtn.style.display = "";
      guestWaitingEl.style.display = "none";
    } else {
      nextWordBtn.style.display = "none";
      endGameBtn.style.display = "none";
      guestWaitingEl.style.display = "";
      guestWaitingEl.textContent = `En attente de ${state.hostPseudo || "l'hôte"}…`;
    }
  }

  // ---- API exposee a room.js ----
  function refresh() {
    if (state.phase === "in_game" || state.phase === "between_words") {
      rebuildGrid();
      updateStatus();
      if (state.phase === "between_words") {
        showBetweenSummary();
      }
    }
    updateClavierVisibility();
  }

  function onWordStarted() {
    typingBuffer = "";
    lastFlashed = -1;
    resetKeyboardColors();
    rebuildGrid();
    updateStatus();
    updateClavierVisibility();
  }

  function onGuessResolved(msg) {
    // Reset le buffer (l'essai a ete consomme)
    typingBuffer = "";
    paintAttemptRow(msg.attemptIndex, msg.attempt);
    renderCurrentTypingRow();
    updateStatus();
  }

  function updateStatus() {
    if (!state.currentWord) {
      statusLineEl.textContent = "";
      wordInfoEl.textContent = "";
      return;
    }
    const { attempts, maxAttempts, status, wordLength } = state.currentWord;
    wordInfoEl.textContent = `${wordLength} lettres`;
    if (status === "in_progress") {
      statusLineEl.textContent = `Essai ${attempts.length + 1} / ${maxAttempts}`;
    } else if (status === "found") {
      statusLineEl.textContent = `Trouvé en ${attempts.length} essai${attempts.length > 1 ? "s" : ""} !`;
    } else {
      statusLineEl.textContent = "Essais épuisés.";
    }
  }

  function updateClavierVisibility() {
    if (state.config && state.config.mode === "coop_stream" && !state.isHost) {
      keyboardEl.style.display = "none";
      guestNoticeEl.style.display = "";
      guestNoticeEl.textContent = `${state.hostPseudo || "L'hôte"} tape les essais. À toi de proposer !`;
    } else {
      keyboardEl.style.display = "";
      guestNoticeEl.style.display = "none";
    }
  }

  // Listeners boutons between-words
  nextWordBtn.addEventListener("click", () => {
    if (!state.isHost) return;
    conn.send({ type: "next_word" });
  });
  endGameBtn.addEventListener("click", () => {
    if (!state.isHost) return;
    if (confirm("Terminer la partie ? On retournera au lobby.")) {
      conn.send({ type: "end_game" });
    }
  });

  return { refresh, onWordStarted, onGuessResolved };
}

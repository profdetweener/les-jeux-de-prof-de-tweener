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

const KEYBOARD_ROWS = [
  ["A", "Z", "E", "R", "T", "Y", "U", "I", "O", "P"],
  ["Q", "S", "D", "F", "G", "H", "J", "K", "L", "M"],
  ["DEL", "W", "X", "C", "V", "B", "N", "ENTER"],
];

export function initCompView(state, conn) {
  // --- Refs DOM ---
  const roundInfoEl = document.getElementById("comp-round-info");
  const timerEl = document.getElementById("comp-timer");
  const attemptInfoEl = document.getElementById("comp-attempt-info");
  const gridEl = document.getElementById("comp-grid");
  const selfNoticeEl = document.getElementById("comp-self-notice");
  const keyboardEl = document.getElementById("comp-keyboard");
  const opponentsEl = document.getElementById("comp-opponents");

  const recapTitleEl = document.getElementById("comp-recap-title");
  const recapWordEl = document.getElementById("comp-recap-word");
  const recapTableEl = document.getElementById("comp-recap-table");
  const nextRoundBtn = document.getElementById("comp-next-round-btn");
  const endGameBtn = document.getElementById("comp-end-game-btn");
  const recapWaitingEl = document.getElementById("comp-recap-waiting");

  const podiumEl = document.getElementById("comp-podium");
  const finalTableEl = document.getElementById("comp-final-table");
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
  };
  let typingBuffer = "";
  let keyButtons = {};
  let timerInterval = null;

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
    if (!round.active || round.myStatus !== "playing") return;
    if (state.phase !== "in_round") return;
    const k = e.key.toUpperCase();
    if (k === "ENTER") { e.preventDefault(); onKeyPress("ENTER"); }
    else if (k === "BACKSPACE") { e.preventDefault(); onKeyPress("DEL"); }
    else if (/^[A-Z]$/.test(k)) { e.preventDefault(); onKeyPress(k); }
  }

  function onKeyPress(key) {
    if (!round.active || round.myStatus !== "playing") return;
    if (key === "ENTER") {
      submitGuess();
    } else if (key === "DEL") {
      typingBuffer = typingBuffer.slice(0, -1);
      renderMyGrid();
    } else if (/^[A-Z]$/.test(key)) {
      if (typingBuffer.length < round.wordLength) {
        typingBuffer += key;
        renderMyGrid();
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
    conn.send({ type: "submit_guess", guess: typingBuffer });
    // On ne vide pas le buffer tout de suite : on attend la reponse serveur
    // (guess_result) pour le consigner. Si refus (erreur), le buffer reste.
  }

  // =========================================================================
  // Rendu de MA grille
  // =========================================================================
  function renderMyGrid() {
    gridEl.innerHTML = "";
    gridEl.style.setProperty("--motus-cols", round.wordLength);
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
          } else if (c === 0) {
            // 1ere lettre imposee, en indice sur la ligne courante vide
            cell.textContent = round.firstLetter;
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
    timerEl.textContent = `${m}:${String(s).padStart(2, "0")}`;
    timerEl.classList.toggle("comp-timer-urgent", totalSec <= 10);
    if (remaining <= 0) stopTimer();
  }

  // =========================================================================
  // Handlers de messages serveur
  // =========================================================================

  function onRoundStarted(msg) {
    round.active = true;
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

    const totalTxt = msg.totalRounds ? ` / ${msg.totalRounds}` : "";
    roundInfoEl.textContent = `Manche ${msg.roundIndex}${totalTxt}`;

    buildKeyboard();
    buildOpponents(msg.opponents);
    renderMyGrid();
    for (const p of msg.opponents) renderOpponent(p);
    startTimer();
  }

  function onGuessResult(msg) {
    round.myAttempts[msg.attemptIndex] = msg.attempt;
    round.myStatus = msg.myStatus;
    typingBuffer = "";
    renderMyGrid();
  }

  function onOpponentProgress(msg) {
    const opp = round.opponents[msg.playerId];
    if (!opp) return;
    opp.rows[msg.rowIndex] = msg.row;
    opp.status = msg.status;
    opp.attemptsUsed = msg.attemptsUsed;
    renderOpponent(msg.playerId);
  }

  function onRoundEnded(msg) {
    round.active = false;
    stopTimer();
    renderRecap(msg);
  }

  function onGameEnded(msg) {
    round.active = false;
    stopTimer();
    renderFinal(msg.results);
  }

  // =========================================================================
  // Recap entre manches
  // =========================================================================
  function renderRecap(msg) {
    recapTitleEl.textContent = msg.isLastRound
      ? "Dernière manche terminée"
      : `Manche ${msg.roundIndex} terminée`;
    recapWordEl.innerHTML = `Le mot était <strong>${msg.revealedWord}</strong>`;
    recapTableEl.innerHTML = buildScoreTable(msg.results, true);

    // Boutons : seul l'hote, et seulement si la partie continue
    if (state.isHost && !msg.isLastRound) {
      nextRoundBtn.style.display = "";
      endGameBtn.style.display = "";
      recapWaitingEl.style.display = "none";
    } else if (state.isHost && msg.isLastRound) {
      nextRoundBtn.style.display = "none";
      endGameBtn.style.display = "none";
      recapWaitingEl.style.display = "";
      recapWaitingEl.textContent = "Partie terminée — voir le classement final…";
    } else {
      nextRoundBtn.style.display = "none";
      endGameBtn.style.display = "none";
      recapWaitingEl.style.display = "";
      recapWaitingEl.textContent = `En attente de ${state.hostPseudo || "l'hôte"}…`;
    }
  }

  function renderFinal(results) {
    // Podium top 3
    podiumEl.innerHTML = "";
    const medals = ["🥇", "🥈", "🥉"];
    results.slice(0, 3).forEach((r, i) => {
      const slot = document.createElement("div");
      slot.className = `podium-slot podium-${i + 1}`;
      slot.innerHTML = `<div class="podium-medal">${medals[i]}</div>` +
        `<div class="podium-name">${escapeHtml(r.playerId)}</div>` +
        `<div class="podium-score">${r.totalPoints} pts</div>`;
      podiumEl.appendChild(slot);
    });
    finalTableEl.innerHTML = buildScoreTable(results, false);

    if (state.isHost) {
      backLobbyBtn.style.display = "";
      finalWaitingEl.style.display = "none";
    } else {
      backLobbyBtn.style.display = "none";
      finalWaitingEl.style.display = "";
      finalWaitingEl.textContent = `En attente de ${state.hostPseudo || "l'hôte"}…`;
    }
  }

  function buildScoreTable(results, showRoundPts) {
    let html = "<thead><tr><th>#</th><th>Joueur</th>";
    if (showRoundPts) html += "<th>Essais</th><th>Manche</th>";
    html += "<th>Total</th></tr></thead><tbody>";
    results.forEach((r, i) => {
      const essais = r.found ? `${r.attemptsUsed}` : "—";
      html += `<tr><td>${i + 1}</td><td>${escapeHtml(r.playerId)}</td>`;
      if (showRoundPts) {
        html += `<td>${essais}</td><td>+${r.roundPoints}</td>`;
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
  endGameBtn.addEventListener("click", () => {
    if (!state.isHost) return;
    conn.send({ type: "end_game" });
  });
  backLobbyBtn.addEventListener("click", () => {
    if (!state.isHost) return;
    conn.send({ type: "end_game" });
  });

  document.addEventListener("keydown", onPhysicalKey);

  // =========================================================================
  // Reconnexion : restaure l'etat de la manche depuis joined.compRound
  // =========================================================================
  function restoreFromSnapshot(cr) {
    if (!cr) return;
    round.active = true;
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
    for (const p of (cr.opponents || [])) renderOpponent(p);
    startTimer();
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
  };
}

/**
 * Vue "writing" — Definitions.
 * Affiche le mot, une zone de saisie pour sa définition, un timer, et un bouton
 * "Valider ma définition" (lock). Sauvegarde continue debounced ; le serveur
 * garde la dernière version même si le timer tombe.
 */

import { LIMITS } from "./constants.js";
import { showToast } from "../../shared/js/toast.js";

export function initWritingView(state, conn) {
  const roundNumberEl = document.getElementById("wr-round-number");
  const roundTotalEl = document.getElementById("wr-round-total");
  const timerDisplayEl = document.getElementById("wr-timer-display");
  const timerValueEl = document.getElementById("wr-timer-value");
  const wordEl = document.getElementById("wr-word");
  const textarea = document.getElementById("def-textarea");
  const charcountEl = document.getElementById("def-charcount");
  const lockBtn = document.getElementById("btn-lock");
  const forceEndBtn = document.getElementById("btn-force-end-writing");
  const statusEl = document.getElementById("writing-status");
  const writersStatusEl = document.getElementById("writers-status");

  let timerIntervalId = null;
  let saveTimeoutId = null;
  let locked = false;
  const lockedPlayers = new Set();

  state.renderRoundStart = function (msg) {
    locked = false;
    lockedPlayers.clear();

    roundNumberEl.textContent = msg.roundNumber;
    const total = msg.totalRounds ?? state.config?.totalRounds ?? 0;
    roundTotalEl.textContent = total > 0 ? `/ ${total}` : "";
    wordEl.textContent = msg.word;

    textarea.value = (msg.previousDefinition && typeof msg.previousDefinition === "string")
      ? msg.previousDefinition
      : "";
    textarea.disabled = false;
    updateCharcount();

    lockBtn.disabled = false;
    lockBtn.textContent = "✅ Valider ma définition";
    statusEl.textContent = "Tu peux modifier ta définition tant que tu n'as pas validé.";
    renderWriters();

    if (msg.previousDefinition && msg.previousDefinition.trim().length > 0) {
      showToast("Ta définition en cours a été restaurée.", { type: "success", duration: 2000 });
    }

    textarea.focus();
    if (msg.roundEndsAt) {
      timerDisplayEl.style.display = "";
      startCountdown(msg.roundEndsAt);
    } else {
      // Mode chill : pas de timer
      timerDisplayEl.style.display = "none";
      if (timerIntervalId) {
        clearInterval(timerIntervalId);
        timerIntervalId = null;
      }
    }
    refreshHostForceEnd();
  };

  // Bouton "passer aux votes" pour l'hote en mode chill
  function refreshHostForceEnd() {
    if (!forceEndBtn) return;
    const isChill = state.config?.mode === "chill";
    forceEndBtn.style.display = (state.isHost && isChill) ? "block" : "none";
  }
  state.refreshWritingHostState = refreshHostForceEnd;

  state.stopWritingCountdown = function () {
    if (timerIntervalId) {
      clearInterval(timerIntervalId);
      timerIntervalId = null;
    }
    if (saveTimeoutId) {
      clearTimeout(saveTimeoutId);
      saveTimeoutId = null;
    }
  };

  state.onDefinitionLocked = function (pseudo) {
    lockedPlayers.add(pseudo);
    renderWriters();
  };

  function renderWriters() {
    const total = state.players.filter((p) => p.isConnected).length;
    const count = lockedPlayers.size;
    if (count === 0) {
      writersStatusEl.textContent = "";
      return;
    }
    const names = [...lockedPlayers].join(", ");
    writersStatusEl.innerHTML =
      `<span class="locked-list">A validé : ${names}</span> — ${count} / ${total}`;
  }

  function updateCharcount() {
    const len = textarea.value.length;
    charcountEl.textContent = `${len} / ${LIMITS.MAX_DEFINITION_LEN}`;
    charcountEl.classList.toggle("over", len >= LIMITS.MAX_DEFINITION_LEN);
  }

  function startCountdown(roundEndsAt) {
    if (timerIntervalId) clearInterval(timerIntervalId);
    function tick() {
      const remainingMs = roundEndsAt - Date.now();
      if (remainingMs <= 0) {
        timerValueEl.textContent = "00:00";
        timerDisplayEl.classList.add("critical");
        clearInterval(timerIntervalId);
        timerIntervalId = null;
        return;
      }
      const totalSec = Math.ceil(remainingMs / 1000);
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      timerValueEl.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
      timerDisplayEl.classList.toggle("critical", totalSec <= 10);
    }
    tick();
    timerIntervalId = setInterval(tick, 1000);
  }

  function pushDefinition() {
    if (locked) return;
    conn.send({ type: "submit_definition", text: textarea.value.slice(0, LIMITS.MAX_DEFINITION_LEN) });
  }

  textarea.addEventListener("input", () => {
    updateCharcount();
    if (locked) return;
    if (saveTimeoutId) clearTimeout(saveTimeoutId);
    saveTimeoutId = setTimeout(pushDefinition, 500);
  });

  lockBtn.addEventListener("click", () => {
    if (locked) return;
    locked = true;
    if (saveTimeoutId) {
      clearTimeout(saveTimeoutId);
      saveTimeoutId = null;
    }
    // Envoi immédiat de la version finale + lock
    conn.send({ type: "submit_definition", text: textarea.value.slice(0, LIMITS.MAX_DEFINITION_LEN) });
    conn.send({ type: "lock_definition" });
    textarea.disabled = true;
    lockBtn.disabled = true;
    lockBtn.textContent = "Définition validée — en attente des autres…";
    statusEl.textContent = "Ta définition a été envoyée. La manche se termine quand tout le monde a validé (ou au timer).";
    showToast("Définition validée.", { type: "success", duration: 1500 });
  });

  if (forceEndBtn) {
    forceEndBtn.addEventListener("click", () => {
      if (!confirm("Couper la phase d'écriture maintenant et passer aux votes ?")) return;
      conn.send({ type: "next_round" });
    });
  }
}

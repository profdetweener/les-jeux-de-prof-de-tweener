/**
 * Vue "in_round" : grille de saisie + timer + bouton STOP.
 *
 * Strategie de sauvegarde :
 *   - le client envoie un submit_answers debounced 500ms apres chaque modif
 *   - le serveur ecrase ses reponses precedentes (dernier gagne)
 *   - quand la manche finit (timer ou STOP), le serveur a la derniere version
 *   - le STOP marque le joueur comme "fini" et termine la manche pour tous
 *
 * Le timer affiche est purement decoratif : c'est le serveur qui decide
 * autoritairement quand la manche se termine (via le message round_ended).
 */

import {
  LIMITS,
  answerMatchesLetter,
  answerMatchesLength,
  describeLengthConstraint,
} from "./constants.js";
import { showToast } from "../../shared/js/toast.js";

export function initRoundView(state, conn) {
  const formEl = document.getElementById("answers-form");
  const roundNumberEl = document.getElementById("round-number");
  const roundTotalEl = document.getElementById("round-total");
  const letterValueEl = document.getElementById("letter-value");
  const timerDisplayEl = document.getElementById("timer-display");
  const timerValueEl = document.getElementById("timer-value");
  const stopBtn = document.getElementById("btn-stop");
  const submissionStatusEl = document.getElementById("submission-status");
  const letterLengthHintEl = document.getElementById("letter-length-hint");

  // Refs barre sticky mobile (peuvent etre absentes sur les anciens HTML)
  const rsbLetterEl = document.getElementById("rsb-letter");
  const rsbRoundNumEl = document.getElementById("rsb-round-num");
  const rsbRoundTotalEl = document.getElementById("rsb-round-total");
  const rsbTimerEl = document.getElementById("rsb-timer");
  const rsbLengthEl = document.getElementById("rsb-length");
  const rsbEl = document.getElementById("round-sticky-bar");

  let timerIntervalId = null;
  let inputs = {};       // category -> input element
  let saveTimeoutId = null;
  let stopped = false;   // l'utilisateur a clique STOP
  let currentLetter = null;
  let currentEndMode = "stop_or_timer";
  let currentLengthConstraint = null;

  /**
   * Construit le formulaire avec un input par categorie.
   *
   * Si msg.previousAnswers est present (cas reconnexion / refresh en
   * pleine manche), on pre-remplit les inputs avec les valeurs deja
   * envoyees au serveur, et on met immediatement a jour l'etat du
   * bouton STOP en consequence.
   */
  state.renderRoundStart = function (msg) {
    stopped = false;
    currentLetter = msg.letter;
    currentEndMode = state.config?.endMode === "timer_only" ? "timer_only" : "stop_or_timer";
    currentLengthConstraint = state.config?.lengthConstraint ?? null;

    // Mode "timer_only" : pas de bouton STOP du tout. Sinon affichage normal.
    if (currentEndMode === "timer_only") {
      stopBtn.style.display = "none";
      const lenDesc = describeLengthConstraint(currentLengthConstraint);
      submissionStatusEl.textContent = lenDesc
        ? `Mode timer : la manche se termine quand le temps est écoulé. Contrainte de longueur : ${lenDesc}.`
        : "Mode timer : la manche se termine quand le temps est écoulé. Pas de bouton STOP.";
    } else {
      stopBtn.style.display = "";
      stopBtn.disabled = true; // grise par defaut, active quand toutes les cases sont remplies
      stopBtn.textContent = "🛑 STOP, j'ai terminé";
      const lenDesc = describeLengthConstraint(currentLengthConstraint);
      submissionStatusEl.textContent = lenDesc
        ? `Remplis toutes les cases (bonne lettre + ${lenDesc}) pour pouvoir cliquer STOP.`
        : "Remplis toutes les cases (avec la bonne lettre) pour pouvoir cliquer STOP.";
    }

    roundNumberEl.textContent = msg.roundNumber;
    const total = msg.totalRounds ?? state.config?.totalRounds ?? 0;
    if (total > 0) {
      roundTotalEl.textContent = `/ ${total}`;
    } else {
      roundTotalEl.textContent = "";
    }
    letterValueEl.textContent = msg.letter;

    // Rappel de la contrainte de longueur, juste sous la grosse lettre.
    // C'est la 2e regle syntaxique de la manche, elle vit avec la lettre.
    if (letterLengthHintEl) {
      const lc = currentLengthConstraint;
      if (lc && lc.mode !== "none") {
        const symbol = lc.mode === "min" ? "≥" : "≤";
        letterLengthHintEl.textContent = `${symbol} ${lc.value} lettres`;
        letterLengthHintEl.title =
          lc.mode === "min"
            ? `Chaque mot doit faire au moins ${lc.value} lettres`
            : `Chaque mot doit faire au plus ${lc.value} lettres`;
        letterLengthHintEl.style.display = "";
      } else {
        letterLengthHintEl.style.display = "none";
        letterLengthHintEl.textContent = "";
      }
    }

    // Sticky bar (mobile)
    if (rsbLetterEl) rsbLetterEl.textContent = msg.letter;
    if (rsbRoundNumEl) rsbRoundNumEl.textContent = msg.roundNumber;
    if (rsbRoundTotalEl) rsbRoundTotalEl.textContent = total > 0 ? `/${total}` : "";
    // Rappel ultra-compact dans la barre sticky : ≥5 / ≤8
    if (rsbLengthEl) {
      const lc = currentLengthConstraint;
      if (lc && lc.mode !== "none") {
        const symbol = lc.mode === "min" ? "≥" : "≤";
        rsbLengthEl.textContent = `${symbol}${lc.value}`;
        rsbLengthEl.style.display = "";
      } else {
        rsbLengthEl.style.display = "none";
        rsbLengthEl.textContent = "";
      }
    }
    if (rsbEl) rsbEl.classList.remove("stopped");

    // Construire le formulaire
    formEl.innerHTML = "";
    inputs = {};
    msg.categories.forEach((category, idx) => {
      const row = document.createElement("div");
      row.className = "answer-row";
      const label = document.createElement("label");
      label.textContent = category;
      label.htmlFor = `answer-${idx}`;
      const input = document.createElement("input");
      input.type = "text";
      input.id = `answer-${idx}`;
      input.maxLength = LIMITS.MAX_ANSWER_LEN;
      input.autocomplete = "off";
      input.spellcheck = false;
      // Optimisations mobile : majuscule auto sur le 1er caractere,
      // pas de correction auto (qui transforme les noms propres),
      // bouton "Suivant" / "OK" sur le clavier virtuel.
      input.setAttribute("autocapitalize", "words");
      input.setAttribute("autocorrect", "off");
      input.setAttribute("enterkeyhint", idx === msg.categories.length - 1 ? "done" : "next");
      input.dataset.category = category;
      // Pre-remplissage en cas de reconnexion : le serveur nous a renvoye
      // les reponses qu'on avait deja envoyees.
      if (msg.previousAnswers && typeof msg.previousAnswers[category] === "string") {
        input.value = msg.previousAnswers[category];
      }
      row.appendChild(label);
      row.appendChild(input);
      formEl.appendChild(row);
      inputs[category] = input;
    });

    // Si on a pre-rempli des reponses, met a jour l'etat du bouton STOP
    // (sinon il reste grise alors que la grille est peut-etre deja complete)
    // et indique au joueur que ses reponses ont ete restaurees.
    if (msg.previousAnswers && Object.keys(msg.previousAnswers).length > 0) {
      const nonEmpty = Object.values(msg.previousAnswers).filter(
        (v) => typeof v === "string" && v.trim().length > 0
      ).length;
      if (nonEmpty > 0) {
        showToast(`Tes ${nonEmpty} réponses ont été restaurées.`, {
          type: "success",
          duration: 2500,
        });
      }
      refreshStopButton();
    }

    // Focus sur la premiere case vide (ou la premiere tout court)
    const firstEmpty = Object.values(inputs).find((i) => i.value.trim().length === 0);
    const focusTarget = firstEmpty ?? formEl.querySelector("input");
    if (focusTarget) focusTarget.focus();

    // Demarrer le compte a rebours
    startCountdown(msg.roundEndsAt);
  };

  function startCountdown(roundEndsAt) {
    if (timerIntervalId) clearInterval(timerIntervalId);
    function tick() {
      const remainingMs = roundEndsAt - Date.now();
      if (remainingMs <= 0) {
        timerValueEl.textContent = "00:00";
        timerDisplayEl.classList.add("critical");
        if (rsbTimerEl) rsbTimerEl.textContent = "00:00";
        if (rsbEl) {
          rsbEl.classList.remove("warning");
          rsbEl.classList.add("critical");
        }
        clearInterval(timerIntervalId);
        timerIntervalId = null;
        return;
      }
      const totalSec = Math.ceil(remainingMs / 1000);
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      const formatted = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
      timerValueEl.textContent = formatted;
      if (rsbTimerEl) rsbTimerEl.textContent = formatted;
      timerDisplayEl.classList.remove("warning", "critical");
      if (rsbEl) rsbEl.classList.remove("warning", "critical");
      if (totalSec <= 5) {
        timerDisplayEl.classList.add("critical");
        if (rsbEl) rsbEl.classList.add("critical");
      } else if (totalSec <= 15) {
        timerDisplayEl.classList.add("warning");
        if (rsbEl) rsbEl.classList.add("warning");
      }
    }
    tick();
    timerIntervalId = setInterval(tick, 200);
  }

  state.stopRoundCountdown = function () {
    if (timerIntervalId) {
      clearInterval(timerIntervalId);
      timerIntervalId = null;
    }
    if (saveTimeoutId) {
      clearTimeout(saveTimeoutId);
      saveTimeoutId = null;
    }
  };

  function collectAnswers() {
    const answers = {};
    for (const [cat, input] of Object.entries(inputs)) {
      answers[cat] = input.value.slice(0, LIMITS.MAX_ANSWER_LEN);
    }
    return answers;
  }

  /**
   * Envoie l'etat courant des reponses au serveur.
   * Appele en debounced sur input, et immediatement avant un STOP.
   */
  function pushAnswers() {
    if (stopped) return;
    conn.send({ type: "submit_answers", answers: collectAnswers() });
  }

  /**
   * Verifie que TOUTES les cases sont remplies (au moins un caractere non blanc)
   * ET que toutes commencent par la bonne lettre.
   * Active/desactive le bouton STOP en consequence.
   *
   * Si on est en mode "timer_only", la fonction est un no-op : le bouton STOP
   * est cache de toute facon.
   */
  function refreshStopButton() {
    if (currentEndMode === "timer_only") return;
    if (stopped) return;

    const constraint = currentLengthConstraint;
    const constraintActive = constraint && constraint.mode !== "none";
    const lengthDesc = describeLengthConstraint(constraint);

    // Marque visuellement chaque input dont la valeur viole la contrainte de
    // longueur. On le fait aussi pour les inputs non-vides qui ne commencent
    // pas par la bonne lettre, meme principe, c'est le meme genre d'erreur.
    Object.values(inputs).forEach((input) => {
      const v = input.value.trim();
      const badLetter = v.length > 0 && !answerMatchesLetter(input.value, currentLetter);
      const badLength =
        constraintActive && v.length > 0 && !answerMatchesLength(input.value, constraint);
      input.classList.toggle("answer-bad-letter", badLetter);
      input.classList.toggle("answer-bad-length", badLength);
      if (badLength && !badLetter) {
        input.title = `Hors limite : ${lengthDesc}`;
      } else if (!badLength && !badLetter) {
        input.title = "";
      }
    });

    const allFilled = Object.values(inputs).every(
      (input) => input.value.trim().length > 0
    );
    const allGoodLetter = Object.values(inputs).every((input) =>
      answerMatchesLetter(input.value, currentLetter)
    );
    const allGoodLength =
      !constraintActive ||
      Object.values(inputs).every((input) => answerMatchesLength(input.value, constraint));

    const total = Object.keys(inputs).length;
    const filled = Object.values(inputs).filter(
      (i) => i.value.trim().length > 0
    ).length;
    const badLetter = Object.values(inputs).filter(
      (i) => i.value.trim().length > 0 && !answerMatchesLetter(i.value, currentLetter)
    ).length;
    const badLength = constraintActive
      ? Object.values(inputs).filter(
          (i) => i.value.trim().length > 0 && !answerMatchesLength(i.value, constraint)
        ).length
      : 0;

    stopBtn.disabled = !(allFilled && allGoodLetter && allGoodLength);
    if (allFilled && allGoodLetter && allGoodLength) {
      submissionStatusEl.textContent = "";
    } else if (!allFilled) {
      submissionStatusEl.textContent = `${filled} / ${total} cases remplies, remplis tout pour pouvoir cliquer STOP.`;
    } else if (!allGoodLetter) {
      // Toutes remplies, mais certaines ne commencent pas par la lettre
      submissionStatusEl.textContent = `${badLetter} réponse(s) ne commence(nt) pas par ${currentLetter}, corrige avant de cliquer STOP.`;
    } else {
      // Toutes remplies + bonne lettre, mais contrainte de longueur violee
      submissionStatusEl.textContent = `${badLength} réponse(s) hors limite (${lengthDesc}), corrige avant de cliquer STOP.`;
    }
  }

  // --- Sauvegarde continue ---
  formEl.addEventListener("input", () => {
    if (stopped) return;
    refreshStopButton();
    if (saveTimeoutId) clearTimeout(saveTimeoutId);
    saveTimeoutId = setTimeout(pushAnswers, 500);
  });

  // --- STOP ---
  stopBtn.addEventListener("click", () => {
    if (stopped) return;
    // En mode "timer_only", le bouton est cache mais defense en profondeur quand meme
    if (currentEndMode === "timer_only") {
      showToast("Le mode de partie n'autorise pas le STOP.", { type: "error" });
      return;
    }
    // Defense en profondeur : meme si le bouton n'etait pas grise (cas non prevu),
    // on refuse le STOP si la grille n'est pas complete OU si une reponse ne commence
    // pas par la bonne lettre.
    const allFilled = Object.values(inputs).every(
      (input) => input.value.trim().length > 0
    );
    if (!allFilled) {
      console.warn("[round] STOP refuse : grille incomplete", {
        inputs: Object.fromEntries(
          Object.entries(inputs).map(([k, v]) => [k, v.value])
        ),
      });
      showToast("Remplis toutes les cases avant de cliquer STOP.", { type: "error" });
      refreshStopButton();
      return;
    }
    const allGoodLetter = Object.values(inputs).every((input) =>
      answerMatchesLetter(input.value, currentLetter)
    );
    if (!allGoodLetter) {
      console.warn("[round] STOP refuse : mauvaise lettre", {
        inputs: Object.fromEntries(
          Object.entries(inputs).map(([k, v]) => [k, v.value])
        ),
        letter: currentLetter,
      });
      showToast(`Toutes tes réponses doivent commencer par ${currentLetter}.`, { type: "error" });
      refreshStopButton();
      return;
    }
    // Contrainte de longueur : 3e garde, miroir de la garde "bonne lettre"
    const constraint = currentLengthConstraint;
    if (constraint && constraint.mode !== "none") {
      const allGoodLength = Object.values(inputs).every((input) =>
        answerMatchesLength(input.value, constraint)
      );
      if (!allGoodLength) {
        const desc = describeLengthConstraint(constraint);
        console.warn("[round] STOP refuse : contrainte de longueur", {
          constraint,
        });
        showToast(`Toutes tes réponses doivent faire ${desc}.`, { type: "error" });
        refreshStopButton();
        return;
      }
    }
    stopped = true;
    if (saveTimeoutId) {
      clearTimeout(saveTimeoutId);
      saveTimeoutId = null;
    }
    // Envoie immediat des reponses courantes, puis stop_round
    conn.send({ type: "submit_answers", answers: collectAnswers() });
    conn.send({ type: "stop_round" });
    stopBtn.disabled = true;
    stopBtn.textContent = "Manche stoppée, en attente de la suite…";
    submissionStatusEl.textContent = "Tes réponses ont été envoyées.";
    if (rsbEl) rsbEl.classList.add("stopped");
    showToast("STOP envoyé.", { type: "success", duration: 1500 });
  });

  // --- Navigation au clavier ---
  formEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.target.tagName !== "INPUT") return;
    e.preventDefault();
    const allInputs = formEl.querySelectorAll("input");
    const idx = Array.from(allInputs).indexOf(e.target);
    if (idx === allInputs.length - 1) {
      // Dernier champ : STOP seulement si on est en mode stop_or_timer et que c'est dispo
      if (currentEndMode === "stop_or_timer" && !stopBtn.disabled) {
        stopBtn.click();
      } else {
        // Sinon on enleve juste le focus pour fermer le clavier mobile
        e.target.blur();
      }
    } else {
      allInputs[idx + 1].focus();
    }
  });

  // --- Notifications "X a fini" ---
  state.onAnswersReceived = function (pseudo) {
    if (pseudo === state.myPseudo) return;
    submissionStatusEl.textContent = `${pseudo} a terminé.`;
  };
}

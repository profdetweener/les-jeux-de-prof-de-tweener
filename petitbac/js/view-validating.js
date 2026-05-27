/**
 * Vue "validating" : tableau croise (joueurs en LIGNES, categories en COLONNES).
 *
 * Modele COLLABORATIF :
 *   - chaque cellule a UN SEUL etat (cellStates[pseudo][category] = "unique"|"duplicate"|"reject")
 *   - n'importe qui peut modifier n'importe quelle cellule, y compris la sienne propre
 *   - les changements sont broadcast immediatement a toutes les fenetres
 *
 * Affichage :
 *   - cellule valide (reponse non vide + bonne lettre) : 3 boutons cliquables
 *   - cellule invalide (vide ou mauvaise lettre) : juste affichee en gris, non-cliquable
 *     (forcement "reject", pas modifiable)
 *
 * Boutons host :
 *   - "Calculer les scores" -> next_round
 *   - "Terminer la partie maintenant" -> end_game (avec confirmation)
 */

import {
  answerMatchesLength,
  answerMatchesLetter,
  describeLengthConstraint,
} from "./constants.js";

export function initValidatingView(state, conn) {
  const tableEl = document.getElementById("validation-table");
  const roundNumberEl = document.getElementById("vr-round-number");
  const roundTotalEl = document.getElementById("vr-round-total");
  const letterValueEl = document.getElementById("vr-letter-value");
  const reasonEl = document.getElementById("round-end-reason");
  const hostActionsEl = document.getElementById("validation-host-actions");
  const waitingEl = document.getElementById("validation-waiting");
  const finishBtn = document.getElementById("btn-finish-validation");
  const endGameBtn = document.getElementById("btn-end-game-validating");

  // --- Refs panneau "malus tricheur" ---
  const cheaterPanelEl = document.getElementById("cheater-panel");
  const cheaterStopperEl = document.getElementById("cheater-stopper");
  const cheaterCountEl = document.getElementById("cheater-count");
  const cheaterDecBtn = document.getElementById("cheater-dec");
  const cheaterIncBtn = document.getElementById("cheater-inc");
  const cheaterResultEl = document.getElementById("cheater-panel-result");

  let currentLetter = null;
  let currentCategories = [];
  let currentPseudos = [];
  let currentAnswers = {};
  let currentCellStates = {};
  // Etat collaboratif du compteur "categories tricheuses"
  let cheaterStoppedBy = null;
  let cheaterCount = 0;
  let cheaterPenaltyPerCheat = 0;

  /**
   * Appele quand round_ended arrive : construit le tableau initial.
   */
  state.renderValidationStart = function (msg) {
    const result = msg.result;
    currentLetter = result.letter;
    currentAnswers = result.answers;
    currentCellStates = result.cellStates ?? {};
    currentCategories = msg.categories ?? state.config?.categories ?? [];
    currentPseudos = Object.keys(currentAnswers);

    // Donnees du panneau "tricheur" : viennent du RoundResult cote serveur.
    // En reconnexion, le compteur peut etre > 0 si d'autres joueurs ont deja vote.
    cheaterStoppedBy = result.stoppedBy ?? null;
    cheaterCount = result.cheaterCheats ?? 0;
    cheaterPenaltyPerCheat = state.config?.scoring?.cheaterPenaltyPerCheat ?? 0;

    console.log("[validation] renderValidationStart", {
      isHost: state.isHost,
      myPseudo: state.myPseudo,
      categoriesLen: currentCategories.length,
      pseudosLen: currentPseudos.length,
      reason: msg.reason,
      stoppedBy: cheaterStoppedBy,
      cheaterPenaltyPerCheat,
    });

    roundNumberEl.textContent = result.roundNumber;
    const total = msg.totalRounds ?? state.config?.totalRounds ?? 0;
    roundTotalEl.textContent = total > 0 ? `/ ${total}` : "";
    letterValueEl.textContent = result.letter;
    reasonEl.textContent = formatReason(msg.reason, msg.stoppedBy ?? cheaterStoppedBy);

    renderTable();
    renderCheaterPanel();
    updateHostActions();
  };

  /**
   * Appele a chaque cell_state_update : ne rerend QUE les cellules.
   */
  state.applyCellStateUpdate = function (cellStates) {
    currentCellStates = cellStates;
    refreshAllCells();
  };

  /**
   * Appele a chaque cheater_cheats_update : met a jour le compteur en direct.
   */
  state.applyCheaterCountUpdate = function (count) {
    cheaterCount = count;
    renderCheaterPanel();
  };

  state.refreshValidationHostState = function () {
    updateHostActions();
  };

  function formatReason(reason, stoppedBy) {
    switch (reason) {
      case "timer":
        return "⏱️ Manche terminee : timer ecoule.";
      case "stop":
        return `🛑 Manche stoppée par ${stoppedBy ?? "un joueur"}.`;
      case "all_submitted":
        return "✅ Tous les joueurs ont terminé.";
      default:
        return "";
    }
  }

  function renderTable() {
    tableEl.innerHTML = "";

    if (currentCategories.length === 0 || currentPseudos.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.textContent = "Aucune donnée à afficher.";
      td.style.padding = "20px";
      td.style.textAlign = "center";
      td.style.fontStyle = "italic";
      tr.appendChild(td);
      tableEl.appendChild(tr);
      return;
    }

    // Header : "Joueur" puis une colonne par categorie
    const thead = document.createElement("thead");
    const trHead = document.createElement("tr");
    const thPseudo = document.createElement("th");
    thPseudo.className = "col-category";
    thPseudo.textContent = "Joueur";
    trHead.appendChild(thPseudo);
    for (const category of currentCategories) {
      const th = document.createElement("th");
      th.textContent = category;
      trHead.appendChild(th);
    }
    thead.appendChild(trHead);
    tableEl.appendChild(thead);

    // Body : une ligne par joueur
    const tbody = document.createElement("tbody");
    for (const pseudo of currentPseudos) {
      const tr = document.createElement("tr");
      tr.dataset.pseudo = pseudo;
      const isMe = pseudo === state.myPseudo;
      if (isMe) tr.classList.add("is-self");
      const tdPseudo = document.createElement("td");
      tdPseudo.className = "category-cell";
      tdPseudo.textContent = pseudo + (isMe ? " (toi)" : "");
      tr.appendChild(tdPseudo);

      for (const category of currentCategories) {
        const td = document.createElement("td");
        td.dataset.pseudo = pseudo;
        td.dataset.category = category;
        // Pour le layout mobile (cartes) : on a besoin de connaitre le nom
        // de la categorie sans relire le header.
        td.dataset.label = category;
        renderCell(td, pseudo, category);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    tableEl.appendChild(tbody);
  }

  function renderCell(td, pseudo, category) {
    td.innerHTML = "";
    const answer = currentAnswers[pseudo]?.[category] ?? "";
    const wrap = document.createElement("div");
    wrap.className = "validation-cell";

    const text = document.createElement("span");
    text.className = "answer-text";

    const lengthConstraint = state.config?.lengthConstraint ?? null;
    const goodLetter = answerMatchesLetter(answer, currentLetter);
    const goodLength = answerMatchesLength(answer, lengthConstraint);
    // Une cellule est votable uniquement si elle est syntaxiquement valide :
    // non-vide + bonne lettre + respecte la contrainte de longueur.
    const isValid = answer.trim().length > 0 && goodLetter && goodLength;

    if (!answer.trim()) {
      text.textContent = "— vide —";
      text.classList.add("answer-empty");
    } else if (!goodLetter) {
      text.textContent = answer;
      text.classList.add("answer-bad-letter");
      text.title = `Ne commence pas par ${currentLetter}`;
    } else if (!goodLength) {
      // Cellule rejetee a cause de la contrainte de longueur : meme rendu
      // qu'une mauvaise lettre, juste un tooltip qui explique la raison.
      text.textContent = answer;
      text.classList.add("answer-bad-length");
      const desc = describeLengthConstraint(lengthConstraint);
      text.title = desc ? `Hors limite : ${desc}` : "Hors limite";
    } else {
      text.textContent = answer;
    }
    wrap.appendChild(text);

    if (isValid) {
      // Cellule valide : 3 boutons collaboratifs
      const currentState = currentCellStates[pseudo]?.[category] ?? "unique";
      const btnGroup = document.createElement("span");
      btnGroup.className = "vote-buttons";

      const uniqueBtn = document.createElement("button");
      uniqueBtn.type = "button";
      uniqueBtn.className = "vote-btn unique";
      uniqueBtn.textContent = "✓";
      uniqueBtn.title = "OK unique : réponse correcte, pas de doublon";
      if (currentState === "unique") uniqueBtn.classList.add("active");
      uniqueBtn.addEventListener("click", () => {
        conn.send({ type: "set_cell_state", targetPseudo: pseudo, category, state: "unique" });
      });

      const dupBtn = document.createElement("button");
      dupBtn.type = "button";
      dupBtn.className = "vote-btn duplicate";
      dupBtn.textContent = "≈";
      dupBtn.title = "OK doublon : réponse correcte mais quelqu'un a dit pareil (même avec faute)";
      if (currentState === "duplicate") dupBtn.classList.add("active");
      dupBtn.addEventListener("click", () => {
        conn.send({ type: "set_cell_state", targetPseudo: pseudo, category, state: "duplicate" });
      });

      const rejBtn = document.createElement("button");
      rejBtn.type = "button";
      rejBtn.className = "vote-btn reject";
      rejBtn.textContent = "✗";
      rejBtn.title = "Refuser cette réponse";
      if (currentState === "reject") rejBtn.classList.add("active");
      rejBtn.addEventListener("click", () => {
        conn.send({ type: "set_cell_state", targetPseudo: pseudo, category, state: "reject" });
      });

      btnGroup.appendChild(uniqueBtn);
      btnGroup.appendChild(dupBtn);
      btnGroup.appendChild(rejBtn);
      wrap.appendChild(btnGroup);
    }
    // Si la cellule est invalide (vide / mauvaise lettre), pas de boutons :
    // c'est forcement "reject" et on ne peut pas le changer.

    td.appendChild(wrap);
  }

  function refreshAllCells() {
    const cells = tableEl.querySelectorAll("tbody td[data-pseudo]");
    cells.forEach((td) => {
      const pseudo = td.dataset.pseudo;
      const category = td.dataset.category;
      renderCell(td, pseudo, category);
    });
  }

  function updateHostActions() {
    if (state.isHost) {
      hostActionsEl.style.display = "block";
      waitingEl.style.display = "none";
    } else {
      hostActionsEl.style.display = "none";
      waitingEl.style.display = "block";
    }
  }

  /**
   * Affiche / met a jour le panneau de "malus tricheur".
   *
   * Visible uniquement si :
   *   - la manche s'est terminee par STOP (stoppedBy != null)
   *   - le malus par cellule est configure (!= 0)
   *
   * Le compteur est partage collaborativement. Boutons - / + envoient
   * set_cheater_cheats au serveur, qui clamp + diffuse.
   */
  function renderCheaterPanel() {
    if (!cheaterPanelEl) return;
    const shouldShow = cheaterStoppedBy && cheaterPenaltyPerCheat < 0;
    if (!shouldShow) {
      cheaterPanelEl.style.display = "none";
      return;
    }
    cheaterPanelEl.style.display = "flex";
    cheaterStopperEl.textContent = cheaterStoppedBy;
    cheaterCountEl.textContent = String(cheaterCount);
    cheaterDecBtn.disabled = cheaterCount <= 0;
    cheaterIncBtn.disabled = cheaterCount >= currentCategories.length;
    // Apercu du malus total qui sera applique
    const totalMalus = cheaterCount * cheaterPenaltyPerCheat;
    if (totalMalus === 0) {
      cheaterResultEl.textContent = "";
    } else {
      cheaterResultEl.textContent = `Malus actuel : ${totalMalus} pts (${cheaterCount} × ${cheaterPenaltyPerCheat})`;
    }
  }

  if (cheaterDecBtn) {
    cheaterDecBtn.addEventListener("click", () => {
      const next = Math.max(0, cheaterCount - 1);
      if (next === cheaterCount) return;
      conn.send({ type: "set_cheater_cheats", count: next });
    });
  }
  if (cheaterIncBtn) {
    cheaterIncBtn.addEventListener("click", () => {
      const next = Math.min(currentCategories.length, cheaterCount + 1);
      if (next === cheaterCount) return;
      conn.send({ type: "set_cheater_cheats", count: next });
    });
  }

  finishBtn.addEventListener("click", () => {
    conn.send({ type: "next_round" });
  });

  endGameBtn.addEventListener("click", () => {
    if (
      confirm(
        "Es-tu sûr(e) ? Cela mettra fin à la partie immediatement, sans calculer les scores de cette manche."
      )
    ) {
      conn.send({ type: "end_game" });
    }
  });
}

/**
 * Vue "scoring" : affichage des scores de la manche + classement cumule.
 *
 * Tableau inverse comme view-validating : lignes = joueurs, colonnes = categories.
 * Couleurs des cellules selon le type de score (alone/unique/duplicate/invalid).
 *
 * Boutons host :
 *   - "Manche suivante" (ou "Voir le classement final" sur la derniere manche)
 *   - "Terminer la partie maintenant" (avec confirmation)
 */

export function initScoringView(state, conn) {
  const tableEl = document.getElementById("round-scores-table");
  const rankingEl = document.getElementById("cumulative-ranking");
  const roundNumberEl = document.getElementById("sc-round-number");
  const roundTotalEl = document.getElementById("sc-round-total");
  const letterValueEl = document.getElementById("sc-letter-value");
  const hostActionsEl = document.getElementById("scoring-host-actions");
  const waitingEl = document.getElementById("scoring-waiting");
  const nextBtn = document.getElementById("btn-next-round");
  const endGameBtn = document.getElementById("btn-end-game-scoring");

  // On garde en cache pour pouvoir mettre a jour le bouton "next" si l'etat host change
  let lastTotalRounds = 0;
  let lastResult = null;

  state.renderScoring = function (msg) {
    const result = msg.result;
    const players = msg.players;
    lastResult = result;
    lastTotalRounds = msg.totalRounds ?? state.config?.totalRounds ?? 0;

    roundNumberEl.textContent = result.roundNumber;
    if (lastTotalRounds > 0) {
      roundTotalEl.textContent = `/ ${lastTotalRounds}`;
    } else {
      roundTotalEl.textContent = "";
    }
    letterValueEl.textContent = result.letter;

    const categories = msg.categories ?? state.config?.categories ?? [];
    const pseudos = Object.keys(result.scoreByPlayer);
    const scoring = state.config?.scoring ?? {
      aloneInCategory: 15,
      uniqueAnswer: 10,
      duplicateAnswer: 5,
      invalidOrEmpty: 0,
    };

    // === Tableau scores manche : lignes = joueurs, colonnes = categories ===
    tableEl.innerHTML = "";

    // Nettoie l'ancienne note de malus tricheur si elle existait (re-render scoring)
    const existingNote = tableEl.parentElement?.querySelector(".cheater-applied-note");
    if (existingNote) existingNote.remove();

    const thead = document.createElement("thead");
    const trHead = document.createElement("tr");
    const thPseudo = document.createElement("th");
    thPseudo.className = "col-category";
    thPseudo.textContent = "Joueur";
    trHead.appendChild(thPseudo);
    for (const category of categories) {
      const th = document.createElement("th");
      th.textContent = category;
      trHead.appendChild(th);
    }
    const thTotal = document.createElement("th");
    thTotal.textContent = "Total";
    trHead.appendChild(thTotal);
    thead.appendChild(trHead);
    tableEl.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const pseudo of pseudos) {
      const tr = document.createElement("tr");
      tr.dataset.pseudo = pseudo;
      const isMe = pseudo === state.myPseudo;
      if (isMe) tr.classList.add("is-self");
      const tdPseudo = document.createElement("td");
      tdPseudo.className = "col-category";
      tdPseudo.textContent = pseudo + (isMe ? " (toi)" : "");
      tr.appendChild(tdPseudo);

      for (const category of categories) {
        const td = document.createElement("td");
        td.dataset.label = category;
        const score = result.cellScores[pseudo]?.[category] ?? 0;
        const answer = result.answers[pseudo]?.[category] ?? "";
        td.classList.add("score-cell");
        if (score === scoring.aloneInCategory && answer.trim()) {
          td.classList.add("alone");
        } else if (score === scoring.uniqueAnswer && answer.trim()) {
          td.classList.add("unique");
        } else if (score === scoring.duplicateAnswer && answer.trim()) {
          td.classList.add("duplicate");
        } else {
          td.classList.add("invalid");
        }
        const scoreEl = document.createElement("div");
        scoreEl.className = "score-cell-points";
        scoreEl.textContent = score;
        const answerEl = document.createElement("div");
        answerEl.className = "score-cell-answer";
        answerEl.textContent = answer.trim() ? answer : "—";
        td.appendChild(scoreEl);
        td.appendChild(answerEl);
        tr.appendChild(td);
      }

      // Cellule total ligne
      const tdTotal = document.createElement("td");
      tdTotal.className = "score-total-cell";
      tdTotal.dataset.label = "Total";
      const totalScore = result.scoreByPlayer[pseudo] ?? 0;
      // Si ce joueur est le stoppeur et qu'un malus tricheur a ete applique,
      // on affiche le detail "raw - malus = total" pour la transparence.
      const isStopper = result.stoppedBy === pseudo;
      const penalty = result.cheaterPenalty ?? 0;
      if (isStopper && penalty < 0) {
        const raw = totalScore - penalty; // penalty etant <= 0, raw = totalScore + |penalty|
        const totalMain = document.createElement("div");
        totalMain.className = "score-total-main";
        totalMain.textContent = totalScore;
        const totalDetail = document.createElement("div");
        totalDetail.className = "score-total-breakdown";
        // ex: "30 - 10 = 20" (raw, |penalty|, totalScore)
        totalDetail.textContent = `${raw} − ${Math.abs(penalty)}`;
        totalDetail.title = "Malus tricheur appliqué pour avoir stoppé la manche avec des réponses tricheuses";
        tdTotal.appendChild(totalMain);
        tdTotal.appendChild(totalDetail);
        tr.classList.add("has-cheater-penalty");
      } else {
        tdTotal.textContent = totalScore;
      }
      tr.appendChild(tdTotal);

      tbody.appendChild(tr);
    }
    tableEl.appendChild(tbody);

    // === Bandeau d'explication du malus tricheur (si applique) ===
    if (result.stoppedBy && (result.cheaterPenalty ?? 0) < 0) {
      const cheaterNote = document.createElement("p");
      cheaterNote.className = "cheater-applied-note";
      const cheats = result.cheaterCheats ?? 0;
      const perCheat = state.config?.scoring?.cheaterPenaltyPerCheat ?? 0;
      cheaterNote.textContent = `⚠️ Malus tricheur appliqué à ${result.stoppedBy} : ${cheats} catégorie(s) × ${perCheat} = ${result.cheaterPenalty} pts`;
      tableEl.parentElement.insertBefore(cheaterNote, tableEl.nextSibling);
    }

    // === Classement cumule ===
    rankingEl.innerHTML = "";
    const sorted = [...players].sort((a, b) => b.totalScore - a.totalScore);
    for (const p of sorted) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "rank-pseudo";
      name.textContent = p.pseudo;
      const score = document.createElement("span");
      score.className = "rank-score";
      score.textContent = `${p.totalScore} pts`;
      li.appendChild(name);
      li.appendChild(score);
      rankingEl.appendChild(li);
    }

    updateHostActions();
  };

  state.refreshScoringHostState = function () {
    updateHostActions();
  };

  function updateHostActions() {
    if (state.isHost) {
      hostActionsEl.style.display = "block";
      waitingEl.style.display = "none";
      // Adapter le label selon manche restante
      if (lastTotalRounds > 0 && state.currentRound >= lastTotalRounds) {
        nextBtn.textContent = "Voir le classement final →";
      } else {
        nextBtn.textContent = "Manche suivante →";
      }
    } else {
      hostActionsEl.style.display = "none";
      waitingEl.style.display = "block";
    }
  }

  nextBtn.addEventListener("click", () => {
    conn.send({ type: "next_round" });
  });

  endGameBtn.addEventListener("click", () => {
    if (confirm("Es-tu sûr(e) ? Cela mettra fin à la partie maintenant et passera directement au classement final.")) {
      conn.send({ type: "end_game" });
    }
  });
}

/**
 * Vue "scoring" — Definitions.
 * Affiche, par auteur : sa définition, la note moyenne agrégée (badge coloré)
 * et les points de la manche. Puis le classement cumulé.
 */

import { formatAggregate, voteColor, renderRealDefs } from "./constants.js";

export function initScoringView(state, conn) {
  const roundNumberEl = document.getElementById("sc-round-number");
  const roundTotalEl = document.getElementById("sc-round-total");
  const wordEl = document.getElementById("sc-word");
  const realDefEl = document.getElementById("sc-real-def");
  const tableEl = document.getElementById("round-scores-table");
  const rankingEl = document.getElementById("cumulative-ranking");
  const hostActionsEl = document.getElementById("scoring-host-actions");
  const waitingEl = document.getElementById("scoring-waiting");
  const nextBtn = document.getElementById("btn-next-round");
  const endGameBtn = document.getElementById("btn-end-game-scoring");

  let lastResult = null;

  state.renderScoring = function (msg) {
    const result = msg.result;
    lastResult = result;
    if (msg.players) state.players = msg.players;

    roundNumberEl.textContent = result.roundNumber;
    const total = msg.totalRounds ?? state.config?.totalRounds ?? 0;
    roundTotalEl.textContent = total > 0 ? `/ ${total}` : "";
    wordEl.textContent = result.word ?? "";
    const realDefs = result.realDefinitions ??
      (result.realDefinition ? [result.realDefinition] : []);
    renderRealDefs(realDefEl, realDefs);

    renderRoundTable(result);
    renderRanking();
    updateHostActions();
  };

  state.refreshScoringHostState = function () {
    updateHostActions();
  };
  state.refreshScoringTable = function () {
    if (lastResult) {
      renderRoundTable(lastResult);
      renderRanking();
    }
  };

  function renderRoundTable(result) {
    tableEl.innerHTML = "";
    const definitions = result.definitions ?? {};
    const agg = result.aggregateByAuthor ?? {};
    const scores = result.scoreByPlayer ?? {};
    const authors = Object.keys(definitions).sort(
      (a, b) => (scores[b] ?? 0) - (scores[a] ?? 0)
    );

    const thead = document.createElement("thead");
    const trHead = document.createElement("tr");
    for (const h of ["Joueur", "Sa définition", "Note moy.", "Points"]) {
      const th = document.createElement("th");
      th.textContent = h;
      trHead.appendChild(th);
    }
    thead.appendChild(trHead);
    tableEl.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const author of authors) {
      const tr = document.createElement("tr");
      tr.className = "def-score-line";
      if (author === state.myPseudo) tr.classList.add("is-self");

      const tdName = document.createElement("td");
      tdName.textContent = author + (author === state.myPseudo ? " (toi)" : "");
      tr.appendChild(tdName);

      const tdDef = document.createElement("td");
      const defText = (definitions[author] ?? "").trim();
      const defSpan = document.createElement("span");
      defSpan.className = "def-text";
      defSpan.textContent = defText.length > 0 ? defText : "(pas de définition)";
      if (defText.length === 0) defSpan.style.fontStyle = "italic";
      tdDef.appendChild(defSpan);
      tr.appendChild(tdDef);

      const tdAgg = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = "agg-badge";
      const a = agg[author] ?? 0;
      badge.textContent = formatAggregate(a);
      badge.style.background = voteColor(a);
      tdAgg.appendChild(badge);
      tr.appendChild(tdAgg);

      const tdPts = document.createElement("td");
      tdPts.innerHTML = `<strong>${scores[author] ?? 0}</strong>`;
      tr.appendChild(tdPts);

      tbody.appendChild(tr);
    }
    tableEl.appendChild(tbody);
  }

  function renderRanking() {
    rankingEl.innerHTML = "";
    const sorted = [...state.players].sort((a, b) => b.totalScore - a.totalScore);
    for (const p of sorted) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "rank-pseudo";
      name.textContent = p.pseudo + (p.pseudo === state.myPseudo ? " (toi)" : "");
      const score = document.createElement("span");
      score.className = "rank-score";
      score.textContent = `${p.totalScore} pts`;
      li.appendChild(name);
      li.appendChild(score);
      rankingEl.appendChild(li);
    }
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

  nextBtn.addEventListener("click", () => conn.send({ type: "next_round" }));
  endGameBtn.addEventListener("click", () => {
    if (confirm("Terminer la partie maintenant ?")) {
      conn.send({ type: "end_game" });
    }
  });
}

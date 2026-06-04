/**
 * Vue "voting" — Definitions.
 *
 * Matrice N×N :
 *   - LIGNES   = auteurs (pseudo + leur définition proposée)
 *   - COLONNES = votants
 *   - cellule (auteur, votant) = la note que `votant` a donnée à `auteur`
 *   - diagonale (auteur == votant) : barrée (on ne se note pas soi-même)
 *   - MA colonne est éditable (5 boutons 0 ¼ ½ ¾ 1) ; les autres colonnes sont
 *     en lecture seule mais se mettent à jour en direct.
 *
 * La vraie définition (révélée) est affichée au-dessus comme référence.
 */

import { VOTE_VALUES, VOTE_LABELS, voteColor, formatVote } from "./constants.js";

export function initVotingView(state, conn) {
  const roundNumberEl = document.getElementById("vo-round-number");
  const roundTotalEl = document.getElementById("vo-round-total");
  const reasonEl = document.getElementById("vo-end-reason");
  const wordEl = document.getElementById("vo-word");
  const realDefEl = document.getElementById("vo-real-def");
  const tableEl = document.getElementById("vote-matrix");
  const progressEl = document.getElementById("vote-progress");
  const hostActionsEl = document.getElementById("voting-host-actions");
  const waitingEl = document.getElementById("voting-waiting");
  const finishBtn = document.getElementById("btn-finish-voting");
  const endGameBtn = document.getElementById("btn-end-game-voting");

  let authors = [];          // pseudos (lignes ET colonnes)
  let definitions = {};       // author -> texte
  let votes = {};             // voter -> author -> valeur

  state.renderVotingStart = function (msg) {
    const result = msg.result;
    definitions = result.definitions ?? {};
    votes = result.votes ?? {};
    authors = Object.keys(definitions);

    roundNumberEl.textContent = result.roundNumber;
    const total = msg.totalRounds ?? state.config?.totalRounds ?? 0;
    roundTotalEl.textContent = total > 0 ? `/ ${total}` : "";
    reasonEl.textContent = msg.reason === "timer" ? "⏱️ Temps écoulé" : "✅ Tous ont validé";
    wordEl.textContent = result.word ?? msg.word ?? "";
    realDefEl.textContent = result.realDefinition ?? msg.realDefinition ?? "";

    renderTable();
    renderProgress();
    updateHostActions();
  };

  state.applyVoteUpdate = function (newVotes) {
    votes = newVotes ?? {};
    refreshAllCells();
    renderProgress();
  };

  state.refreshVotingHostState = function () {
    updateHostActions();
  };

  // Retire les joueurs disparus (kick / déconnexion définitive)
  state.refreshVotingTable = function () {
    if (!Array.isArray(state.players)) return;
    const stillHere = new Set(state.players.map((p) => p.pseudo));
    const filtered = authors.filter((a) => stillHere.has(a));
    if (filtered.length === authors.length) return;
    authors = filtered;
    for (const a of Object.keys(definitions)) {
      if (!stillHere.has(a)) delete definitions[a];
    }
    renderTable();
    renderProgress();
    updateHostActions();
  };

  function renderTable() {
    tableEl.innerHTML = "";
    if (authors.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.textContent = "Aucune proposition à afficher.";
      td.style.padding = "20px";
      td.style.textAlign = "center";
      td.style.fontStyle = "italic";
      tr.appendChild(td);
      tableEl.appendChild(tr);
      return;
    }

    // En-tête : colonne "auteur" + une colonne par votant
    const thead = document.createElement("thead");
    const trHead = document.createElement("tr");
    const thCorner = document.createElement("th");
    thCorner.className = "col-author";
    thCorner.textContent = "Définition de ↓ / Vote de →";
    trHead.appendChild(thCorner);
    for (const voter of authors) {
      const th = document.createElement("th");
      th.textContent = voter + (voter === state.myPseudo ? " (toi)" : "");
      if (voter === state.myPseudo) th.classList.add("voter-me");
      trHead.appendChild(th);
    }
    thead.appendChild(trHead);
    tableEl.appendChild(thead);

    // Corps : une ligne par auteur
    const tbody = document.createElement("tbody");
    for (const author of authors) {
      const tr = document.createElement("tr");
      tr.dataset.author = author;
      if (author === state.myPseudo) tr.classList.add("is-self");

      const tdAuthor = document.createElement("td");
      tdAuthor.className = "author-cell";
      const name = document.createElement("span");
      name.className = "author-name";
      name.textContent = author + (author === state.myPseudo ? " (toi)" : "");
      tdAuthor.appendChild(name);
      const def = document.createElement("span");
      def.className = "author-def";
      const text = (definitions[author] ?? "").trim();
      if (text.length === 0) {
        def.textContent = "(pas de définition)";
        def.classList.add("empty");
      } else {
        def.textContent = text;
      }
      tdAuthor.appendChild(def);
      tr.appendChild(tdAuthor);

      for (const voter of authors) {
        const td = document.createElement("td");
        td.className = "vote-cell";
        td.dataset.author = author;
        td.dataset.voter = voter;
        renderCell(td, author, voter);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    tableEl.appendChild(tbody);
  }

  function renderCell(td, author, voter) {
    td.innerHTML = "";
    td.classList.remove("diagonal", "editable");

    // Diagonale : on ne vote pas pour soi-même
    if (author === voter) {
      td.classList.add("diagonal");
      td.title = "Pas d'auto-vote";
      return;
    }

    const current = votes[voter]?.[author];

    if (voter === state.myPseudo) {
      // Cellule éditable : 5 mini-boutons
      td.classList.add("editable");
      const group = document.createElement("div");
      group.className = "rating-group";
      for (const v of VOTE_VALUES) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "rating-btn";
        btn.textContent = VOTE_LABELS[v];
        btn.title = `Note ${v}`;
        if (current !== undefined && Math.abs(current - v) < 1e-9) {
          btn.classList.add("active");
        }
        btn.addEventListener("click", () => {
          conn.send({ type: "set_vote", author, value: v });
        });
        group.appendChild(btn);
      }
      td.appendChild(group);
      return;
    }

    // Cellule lecture seule : la note d'un autre votant
    const pill = document.createElement("span");
    pill.className = "vote-readonly";
    if (current === undefined) {
      pill.classList.add("pending");
      pill.textContent = "·";
      pill.title = "Pas encore voté";
    } else {
      pill.textContent = formatVote(current);
      pill.style.background = voteColor(current);
      pill.title = `Note : ${current}`;
    }
    td.appendChild(pill);
  }

  function refreshAllCells() {
    const cells = tableEl.querySelectorAll("tbody td.vote-cell");
    cells.forEach((td) => renderCell(td, td.dataset.author, td.dataset.voter));
  }

  function renderProgress() {
    const others = authors.filter((a) => a !== state.myPseudo);
    const myVotes = others.filter(
      (a) => votes[state.myPseudo]?.[a] !== undefined
    ).length;

    // Total global de votes exprimés vs attendus (N×(N-1))
    let cast = 0;
    for (const voter of authors) {
      for (const author of authors) {
        if (voter === author) continue;
        if (votes[voter]?.[author] !== undefined) cast++;
      }
    }
    const expected = authors.length * (authors.length - 1);

    const mine = others.length > 0
      ? `Tes votes : ${myVotes} / ${others.length}`
      : "Aucun adversaire à noter.";
    progressEl.textContent = `${mine} — Total exprimé : ${cast} / ${expected}`;
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

  finishBtn.addEventListener("click", () => {
    conn.send({ type: "next_round" });
  });
  endGameBtn.addEventListener("click", () => {
    if (confirm("Terminer la partie maintenant, sans calculer les scores de cette manche ?")) {
      conn.send({ type: "end_game" });
    }
  });
}

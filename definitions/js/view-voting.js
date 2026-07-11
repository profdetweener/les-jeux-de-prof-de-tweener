/**
 * Vue "voting", Definitions.
 *
 * Matrice N×N :
 *   - LIGNES   = auteurs (pseudo + leur définition proposée)
 *   - COLONNES = votants
 *   - cellule (auteur, votant) = la note que `votant` a donnée à `auteur`
 *   - diagonale (auteur == votant) : grisée (on ne se note pas soi-même)
 *   - MA colonne est éditable (slider 0..1) ; les autres colonnes sont
 *     en lecture seule mais se mettent à jour en direct.
 *   - Le vote se lit a la COULEUR de la cellule (pastel rouge -> vert).
 *
 * La vraie définition (révélée) est affichée au-dessus comme référence.
 */

import { VOTE_STEP, voteCellBg, renderRealDefs } from "./constants.js";

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

  // --- Mode "correction des votes" par l'hote -----------------------------
  // Quand actif, l'hote peut editer les cellules d'autres votants. Sert
  // surtout aux parties a 3 joueurs face a un saboteur (la methode MAD
  // anti-saboteur necessite >=4 votes par auteur pour fonctionner).
  let overrideMode = false;
  // Cellules deja corrigees par l'hote dans cette manche (cle "voter::author").
  // Sert juste a afficher un petit marqueur visuel.
  const overriddenCells = new Set();

  // Toolbar qu'on insere au-dessus de la matrice (host only).
  // Injectee paresseusement la 1ere fois qu'on rend la table.
  let toolbarEl = null;
  function ensureToolbar() {
    if (toolbarEl) return toolbarEl;
    toolbarEl = document.createElement("div");
    toolbarEl.className = "host-override-toolbar";
    toolbarEl.innerHTML = `
      <div class="host-override-toolbar-label">
        <strong>✏️ Mode correction</strong> : utile face à un saboteur.
        Active pour corriger le vote d'un autre joueur.
      </div>
      <button type="button" class="host-override-toggle">Activer</button>
    `;
    const btn = toolbarEl.querySelector(".host-override-toggle");
    btn.addEventListener("click", () => {
      overrideMode = !overrideMode;
      toolbarEl.classList.toggle("is-active", overrideMode);
      btn.textContent = overrideMode ? "Désactiver" : "Activer";
      refreshAllCells();
    });
    // Insertion juste avant la table
    tableEl.parentNode.insertBefore(toolbarEl, tableEl);
    return toolbarEl;
  }

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
    // realDefinitions est un tableau (1 a 3 sens). Compat retro : si seul
    // realDefinition (string) est present, on l'enveloppe.
    const realDefs =
      result.realDefinitions ??
      msg.realDefinitions ??
      (result.realDefinition ? [result.realDefinition] : []) ??
      (msg.realDefinition ? [msg.realDefinition] : []) ??
      [];
    renderRealDefs(realDefEl, realDefs);

    renderTable();
    renderProgress();
    updateHostActions();
    autoVoteEmptyDefinitions();
    // Reset override state pour la nouvelle manche
    overrideMode = false;
    overriddenCells.clear();
    if (state.isHost) {
      ensureToolbar();
      toolbarEl.style.display = "";
      toolbarEl.classList.remove("is-active");
      const btn = toolbarEl.querySelector(".host-override-toggle");
      if (btn) btn.textContent = "Activer";
    } else if (toolbarEl) {
      toolbarEl.style.display = "none";
    }
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

  function voterOrder() {
    // MON pseudo en premier (apres la colonne auteur) -> colonne sticky a gauche.
    // Sinon ordre alphabetique d'authors original.
    const me = state.myPseudo;
    const others = authors.filter((a) => a !== me);
    return authors.includes(me) ? [me, ...others] : authors.slice();
  }

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

    const voters = voterOrder();

    // En-tête : colonne "auteur" + une colonne par votant
    const thead = document.createElement("thead");
    const trHead = document.createElement("tr");
    const thCorner = document.createElement("th");
    thCorner.className = "col-author";
    thCorner.textContent = "Définition de ↓ / Vote de →";
    trHead.appendChild(thCorner);
    for (const voter of voters) {
      const th = document.createElement("th");
      th.textContent = voter === state.myPseudo ? "Toi" : voter;
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
      name.textContent = author === state.myPseudo ? "Toi" : author;
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

      for (const voter of voters) {
        const td = document.createElement("td");
        td.className = "vote-cell";
        if (voter === state.myPseudo) td.classList.add("col-me");
        td.dataset.author = author;
        td.dataset.voter = voter;
        renderCell(td, author, voter);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    tableEl.appendChild(tbody);
  }

  /**
   * Une definition vide ne merite aucun point : on emet automatiquement un
   * vote a 0 pour ces auteurs, plutot que d'obliger chaque joueur a deplacer
   * un curseur pour rien. La cellule reste modifiable (l'hote peut corriger).
   *
   * On n'emet que pour SA PROPRE ligne, et seulement si le vote n'existe pas
   * deja, pour ne pas ecraser un vote deja exprime ni voter a la place d'autrui.
   */
  function autoVoteEmptyDefinitions() {
    const me = state.myPseudo;
    if (!me) return;
    for (const author of authors) {
      if (author === me) continue;                       // pas d'auto-vote
      const text = (definitions[author] ?? "").trim();
      if (text.length > 0) continue;                     // definition presente
      if (votes[me]?.[author] !== undefined) continue;   // deja vote
      conn.send({ type: "set_vote", author, value: 0 });
    }
  }

  function renderCell(td, author, voter) {
    td.innerHTML = "";
    td.classList.remove("diagonal", "editable", "has-vote", "pending", "is-overridden");
    td.style.background = "";

    // Diagonale : on ne vote pas pour soi-même
    if (author === voter) {
      td.classList.add("diagonal");
      td.title = "Pas d'auto-vote";
      return;
    }

    const current = votes[voter]?.[author];
    const hasVote = current !== undefined;

    // L'hote en mode override peut editer toute cellule non diagonale.
    // Sinon, on n'edite que sa propre ligne (voter === myPseudo).
    const isMyRow = voter === state.myPseudo;
    const isHostOverride = state.isHost && overrideMode && !isMyRow;
    const editable = isMyRow || isHostOverride;

    const cellKey = `${voter}::${author}`;
    if (overriddenCells.has(cellKey) && hasVote) {
      td.classList.add("is-overridden");
    }

    if (editable) {
      td.classList.add("editable");
      if (isHostOverride) td.classList.add("editable-host");
      if (hasVote) {
        td.classList.add("has-vote");
        td.style.background = voteCellBg(current);
      }

      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "0";
      slider.max = "1";
      slider.step = String(VOTE_STEP);
      slider.value = hasVote ? String(current) : "0.5";
      slider.className = "vote-slider";
      if (!hasVote) slider.classList.add("vote-slider-pristine");
      slider.setAttribute("aria-label",
        isHostOverride
          ? `Corriger le vote de ${voter} pour ${author}`
          : `Note pour ${author}`
      );

      slider.addEventListener("input", () => {
        const v = Math.max(0, Math.min(1, Number(slider.value)));
        td.classList.add("has-vote");
        td.classList.remove("pending");
        slider.classList.remove("vote-slider-pristine");
        td.style.background = voteCellBg(v);
      });
      slider.addEventListener("change", () => {
        const v = Math.max(0, Math.min(1, Number(slider.value)));
        const rounded = Math.round(v * 100) / 100;
        if (isHostOverride) {
          // L'hote corrige le vote d'un autre votant
          overriddenCells.add(cellKey);
          td.classList.add("is-overridden");
          conn.send({
            type: "host_override_vote",
            voter, author, value: rounded,
          });
        } else {
          conn.send({ type: "set_vote", author, value: rounded });
        }
      });
      td.appendChild(slider);
      return;
    }

    // Cellule lecture seule
    if (hasVote) {
      td.classList.add("has-vote");
      td.style.background = voteCellBg(current);
      td.title = `Note : ${Math.round(current * 100)} %`;
    } else {
      td.classList.add("pending");
      td.title = "Pas encore voté";
    }
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
    progressEl.textContent = `${mine}, Total exprimé : ${cast} / ${expected}`;
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

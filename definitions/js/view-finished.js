/**
 * Vue "finished", Definitions.
 * Classement final, statistiques detaillees, bouton "retour au lobby" (hote).
 *
 * Les stats arrivent dans le message `game_finished` (champ `stats`). Elles sont
 * facultatives : un serveur plus ancien n'en envoie pas, on masque alors le bloc.
 */

export function initFinishedView(state, conn) {
  const titleEl = document.querySelector("#view-finished h2");
  const rankingEl = document.getElementById("final-ranking");
  const hostActionsEl = document.getElementById("finished-host-actions");
  const backBtn = document.getElementById("btn-back-lobby");

  const statsBlock = document.getElementById("final-stats");
  const statsBody = document.getElementById("final-stats-body");
  const statsToggle = document.getElementById("btn-toggle-stats");
  const highlightsEl = document.getElementById("stats-highlights");
  const tableEl = document.getElementById("stats-table");
  const legendEl = document.getElementById("stats-legend");

  /** Note interne (0 a 1) -> pourcentage lisible. */
  const pct = (v) => `${Math.round(v * 100)} %`;

  state.renderFinished = function (ranking, stats) {
    rankingEl.innerHTML = "";
    const isChill = state.config?.mode === "chill";
    if (titleEl) {
      titleEl.textContent = isChill ? "Fin de la session" : "🏆 Fin de la partie !";
    }
    const sorted = [...(ranking ?? [])].sort((a, b) => b.totalScore - a.totalScore);
    sorted.forEach((p) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "rank-pseudo";
      name.textContent = p.pseudo === state.myPseudo ? "Toi" : p.pseudo;
      const score = document.createElement("span");
      score.className = "rank-score";
      score.textContent = `${p.totalScore} pts`;
      li.appendChild(name);
      li.appendChild(score);
      rankingEl.appendChild(li);
    });

    renderStats(stats);
    updateHostActions();
  };

  state.refreshFinishedHostState = function () {
    updateHostActions();
  };

  function updateHostActions() {
    hostActionsEl.style.display = state.isHost ? "block" : "none";
  }

  // -------------------------------------------------------------------------
  // Statistiques
  // -------------------------------------------------------------------------

  function renderStats(stats) {
    if (!statsBlock) return;
    // Pas de stats (vieux serveur) ou aucune manche scoree : rien a montrer.
    if (!stats || !Array.isArray(stats.players) || stats.roundsPlayed === 0) {
      statsBlock.style.display = "none";
      return;
    }
    statsBlock.style.display = "block";
    statsBody.style.display = "none";
    statsToggle.textContent = "📊 Voir les stats détaillées";

    renderHighlights(stats);
    renderTable(stats);

    legendEl.textContent =
      `Moyenne des notes attribuées, tous joueurs confondus : ${pct(stats.averageVoteOverall)}. ` +
      `Un joueur qui donne nettement moins est un juge sévère ; nettement plus, un juge généreux.`;
  }

  /** Petites lignes narratives. Chaque item n'est affiche que s'il a du sens. */
  function renderHighlights(stats) {
    const players = stats.players;
    const items = [];
    const nameOf = (p) => (p.pseudo === state.myPseudo ? "Toi" : p.pseudo);

    // Regularite : meilleure moyenne par manche. Plus parlant que le total quand
    // un joueur a rejoint en cours de partie.
    const regular = maxBy(players, (p) => p.averageScore);
    if (regular && regular.averageScore > 0) {
      items.push([
        "📈 Le plus régulier",
        `<b>${esc(nameOf(regular))}</b>, ${regular.averageScore} pts par manche en moyenne`,
      ]);
    }

    // Manches remportees (meilleure definition de la manche).
    const winner = maxBy(players, (p) => p.roundWins);
    if (winner && winner.roundWins > 0) {
      items.push([
        "🥇 Meilleure définition le plus souvent",
        `<b>${esc(nameOf(winner))}</b>, ${winner.roundWins} manche(s) sur ${stats.roundsPlayed}`,
      ]);
    }

    // Meilleur coup unique.
    const peak = maxBy(players, (p) => p.bestRoundScore);
    if (peak && peak.bestRoundScore > 0) {
      items.push([
        "💥 Meilleure manche",
        `<b>${esc(nameOf(peak))}</b>, ${peak.bestRoundScore} pts en une seule manche`,
      ]);
    }

    // Severite : on ne l'annonce que si l'ecart est net (>= 10 points de %).
    const voters = players.filter((p) => p.averageGiven > 0);
    if (voters.length >= 2) {
      const strict = minBy(voters, (p) => p.averageGiven);
      const generous = maxBy(voters, (p) => p.averageGiven);
      if (generous.averageGiven - strict.averageGiven >= 0.1) {
        items.push([
          "🧊 Le juge le plus sévère",
          `<b>${esc(nameOf(strict))}</b>, ${pct(strict.averageGiven)} de note moyenne donnée`,
        ]);
        items.push([
          "☀️ Le juge le plus généreux",
          `<b>${esc(nameOf(generous))}</b>, ${pct(generous.averageGiven)} de note moyenne donnée`,
        ]);
      }
    }

    // Definitions vides : uniquement s'il y en a eu.
    const totalEmpty = players.reduce((n, p) => n + p.emptyDefinitions, 0);
    if (totalEmpty > 0) {
      const lazy = maxBy(players, (p) => p.emptyDefinitions);
      items.push([
        "🫥 Définitions laissées vides",
        `${totalEmpty} au total, dont ${lazy.emptyDefinitions} pour <b>${esc(nameOf(lazy))}</b>`,
      ]);
    }

    highlightsEl.innerHTML = items.length
      ? items
          .map(
            ([k, v]) =>
              `<div class="stat-hl"><span class="stat-hl-key">${k}</span><span class="stat-hl-val">${v}</span></div>`
          )
          .join("")
      : `<div class="stat-hl"><span class="stat-hl-val">Pas assez de manches pour dégager des tendances.</span></div>`;
  }

  function renderTable(stats) {
    const rows = [...stats.players].sort((a, b) => b.totalScore - a.totalScore);
    const head =
      "<tr>" +
      "<th>Joueur</th>" +
      '<th title="Score total">Pts</th>' +
      '<th title="Points moyens par manche jouée">Moy.</th>' +
      '<th title="Manches où sa définition a été la mieux notée">Victoires</th>' +
      '<th title="Note moyenne reçue des autres joueurs">Reçue</th>' +
      '<th title="Note moyenne attribuée aux autres">Donnée</th>' +
      '<th title="Définitions laissées vides">Vides</th>' +
      "</tr>";

    const body = rows
      .map((p) => {
        const me = p.pseudo === state.myPseudo;
        return (
          `<tr${me ? ' class="is-self"' : ""}>` +
          `<td class="stats-name">${esc(me ? "Toi" : p.pseudo)}</td>` +
          `<td class="num">${p.totalScore}</td>` +
          `<td class="num">${p.averageScore}</td>` +
          `<td class="num">${p.roundWins}</td>` +
          `<td class="num">${pct(p.averageReceived)}</td>` +
          `<td class="num">${pct(p.averageGiven)}</td>` +
          `<td class="num">${p.emptyDefinitions || "-"}</td>` +
          "</tr>"
        );
      })
      .join("");

    tableEl.innerHTML = head + body;
  }

  // -------------------------------------------------------------------------
  // Utilitaires
  // -------------------------------------------------------------------------

  function maxBy(arr, fn) {
    if (!arr.length) return null;
    return arr.reduce((best, x) => (fn(x) > fn(best) ? x : best), arr[0]);
  }
  function minBy(arr, fn) {
    if (!arr.length) return null;
    return arr.reduce((best, x) => (fn(x) < fn(best) ? x : best), arr[0]);
  }
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  if (statsToggle) {
    statsToggle.addEventListener("click", () => {
      const open = statsBody.style.display !== "none";
      statsBody.style.display = open ? "none" : "block";
      statsToggle.textContent = open
        ? "📊 Voir les stats détaillées"
        : "← Masquer les stats";
    });
  }

  backBtn.addEventListener("click", () => conn.send({ type: "back_to_lobby" }));
}

/**
 * Vue "finished" — Definitions.
 * Classement final + bouton "retour au lobby" (hôte) pour rejouer.
 */

export function initFinishedView(state, conn) {
  const rankingEl = document.getElementById("final-ranking");
  const hostActionsEl = document.getElementById("finished-host-actions");
  const backBtn = document.getElementById("btn-back-lobby");

  state.renderFinished = function (ranking) {
    rankingEl.innerHTML = "";
    const sorted = [...(ranking ?? [])].sort((a, b) => b.totalScore - a.totalScore);
    sorted.forEach((p, idx) => {
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
    });
    updateHostActions();
  };

  state.refreshFinishedHostState = function () {
    updateHostActions();
  };

  function updateHostActions() {
    hostActionsEl.style.display = state.isHost ? "block" : "none";
  }

  backBtn.addEventListener("click", () => conn.send({ type: "back_to_lobby" }));
}

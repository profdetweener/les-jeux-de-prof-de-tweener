/**
 * Vue "finished" : classement final + bouton "rejouer" (host).
 */

export function initFinishedView(state, conn) {
  const rankingEl = document.getElementById("final-ranking");
  const hostActionsEl = document.getElementById("finished-host-actions");
  const backLobbyBtn = document.getElementById("btn-back-lobby");

  state.renderFinished = function (ranking) {
    rankingEl.innerHTML = "";
    for (const p of ranking) {
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

  state.refreshFinishedHostState = function () {
    updateHostActions();
  };

  function updateHostActions() {
    hostActionsEl.style.display = state.isHost ? "block" : "none";
  }

  backLobbyBtn.addEventListener("click", () => {
    conn.send({ type: "back_to_lobby" });
  });
}

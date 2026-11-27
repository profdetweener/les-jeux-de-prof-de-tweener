/**
 * Choix du mode du Blind Test.
 *  - Tchat Twitch : le jeu historique (tchat.html), qui tourne dans la page.
 *  - Navigateur : page pseudo + lien d'invitation (join.html?create=1).
 * Si une partie navigateur est encore en cours dans ce navigateur, on
 * propose de la reprendre.
 */

const $ = (id) => document.getElementById(id);
const PSEUDO_KEY = "bt_pseudo";
const ACTIVE_KEY = "bt_active";
const ACTIVE_TTL = 6 * 60 * 60 * 1000;

function readActive() {
  try {
    const a = JSON.parse(localStorage.getItem(ACTIVE_KEY) || "null");
    if (a && a.code && a.pseudo && Date.now() - (a.ts || 0) < ACTIVE_TTL) return a;
  } catch {}
  return null;
}

const active = readActive();
if (active) {
  $("resume-banner").hidden = false;
  $("resumeText").textContent =
    `Tu as une partie de Blind Test en cours dans le navigateur (code ${active.code}, pseudo ${active.pseudo}).`;
  $("resumeBtn").onclick = () => {
    try {
      sessionStorage.setItem(PSEUDO_KEY, active.pseudo);
      localStorage.setItem(PSEUDO_KEY, active.pseudo);
    } catch {}
    location.href = `room.html?code=${encodeURIComponent(active.code)}`;
  };
  $("forgetBtn").onclick = () => {
    try { localStorage.removeItem(ACTIVE_KEY); } catch {}
    $("resume-banner").hidden = true;
  };
}

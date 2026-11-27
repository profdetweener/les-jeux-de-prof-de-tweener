/**
 * Choix du mode de Pression.
 *  - Tchat Twitch : les joueurs jouent depuis le tchat, pas de pseudo a
 *    saisir. On cree la partie et on ouvre le salon directement.
 *  - Navigateur : page pseudo + lien d'invitation (join.html?create=1).
 * Si une partie est encore en cours dans ce navigateur, on propose de la
 * reprendre.
 */

import { createRoom } from "../../shared/js/api.js";

const $ = (id) => document.getElementById(id);
const GAME = "pression";
const STREAMER = "Streamer";        // identite de l'hote d'une partie tchat
const PSEUDO_KEY = "pr_pseudo";
const ACTIVE_KEY = "pr_active";
const ACTIVE_TTL = 6 * 60 * 60 * 1000;

function readActive() {
  try {
    const a = JSON.parse(localStorage.getItem(ACTIVE_KEY) || "null");
    if (a && a.code && a.pseudo && Date.now() - (a.ts || 0) < ACTIVE_TTL) return a;
  } catch {}
  return null;
}

function open(code, pseudo) {
  try {
    sessionStorage.setItem(PSEUDO_KEY, pseudo);
    localStorage.setItem(PSEUDO_KEY, pseudo);
  } catch {}
  location.href = `room.html?code=${encodeURIComponent(code)}`;
}

let busy = false;
async function createTchat() {
  if (busy) return;
  busy = true;
  $("error-box").classList.remove("show");
  $("tchatCta").innerHTML = "Création…";
  try {
    open(await createRoom(GAME, { source: "tchat" }), STREAMER);
  } catch {
    busy = false;
    $("tchatCta").innerHTML = 'Lancer <span class="arrow">→</span>';
    $("error-box").textContent = "Impossible de créer la partie. Le serveur ne répond pas.";
    $("error-box").classList.add("show");
  }
}

$("tchatCard").addEventListener("click", (e) => { e.preventDefault(); createTchat(); });

const active = readActive();
if (active) {
  $("resume-banner").hidden = false;
  $("resumeText").textContent = active.source === "navigateur"
    ? `Tu as une partie Pression en cours dans le navigateur (code ${active.code}, pseudo ${active.pseudo}).`
    : "Tu as une partie Pression en cours via le tchat Twitch.";
  $("resumeBtn").onclick = () => open(active.code, active.pseudo);
  $("forgetBtn").onclick = () => {
    try { localStorage.removeItem(ACTIVE_KEY); } catch {}
    $("resume-banner").hidden = true;
  };
}

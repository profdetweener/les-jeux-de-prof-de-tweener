/**
 * Entree de Pression. Les joueurs jouent depuis le tchat Twitch : pas de
 * pseudo a saisir. On cree la partie et on ouvre le salon directement.
 * Si une partie est encore en cours dans ce navigateur, on propose de la
 * reprendre.
 */

import { createRoom } from "../../shared/js/api.js";

const $ = (id) => document.getElementById(id);
const GAME = "pression";
const PSEUDO = "Streamer";          // identite de l'hote aupres du serveur
const PSEUDO_KEY = "pr_pseudo";
const ACTIVE_KEY = "pr_active";
const ACTIVE_TTL = 6 * 60 * 60 * 1000;

function readActive() {
  try {
    const a = JSON.parse(localStorage.getItem(ACTIVE_KEY) || "null");
    if (a && a.code && Date.now() - (a.ts || 0) < ACTIVE_TTL) return a;
  } catch {}
  return null;
}

function open(code) {
  sessionStorage.setItem(PSEUDO_KEY, PSEUDO);
  localStorage.setItem(PSEUDO_KEY, PSEUDO);
  location.href = `room.html?code=${encodeURIComponent(code)}`;
}

async function create() {
  $("resume-banner").hidden = true;
  $("retryBtn").hidden = true;
  $("creating").hidden = false;
  $("error-box").classList.remove("show");
  try {
    open(await createRoom(GAME, {}));
  } catch {
    $("creating").hidden = true;
    $("error-box").textContent = "Impossible de créer la partie. Le serveur ne répond pas.";
    $("error-box").classList.add("show");
    $("retryBtn").hidden = false;
  }
}

$("retryBtn").onclick = create;

const active = readActive();
if (active) {
  $("resume-banner").hidden = false;
  $("resumeBtn").onclick = () => open(active.code);
  $("newBtn").onclick = () => {
    try { localStorage.removeItem(ACTIVE_KEY); } catch {}
    create();
  };
} else {
  create();
}

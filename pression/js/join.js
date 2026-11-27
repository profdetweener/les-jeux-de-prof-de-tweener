/**
 * Pression en navigateur : page pseudo.
 *  - join.html?create=1 : on choisit un pseudo et on cree la partie (hote).
 *  - join.html#ABC123   : lien d'invitation, on choisit un pseudo et on entre.
 * Meme fonctionnement que Sesame (code dans le hash, banniere de reprise).
 */

import { createRoom, roomExists, pingWorker } from "../../shared/js/api.js";

const $ = (id) => document.getElementById(id);
const GAME = "pression";
const PSEUDO_MIN = 3;
const PSEUDO_MAX = 20;
const CODE_RE = /^[A-Z0-9]{4,6}$/;
const PSEUDO_KEY = "pr_pseudo";
const NAV_PSEUDO_KEY = "pr_nav_pseudo";   // dernier pseudo saisi ici (l'hote tchat s'appelle "Streamer")
const ACTIVE_KEY = "pr_active";
const ACTIVE_TTL = 6 * 60 * 60 * 1000;

function parseInviteCode() {
  let raw = (location.hash || "").replace(/^#/, "").trim();
  if (raw.includes("=")) raw = raw.split("=").pop();
  raw = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (CODE_RE.test(raw)) return raw;
  try {
    const q = (new URLSearchParams(location.search).get("code") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (CODE_RE.test(q)) return q;
  } catch {}
  return null;
}

const inviteCode = parseInviteCode();
const isJoin = inviteCode !== null;
const isCreate = !isJoin && new URLSearchParams(location.search).get("create") === "1";

const pseudoInput = $("pseudo-input");
const btn = $("btn-action");
const btnLabel = isJoin ? "Rejoindre la partie" : "Créer la partie";

try { pseudoInput.value = localStorage.getItem(NAV_PSEUDO_KEY) || ""; } catch {}

if (isJoin) {
  $("card-title").textContent = "Rejoindre une partie";
  $("subtitle").innerHTML = `Tu es invité à rejoindre la partie <strong>${inviteCode}</strong>. Choisis ton pseudo pour entrer.`;
  btn.textContent = btnLabel;
} else if (isCreate) {
  $("card-title").textContent = "Nouvelle partie";
  $("subtitle").textContent = "Choisis ton pseudo et crée la partie. Tu enverras ensuite le lien d'invitation aux autres joueurs.";
  btn.textContent = btnLabel;
} else {
  $("pseudo-group").hidden = true;
  btn.textContent = "Aucune partie à rejoindre";
  btn.disabled = true;
}

function showError(msg) { $("error-box").textContent = msg; $("error-box").classList.add("show"); }
function clearError() { $("error-box").classList.remove("show"); $("error-box").textContent = ""; }

function readActive() {
  try {
    const a = JSON.parse(localStorage.getItem(ACTIVE_KEY) || "null");
    if (a && a.code && a.pseudo && a.source === "navigateur" && Date.now() - (a.ts || 0) < ACTIVE_TTL) return a;
  } catch {}
  return null;
}

function enter(code, pseudo) {
  try {
    sessionStorage.setItem(PSEUDO_KEY, pseudo);
    localStorage.setItem(PSEUDO_KEY, pseudo);
    localStorage.setItem(NAV_PSEUDO_KEY, pseudo);
  } catch {}
  location.href = `room.html?code=${encodeURIComponent(code)}`;
}

// Banniere "Reprendre" : partie navigateur encore ouverte, autre que celle du lien.
async function maybeResume() {
  const a = readActive();
  if (!a || (isJoin && a.code === inviteCode)) return;
  let exists = false;
  try { exists = await roomExists(GAME, a.code); } catch { return; }
  if (!exists) { try { localStorage.removeItem(ACTIVE_KEY); } catch {} return; }
  $("resume-code").textContent = a.code;
  $("resume-pseudo").textContent = a.pseudo;
  $("resume-banner").hidden = false;
  $("resumeBtn").onclick = () => enter(a.code, a.pseudo);
  $("forgetBtn").onclick = () => {
    try { localStorage.removeItem(ACTIVE_KEY); } catch {}
    $("resume-banner").hidden = true;
  };
}

(async () => {
  const ok = await pingWorker();
  $("server-status").textContent = ok ? "✓ serveur en ligne" : "✗ serveur injoignable";
  if (ok) maybeResume();
  else showError("Impossible de joindre le serveur. Vérifie ta connexion.");
})();

function checkPseudo() {
  const v = pseudoInput.value.trim();
  if (v.length < PSEUDO_MIN) return { error: `Pseudo trop court (${PSEUDO_MIN} caractères minimum).` };
  if (v.length > PSEUDO_MAX) return { error: `Pseudo trop long (${PSEUDO_MAX} caractères maximum).` };
  return { value: v };
}

async function go() {
  if (!isJoin && !isCreate) return;
  clearError();
  const p = checkPseudo();
  if (p.error) { showError(p.error); pseudoInput.focus(); return; }
  btn.disabled = true;
  btn.textContent = isJoin ? "Vérification…" : "Création…";
  try {
    if (isJoin) {
      if (!(await roomExists(GAME, inviteCode))) {
        showError("Cette partie n'existe pas (ou a expiré). Demande un nouveau lien.");
        btn.disabled = false; btn.textContent = btnLabel;
        return;
      }
      enter(inviteCode, p.value);
    } else {
      enter(await createRoom(GAME, { source: "navigateur" }), p.value);
    }
  } catch {
    showError("Impossible de joindre le serveur. Réessaie dans un instant.");
    btn.disabled = false; btn.textContent = btnLabel;
  }
}

btn.addEventListener("click", go);
pseudoInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
if (isJoin || isCreate) pseudoInput.focus();

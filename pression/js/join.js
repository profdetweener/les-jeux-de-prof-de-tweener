/**
 * Page d'entree de Pression (meme principe que Mots meles) :
 *   - lien d'invitation `index.html#ABC123` -> « Rejoindre » (spectateur)
 *   - sinon                                -> « Creer »
 */

import { createRoom, roomExists, pingWorker } from "../../shared/js/api.js";

const $ = (id) => document.getElementById(id);
const CODE_RE = /^[A-Z0-9]{4,6}$/;
const GAME = "pression";
const PSEUDO_KEY = "pr_pseudo";
const ACTIVE_KEY = "pr_active";
const ACTIVE_TTL = 6 * 60 * 60 * 1000;

const pseudoInput = $("pseudo");
const createBtn = $("createBtn");
const errorBox = $("error-box");

function parseInviteCode() {
  let raw = (location.hash || "").replace(/^#/, "").trim();
  if (raw.includes("=")) raw = raw.split("=").pop();
  raw = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return CODE_RE.test(raw) ? raw : null;
}
const inviteCode = parseInviteCode();
const isJoinMode = inviteCode !== null;

pseudoInput.value = sessionStorage.getItem(PSEUDO_KEY) || localStorage.getItem(PSEUDO_KEY) || "";

function readActive() {
  try {
    const a = JSON.parse(localStorage.getItem(ACTIVE_KEY) || "null");
    if (a && a.code && a.pseudo && Date.now() - (a.ts || 0) < ACTIVE_TTL) return a;
  } catch {}
  return null;
}

if (!isJoinMode) {
  const active = readActive();
  if (active) {
    $("resume-banner").hidden = false;
    $("resumeBtn").onclick = () => {
      sessionStorage.setItem(PSEUDO_KEY, active.pseudo);
      localStorage.setItem(PSEUDO_KEY, active.pseudo);
      location.href = `room.html?code=${encodeURIComponent(active.code)}`;
    };
    $("newBtn").onclick = () => {
      try { localStorage.removeItem(ACTIVE_KEY); } catch {}
      $("resume-banner").hidden = true;
    };
  }
} else {
  $("card-title").textContent = "Suivre une partie";
  $("subtitle-create").hidden = true;
  $("subtitle-join").hidden = false;
  $("join-code-label").textContent = inviteCode;
  createBtn.textContent = "Entrer";
}

(async () => {
  const ok = await pingWorker();
  $("server-status").textContent = ok ? "✓ serveur en ligne" : "✗ serveur injoignable";
  if (!ok) showError("Impossible de joindre le serveur. Réessaie dans un instant.");
})();

function pseudo() { return pseudoInput.value.trim(); }
function showError(msg) { errorBox.textContent = msg || ""; errorBox.classList.toggle("show", !!msg); }
function go(code) {
  sessionStorage.setItem(PSEUDO_KEY, pseudo());
  localStorage.setItem(PSEUDO_KEY, pseudo());
  location.href = `room.html?code=${encodeURIComponent(code)}`;
}

createBtn.addEventListener("click", async () => {
  showError("");
  if (pseudo().length < 3) return showError("Pseudo trop court (3 caractères min.).");
  createBtn.disabled = true;

  if (isJoinMode) {
    createBtn.textContent = "Vérification…";
    try {
      if (!(await roomExists(GAME, inviteCode))) {
        showError("Cette partie n'existe pas (ou a expiré). Demande un nouveau lien.");
        createBtn.disabled = false;
        createBtn.textContent = "Entrer";
        return;
      }
      go(inviteCode);
    } catch {
      showError("Erreur de connexion. Réessaie dans un instant.");
      createBtn.disabled = false;
      createBtn.textContent = "Entrer";
    }
    return;
  }

  createBtn.textContent = "Création…";
  try {
    go(await createRoom(GAME, {}));
  } catch {
    showError("Impossible de créer la partie. Réessaie dans un instant.");
    createBtn.disabled = false;
    createBtn.textContent = "Créer la partie";
  }
});

pseudoInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); createBtn.click(); } });

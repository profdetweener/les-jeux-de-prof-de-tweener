/**
 * Page d'entrée du mode compétitif de Mots mêlés (alignée sur Slide/Sésame).
 *
 *   - lien d'invitation `join.html#ABC123`  -> mode « Rejoindre » (pseudo seul)
 *   - sinon                                 -> mode « Créer »
 *
 * On rejoint ensuite via le lien d'invitation affiché dans le salon.
 */

import { createRoom, roomExists, pingWorker } from "../../shared/js/api.js";

const $ = (id) => document.getElementById(id);
const CODE_RE = /^[A-Z0-9]{4,6}$/;
const GAME = "motsmeles";

const pseudoInput = $("pseudo");
const createBtn = $("createBtn");
const errorBox = $("error-box");
const serverStatus = $("server-status");
const subtitleCreate = $("subtitle-create");
const subtitleJoin = $("subtitle-join");
const joinCodeLabel = $("join-code-label");
const cardTitle = $("card-title");

function parseInviteCode() {
  let raw = (location.hash || "").replace(/^#/, "").trim();
  if (raw.includes("=")) raw = raw.split("=").pop();
  raw = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return CODE_RE.test(raw) ? raw : null;
}
const inviteCode = parseInviteCode();
const isJoinMode = inviteCode !== null;

pseudoInput.value = sessionStorage.getItem("mm_pseudo") || localStorage.getItem("mm_pseudo") || "";

const ACTIVE_KEY = "mm_active";
const ACTIVE_TTL = 6 * 60 * 60 * 1000;
function readActive() {
  try {
    const a = JSON.parse(localStorage.getItem(ACTIVE_KEY) || "null");
    if (a && a.code && a.pseudo && Date.now() - (a.ts || 0) < ACTIVE_TTL) return a;
  } catch {}
  return null;
}
function clearActive() { try { localStorage.removeItem(ACTIVE_KEY); } catch {} }

if (!isJoinMode) {
  const active = readActive();
  if (active) {
    $("resume-banner").hidden = false;
    $("resumeBtn").onclick = () => {
      sessionStorage.setItem("mm_pseudo", active.pseudo);
      localStorage.setItem("mm_pseudo", active.pseudo);
      location.href = `room.html?code=${encodeURIComponent(active.code)}`;
    };
    $("newBtn").onclick = () => { clearActive(); $("resume-banner").hidden = true; };
  }
}

if (isJoinMode) {
  cardTitle.textContent = "Rejoindre une partie";
  subtitleCreate.hidden = true;
  subtitleJoin.hidden = false;
  joinCodeLabel.textContent = inviteCode;
  createBtn.textContent = "Rejoindre la partie";
}

(async () => {
  const ok = await pingWorker();
  serverStatus.textContent = ok ? "✓ serveur en ligne" : "✗ serveur injoignable";
  if (!ok) showError("Impossible de joindre le serveur. Réessaie dans un instant.");
})();

function pseudo() { return pseudoInput.value.trim(); }
function showError(msg) { errorBox.textContent = msg || ""; errorBox.classList.toggle("show", !!msg); }
function clearError() { showError(""); }
function go(code) {
  sessionStorage.setItem("mm_pseudo", pseudo());
  localStorage.setItem("mm_pseudo", pseudo());
  location.href = `room.html?code=${encodeURIComponent(code)}`;
}

createBtn.addEventListener("click", async () => {
  clearError();
  if (pseudo().length < 3) return showError("Pseudo trop court (3 caractères min.).");

  if (isJoinMode) {
    createBtn.disabled = true;
    createBtn.textContent = "Vérification…";
    try {
      const exists = await roomExists(GAME, inviteCode);
      if (!exists) {
        showError("Cette partie n'existe pas (ou a expiré). Demande un nouveau lien.");
        createBtn.disabled = false;
        createBtn.textContent = "Rejoindre la partie";
        return;
      }
      go(inviteCode);
    } catch (e) {
      showError("Erreur de connexion. Réessaie dans un instant.");
      createBtn.disabled = false;
      createBtn.textContent = "Rejoindre la partie";
    }
    return;
  }

  createBtn.disabled = true;
  createBtn.textContent = "Création…";
  try {
    const code = await createRoom(GAME, {});
    go(code);
  } catch (e) {
    showError("Impossible de créer la partie. Réessaie dans un instant.");
    createBtn.disabled = false;
    createBtn.textContent = "Créer la partie";
  }
});

pseudoInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); createBtn.click(); } });

/**
 * Page d'entrée du mode compétitif de Slide (alignée sur Sésame).
 *
 * Deux modes, décidés par l'URL :
 *   - lien d'invitation `join.html#ABC123`  -> mode « Rejoindre » (pseudo seul)
 *   - sinon (`join.html` ou `?create=competitive`) -> mode « Créer » (pseudo +
 *     « Créer la partie »). On rejoint ensuite UNIQUEMENT via le lien d'invitation
 *     affiché dans le salon (pas de saisie de code manuelle, comme Sésame).
 *
 * Le pseudo est mémorisé entre les sessions. Un ping serveur au chargement
 * affiche l'état de connexion dans le header.
 */

import { createRoom, roomExists, pingWorker } from "../../shared/js/api.js";

const $ = (id) => document.getElementById(id);
const CODE_RE = /^[A-Z0-9]{4,6}$/;

const pseudoInput = $("pseudo");
const createBtn = $("createBtn");
const errorBox = $("error-box");
const serverStatus = $("server-status");
const subtitleCreate = $("subtitle-create");
const subtitleJoin = $("subtitle-join");
const joinCodeLabel = $("join-code-label");
const cardTitle = $("card-title");

// ---------- Détection du mode via le hash (#ABC123 ou #join=ABC123) ----------
function parseInviteCode() {
  let raw = (location.hash || "").replace(/^#/, "").trim();
  if (raw.includes("=")) raw = raw.split("=").pop();
  raw = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return CODE_RE.test(raw) ? raw : null;
}
const inviteCode = parseInviteCode();
const isJoinMode = inviteCode !== null;

// ---------- Restauration du pseudo ----------
pseudoInput.value = sessionStorage.getItem("slide_pseudo") || "";

// ---------- Application du mode UI ----------
if (isJoinMode) {
  cardTitle.textContent = "Rejoindre une partie";
  subtitleCreate.hidden = true;
  subtitleJoin.hidden = false;
  joinCodeLabel.textContent = inviteCode;
  createBtn.textContent = "Rejoindre la partie";
}

// ---------- Ping serveur (état de connexion dans le header) ----------
(async () => {
  const ok = await pingWorker();
  serverStatus.textContent = ok ? "✓ serveur en ligne" : "✗ serveur injoignable";
  if (!ok) showError("Impossible de joindre le serveur. Réessaie dans un instant.");
})();

// ---------- Helpers ----------
function pseudo() { return pseudoInput.value.trim(); }
function showError(msg) { errorBox.textContent = msg || ""; errorBox.classList.toggle("show", !!msg); }
function clearError() { showError(""); }
function go(code) {
  sessionStorage.setItem("slide_pseudo", pseudo());
  location.href = `room.html?code=${encodeURIComponent(code)}`;
}

// ---------- Action principale : Créer OU Rejoindre (selon le mode) ----------
createBtn.addEventListener("click", async () => {
  clearError();
  if (pseudo().length < 3) return showError("Pseudo trop court (3 caractères min.).");

  // Mode « Rejoindre » via lien d'invitation
  if (isJoinMode) {
    createBtn.disabled = true;
    createBtn.textContent = "Vérification…";
    try {
      const exists = await roomExists("slide", inviteCode);
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

  // Mode « Créer »
  createBtn.disabled = true;
  createBtn.textContent = "Création…";
  try {
    const code = await createRoom("slide", {});
    go(code);
  } catch (e) {
    showError("Impossible de créer la partie. Réessaie dans un instant.");
    createBtn.disabled = false;
    createBtn.textContent = "Créer la partie";
  }
});

// ---------- Entrée clavier ----------
pseudoInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); createBtn.click(); } });

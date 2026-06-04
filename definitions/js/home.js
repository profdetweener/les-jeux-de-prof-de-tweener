/**
 * Logique de la page d'accueil de Definitions (creer / rejoindre via hash).
 * Calque sur petitbac/js/home.js, slug "definitions" et cles de storage propres.
 */

import { createRoom, roomExists, pingWorker } from "../../shared/js/api.js";
import { showToast } from "../../shared/js/toast.js";

const PSEUDO_MIN = 3;
const PSEUDO_MAX = 20;
const CODE_RE = /^[A-Z0-9]{4,6}$/;

const GAME = "definitions";
const KEY_PSEUDO = "definitions_pseudo";
const KEY_ROOM = "definitions_room";

const pseudoInput = document.getElementById("pseudo-input");
const btnAction = document.getElementById("btn-action");
const errorBox = document.getElementById("error-box");
const serverStatus = document.getElementById("server-status");
const resumeBanner = document.getElementById("resume-banner");
const resumeBannerCode = document.getElementById("resume-banner-code");
const resumeBannerPseudo = document.getElementById("resume-banner-pseudo");
const resumeBannerBtn = document.getElementById("resume-banner-btn");
const resumeBannerDismiss = document.getElementById("resume-banner-dismiss");
const subtitleCreate = document.getElementById("subtitle-create");
const subtitleJoin = document.getElementById("subtitle-join");
const joinCodeLabel = document.getElementById("join-code-label");

const storage = (() => {
  function tryStorage(s) {
    try {
      const k = "__def_test__";
      s.setItem(k, "1");
      s.removeItem(k);
      return s;
    } catch {
      return null;
    }
  }
  return tryStorage(window.localStorage) ?? tryStorage(window.sessionStorage) ?? {
    _m: new Map(),
    getItem(k) { return this._m.get(k) ?? null; },
    setItem(k, v) { this._m.set(k, v); },
    removeItem(k) { this._m.delete(k); },
  };
})();

function parseInviteCode() {
  let raw = (window.location.hash || "").replace(/^#/, "").trim();
  if (raw.includes("=")) {
    const parts = raw.split("=");
    raw = parts[parts.length - 1];
  }
  raw = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (CODE_RE.test(raw)) return raw;
  return null;
}

const inviteCode = parseInviteCode();
const isJoinMode = inviteCode !== null;

const savedPseudo = storage.getItem(KEY_PSEUDO);
const savedRoom = storage.getItem(KEY_ROOM);
if (savedPseudo) pseudoInput.value = savedPseudo;

if (isJoinMode) {
  subtitleCreate.style.display = "none";
  subtitleJoin.style.display = "block";
  joinCodeLabel.textContent = inviteCode;
  btnAction.textContent = "Rejoindre la partie";
} else {
  subtitleCreate.style.display = "block";
  subtitleJoin.style.display = "none";
  btnAction.textContent = "Créer une partie";
}

async function maybeShowResumeBanner() {
  if (!savedPseudo || !savedRoom || !resumeBanner) return;
  if (isJoinMode && savedRoom === inviteCode) return;
  let exists = false;
  try {
    exists = await roomExists(GAME, savedRoom);
  } catch {
    return;
  }
  if (!exists) {
    storage.removeItem(KEY_ROOM);
    return;
  }
  resumeBannerCode.textContent = savedRoom;
  resumeBannerPseudo.textContent = savedPseudo;
  resumeBanner.classList.add("show");
}

(async () => {
  const ok = await pingWorker();
  if (ok) {
    serverStatus.textContent = "✓ serveur en ligne";
    maybeShowResumeBanner();
  } else {
    serverStatus.textContent = "✗ serveur injoignable";
    showError("Impossible de joindre le serveur. Vérifie ta connexion ou la config.");
  }
})();

if (resumeBannerBtn) {
  resumeBannerBtn.addEventListener("click", () => {
    window.location.href = `room.html?code=${encodeURIComponent(savedRoom)}`;
  });
}
if (resumeBannerDismiss) {
  resumeBannerDismiss.addEventListener("click", () => {
    storage.removeItem(KEY_ROOM);
    resumeBanner.classList.remove("show");
  });
}

function validatePseudo() {
  const value = pseudoInput.value.trim();
  if (value.length < PSEUDO_MIN) {
    return { ok: false, error: `Pseudo trop court (min. ${PSEUDO_MIN} caractères).` };
  }
  if (value.length > PSEUDO_MAX) {
    return { ok: false, error: `Pseudo trop long (max. ${PSEUDO_MAX} caractères).` };
  }
  return { ok: true, value };
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.add("show");
}
function clearError() {
  errorBox.classList.remove("show");
  errorBox.textContent = "";
}

async function doAction() {
  clearError();
  const pseudoCheck = validatePseudo();
  if (!pseudoCheck.ok) {
    showError(pseudoCheck.error);
    pseudoInput.focus();
    return;
  }

  if (isJoinMode) {
    btnAction.disabled = true;
    btnAction.textContent = "Vérification…";
    try {
      const exists = await roomExists(GAME, inviteCode);
      if (!exists) {
        showError("Cette partie n'existe pas (ou a expiré). Demande un nouveau lien.");
        btnAction.disabled = false;
        btnAction.textContent = "Rejoindre la partie";
        return;
      }
      storage.setItem(KEY_PSEUDO, pseudoCheck.value);
      storage.setItem(KEY_ROOM, inviteCode);
      window.location.href = `room.html?code=${encodeURIComponent(inviteCode)}`;
    } catch (err) {
      console.error(err);
      showError("Impossible de joindre le serveur. Réessaie dans un instant.");
      btnAction.disabled = false;
      btnAction.textContent = "Rejoindre la partie";
    }
    return;
  }

  btnAction.disabled = true;
  btnAction.textContent = "Création…";
  try {
    const code = await createRoom(GAME);
    storage.setItem(KEY_PSEUDO, pseudoCheck.value);
    storage.setItem(KEY_ROOM, code);
    window.location.href = `room.html?code=${encodeURIComponent(code)}`;
  } catch (err) {
    console.error(err);
    showError("Impossible de créer la room. Réessaie dans un instant.");
    btnAction.disabled = false;
    btnAction.textContent = "Créer une partie";
  }
}

btnAction.addEventListener("click", doAction);
pseudoInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    doAction();
  }
});

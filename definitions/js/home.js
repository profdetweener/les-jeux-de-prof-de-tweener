/**
 * Logique de la page d'entree de Definitions (join.html).
 * Lit le mode dans ?mode= (si la personne arrive depuis le picker) et le
 * propage vers room.html. Pour un invite (lien #CODE), le mode est ignore
 * cote URL : il sera fixe par la room a laquelle il rejoint.
 */

import { createRoom, roomExists, pingWorker } from "../../shared/js/api.js";
import { showToast } from "../../shared/js/toast.js";

const PSEUDO_MIN = 3;
const PSEUDO_MAX = 20;
const CODE_RE = /^[A-Z0-9]{4,6}$/;

const GAME = "definitions";
const KEY_PSEUDO = "definitions_pseudo";
const KEY_ROOM = "definitions_room";

const MODE_LABELS = { competitive: "Compétitif ⚔️", chill: "Chill 🛋️" };

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
const modePill = document.getElementById("mode-pill");
const modePillValue = document.getElementById("mode-pill-value");

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

function parseMode() {
  try {
    const m = new URLSearchParams(window.location.search).get("mode") || "";
    if (m === "chill" || m === "competitive") return m;
  } catch {}
  return null;
}

const inviteCode = parseInviteCode();
const isJoinMode = inviteCode !== null;
// Mode choisi via le picker (uniquement quand on CREE une partie ; pour un
// invite, le mode sera celui de la room cible et n'a pas besoin d'etre dans l'URL).
const createMode = isJoinMode ? null : (parseMode() ?? "competitive");

const savedPseudo = storage.getItem(KEY_PSEUDO);
const savedRoom = storage.getItem(KEY_ROOM);
if (savedPseudo) pseudoInput.value = savedPseudo;

if (isJoinMode) {
  subtitleCreate.style.display = "none";
  subtitleJoin.style.display = "block";
  joinCodeLabel.textContent = inviteCode;
  btnAction.textContent = "Rejoindre la partie";
  // Pas de mode-pill pour les invites : ils heriteront du mode de la room
} else {
  subtitleCreate.style.display = "block";
  subtitleJoin.style.display = "none";
  btnAction.textContent = "Créer une partie";
  if (modePill && modePillValue && createMode) {
    modePill.style.display = "flex";
    modePillValue.textContent = MODE_LABELS[createMode] ?? createMode;
    modePill.classList.add(createMode === "chill" ? "mode-chill" : "mode-compet");
  }
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
    const modeParam = createMode ? `&mode=${encodeURIComponent(createMode)}` : "";
    window.location.href = `room.html?code=${encodeURIComponent(code)}${modeParam}`;
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

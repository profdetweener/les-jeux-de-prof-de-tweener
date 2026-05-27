/**
 * Logique de la page d'accueil (refactor : invitation par URL hash).
 *
 * Comportement :
 *   - Si l'URL contient un hash (`#ABC123`) avec un code de room valide,
 *     la page passe en mode "Rejoindre" : un seul champ pseudo, le code
 *     est implicite. Le bouton verifie l'existence de la room puis redirige.
 *   - Sinon, la page est en mode "Creer" : un champ pseudo, le bouton
 *     cree une nouvelle room et redirige.
 *
 * Persistance :
 *   - le pseudo (localStorage) est restaure entre les sessions
 *   - une banniere "Reprendre la partie" apparait si l'utilisateur etait
 *     dans une room qui existe encore
 *
 * Format du code dans le hash : 6 caracteres alphanumeriques (cf. CODE_ALPHABET serveur).
 * On accepte aussi `#join=ABC123` pour etre tolerant, mais on emet du `#ABC123` brut.
 */

import { createRoom, roomExists, pingWorker } from "../../shared/js/api.js";
import { showToast } from "../../shared/js/toast.js";

const PSEUDO_MIN = 3;
const PSEUDO_MAX = 20;
// Doit matcher CODE_ALPHABET cote serveur (ABCDEFGHJKMNPQRSTUVWXYZ23456789, longueur 6)
// On est tolerant a la saisie utilisateur ici : tout 4 a 6 chars alphanum est accepte
// (le serveur fera la verification stricte).
const CODE_RE = /^[A-Z0-9]{4,6}$/;

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

// --- Helper de stockage : localStorage par defaut, fallback sessionStorage ---
const storage = (() => {
  function tryStorage(s) {
    try {
      const k = "__pbac_test__";
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

// --- Detection du mode (Creer ou Rejoindre) via le hash de l'URL ---
// On tolere plusieurs formats :
//   #ABC123       (forme canonique)
//   #join=ABC123  (forme verbeuse, anciennement utilisee)
//   ?code=ABC123  (forme query string, anciennement utilisee par buildInviteUrl)
function parseInviteCode() {
  // 1. On essaie d'abord le hash
  let raw = (window.location.hash || "").replace(/^#/, "").trim();
  if (raw.includes("=")) {
    const parts = raw.split("=");
    raw = parts[parts.length - 1];
  }
  raw = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (CODE_RE.test(raw)) return raw;

  // 2. Sinon on regarde la query string (compat ancien lien ?code=ABC123)
  try {
    const params = new URLSearchParams(window.location.search);
    const q = (params.get("code") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (CODE_RE.test(q)) return q;
  } catch {
    /* ignore */
  }

  return null;
}

const inviteCode = parseInviteCode();
const isJoinMode = inviteCode !== null;

// --- Restauration du pseudo s'il existe deja ---
const savedPseudo = storage.getItem("motus_pseudo");
const savedRoom = storage.getItem("motus_room");
if (savedPseudo) {
  pseudoInput.value = savedPseudo;
}

// --- Application du mode UI (Creer ou Rejoindre) ---
// La page join.html n'a plus de mode "Creer" : la creation se fait via le menu
// principal Motus (chill / competitif). Si on arrive ici sans code, on affiche
// un message et on desactive le bouton.
if (isJoinMode) {
  subtitleCreate.style.display = "none";
  subtitleJoin.style.display = "block";
  joinCodeLabel.textContent = inviteCode;
  btnAction.textContent = "Rejoindre la partie";
} else {
  subtitleCreate.style.display = "block";
  subtitleJoin.style.display = "none";
  btnAction.textContent = "Aucune partie à rejoindre";
  btnAction.disabled = true;
  const pseudoGroup = document.getElementById("pseudo-group");
  if (pseudoGroup) pseudoGroup.style.display = "none";
}

// --- Banniere "Reprendre la partie" ---
// Affichee si pseudo + code sont en storage ET que la room existe encore.
// En mode "Rejoindre" via lien, on n'affiche la reprise que si la room sauvegardee
// est differente du lien : sinon ca fait doublon (le bouton principal va deja la rejoindre).
async function maybeShowResumeBanner() {
  if (!savedPseudo || !savedRoom || !resumeBanner) return;
  if (isJoinMode && savedRoom === inviteCode) return;
  let exists = false;
  try {
    exists = await roomExists("motus", savedRoom);
  } catch {
    return; // pas de banniere si serveur injoignable
  }
  if (!exists) {
    storage.removeItem("motus_room");
    return;
  }
  resumeBannerCode.textContent = savedRoom;
  resumeBannerPseudo.textContent = savedPseudo;
  resumeBanner.classList.add("show");
}

// --- Verifie la dispo du serveur au chargement ---
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

// --- Bouton "Reprendre la partie" ---
if (resumeBannerBtn) {
  resumeBannerBtn.addEventListener("click", () => {
    window.location.href = `room.html?code=${encodeURIComponent(savedRoom)}`;
  });
}
if (resumeBannerDismiss) {
  resumeBannerDismiss.addEventListener("click", () => {
    storage.removeItem("motus_room");
    resumeBanner.classList.remove("show");
  });
}

// --- Validation cote client du pseudo ---
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

// --- Action principale (Creer OU Rejoindre selon le mode) ---
async function doAction() {
  clearError();
  const pseudoCheck = validatePseudo();
  if (!pseudoCheck.ok) {
    showError(pseudoCheck.error);
    pseudoInput.focus();
    return;
  }

  if (isJoinMode) {
    // Mode Rejoindre : on verifie que la room existe puis on redirige
    btnAction.disabled = true;
    btnAction.textContent = "Vérification…";
    try {
      const exists = await roomExists("motus", inviteCode);
      if (!exists) {
        showError("Cette partie n'existe pas (ou a expiré). Demande un nouveau lien.");
        btnAction.disabled = false;
        btnAction.textContent = "Rejoindre la partie";
        return;
      }
      storage.setItem("motus_pseudo", pseudoCheck.value);
      storage.setItem("motus_room", inviteCode);
      window.location.href = `room.html?code=${encodeURIComponent(inviteCode)}`;
    } catch (err) {
      console.error(err);
      showError("Impossible de joindre le serveur. Réessaie dans un instant.");
      btnAction.disabled = false;
      btnAction.textContent = "Rejoindre la partie";
    }
    return;
  }

  // Mode Creer
  btnAction.disabled = true;
  btnAction.textContent = "Création…";
  try {
    const code = await createRoom("motus");
    storage.setItem("motus_pseudo", pseudoCheck.value);
    storage.setItem("motus_room", code);
    window.location.href = `room.html?code=${encodeURIComponent(code)}`;
  } catch (err) {
    console.error(err);
    showError("Impossible de créer la room. Réessaie dans un instant.");
    btnAction.disabled = false;
    btnAction.textContent = "Créer une partie";
  }
}

btnAction.addEventListener("click", doAction);

// --- Entree dans le champ pseudo = action principale ---
pseudoInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    doAction();
  }
});

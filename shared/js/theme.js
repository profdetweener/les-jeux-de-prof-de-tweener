/**
 * Bascule clair / sombre, partagee par toutes les pages du site.
 *
 * Fonctionnement :
 *   - la preference est stockee dans localStorage sous la cle "pdt-theme"
 *     (valeurs "light" ou "dark") ;
 *   - si aucune preference explicite n'existe, on suit le reglage systeme
 *     (prefers-color-scheme) et on continue de le suivre tant que l'utilisateur
 *     n'a pas clique le bouton ;
 *   - le theme actif est porte par l'attribut data-theme sur <html>, ce qui
 *     permet aux feuilles de style de definir un bloc [data-theme="dark"].
 *
 * Le "no-flash" (application du theme avant le premier rendu) est fait par un
 * petit script inline dans le <head> de chaque page. Ce module-ci ne fait que
 * construire le bouton flottant et gerer les clics + les changements systeme.
 *
 * Aucune dependance, aucun export : c'est un module a effet de bord, importe
 * en fin de <body> par chaque page (<script type="module" src=".../theme.js">).
 */

const STORAGE_KEY = "pdt-theme";
const root = document.documentElement;

function systemPrefersDark() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function storedPreference() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

function currentTheme() {
  return root.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function applyTheme(theme) {
  root.setAttribute("data-theme", theme);
  // Met a jour la barre systeme (mobile) pour coller au theme.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#10141d" : "#1a2540");
  updateButton(theme);
}

function setPreference(theme) {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* stockage indisponible (navigation privee stricte) : on applique quand meme */
  }
  applyTheme(theme);
}

// --- Bouton flottant -------------------------------------------------------

let btn = null;

function updateButton(theme) {
  if (!btn) return;
  const dark = theme === "dark";
  // On affiche l'icone de la CIBLE (ce vers quoi le clic bascule), pas de l'etat courant.
  btn.textContent = dark ? "\u2600\uFE0F" : "\uD83C\uDF19"; // soleil si on est en sombre, lune si on est en clair
  const label = dark ? "Passer en mode clair" : "Passer en mode sombre";
  btn.setAttribute("aria-label", label);
  btn.setAttribute("title", label);
  btn.setAttribute("aria-pressed", dark ? "true" : "false");
}

function buildButton() {
  btn = document.createElement("button");
  btn.type = "button";
  btn.className = "theme-toggle";
  btn.addEventListener("click", () => {
    setPreference(currentTheme() === "dark" ? "light" : "dark");
  });
  document.body.appendChild(btn);
  updateButton(currentTheme());
}

// --- Suivi du reglage systeme (tant qu'aucun choix explicite) --------------

if (window.matchMedia) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = (e) => {
    if (storedPreference() === null) applyTheme(e.matches ? "dark" : "light");
  };
  if (mq.addEventListener) mq.addEventListener("change", onChange);
  else if (mq.addListener) mq.addListener(onChange); // Safari ancien
}

// data-theme est deja pose par le script inline du <head> ; on se contente de
// (re)synchroniser au cas ou, puis on construit le bouton.
if (!root.getAttribute("data-theme")) {
  applyTheme(storedPreference() ?? (systemPrefersDark() ? "dark" : "light"));
}

if (document.body) buildButton();
else document.addEventListener("DOMContentLoaded", buildButton, { once: true });

import { createRoom, roomExists } from "../../shared/js/api.js";

const $ = (id) => document.getElementById(id);
const err = (m) => { $("err").textContent = m || ""; };

// Pre-remplit le pseudo memorise
$("pseudo").value = sessionStorage.getItem("slide_pseudo") || "";

function pseudo() { return $("pseudo").value.trim(); }
function go(code) {
  sessionStorage.setItem("slide_pseudo", pseudo());
  location.href = `room.html?code=${encodeURIComponent(code)}`;
}

$("createBtn").addEventListener("click", async () => {
  if (pseudo().length < 3) return err("Pseudo trop court (3 caractères min).");
  err(""); $("createBtn").disabled = true;
  try {
    const code = await createRoom("slide", {});
    go(code);
  } catch (e) {
    err("Impossible de créer la partie. Réessaie.");
    $("createBtn").disabled = false;
  }
});

$("joinBtn").addEventListener("click", async () => {
  if (pseudo().length < 3) return err("Pseudo trop court (3 caractères min).");
  const code = $("code").value.trim().toUpperCase();
  if (code.length !== 6) return err("Le code fait 6 caractères.");
  err(""); $("joinBtn").disabled = true;
  try {
    const exists = await roomExists("slide", code);
    if (!exists) { err("Cette partie n'existe pas."); $("joinBtn").disabled = false; return; }
    go(code);
  } catch (e) {
    err("Erreur de connexion. Réessaie.");
    $("joinBtn").disabled = false;
  }
});

$("code").addEventListener("keydown", (e) => { if (e.key === "Enter") $("joinBtn").click(); });

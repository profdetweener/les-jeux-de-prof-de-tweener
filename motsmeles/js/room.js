import { RoomConnection } from "../../shared/js/ws.js";

// ---------- Contexte ----------
const params = new URLSearchParams(location.search);
const CODE = (params.get("code") || "").toUpperCase();
const ME = (sessionStorage.getItem("mm_pseudo") || localStorage.getItem("mm_pseudo") || "").trim();
if (!CODE || ME.length < 3) { location.href = "join.html"; }
const ACTIVE_KEY = "mm_active";

const $ = (id) => document.getElementById(id);

// Palette de couleurs joueurs (une couleur par joueur, index attribué par le serveur).
const PALETTE = ["#c84545", "#4a6fa5", "#4a8c5a", "#d4a830", "#8a5fb0", "#2a9d8f",
                 "#e07a3f", "#c05a8f", "#3f7d9a", "#6b8e23", "#5b6bbf", "#b5843a"];
const colorOf = (i) => PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];

// ---------- Etat ----------
let isHost = false;
let players = [];
let phase = "lobby";
let config = null;
let game = null;         // GameStateDTO
let sel = null;          // { r, c } case de départ sélectionnée
let startCfg = { gridSize: 12, level: "moyen" };
let toastTimer = null;

// ---------- Connexion ----------
const conn = new RoomConnection(CODE, "motsmeles");

function buildInviteUrl(code) {
  const url = new URL(location.href);
  url.pathname = url.pathname.replace(/room\.html$/, "join.html");
  url.search = "";
  url.hash = code;
  return url.toString();
}
const inviteUrl = buildInviteUrl(CODE);
const inviteUrlEl = $("inviteUrl");
if (inviteUrlEl) inviteUrlEl.textContent = inviteUrl;

conn.onStatus((s) => {
  const b = $("conn");
  if (s === "open") { b.hidden = true; }
  else if (s === "connecting") { b.hidden = false; b.textContent = "Connexion…"; }
  else if (s === "closed" || s === "error") { b.hidden = false; b.textContent = "Connexion perdue, reconnexion…"; }
});

conn.on("joined", (m) => {
  isHost = m.isHost; players = m.players; phase = m.phase; config = m.config; game = m.game;
  try {
    localStorage.setItem("mm_pseudo", ME);
    localStorage.setItem(ACTIVE_KEY, JSON.stringify({ code: CODE, pseudo: ME, ts: Date.now() }));
  } catch {}
  render();
});
conn.on("room_state", (m) => { players = m.players; phase = m.phase; render(); });
conn.on("game_state", (m) => { players = m.players; phase = m.phase; game = m.game; sel = null; render(); });
conn.on("found", (m) => {
  players = m.players;
  if (game) game.found.push(m.word);
  applyFound(m.word);
  updateScoreboard();
  const who = m.word.pseudo === ME ? "Toi" : m.word.pseudo;
  toast(`${who} : ${m.word.word}`);
});
conn.on("hint", (m) => {
  setStatus(m.message, m.kind === "longer" ? "warn" : "");
});
conn.on("finished", (m) => {
  players = m.players; phase = "finished"; game = null;
  try { localStorage.removeItem(ACTIVE_KEY); } catch {}
  renderFinished(m);
});
conn.on("error", (m) => {
  const e = $("startErr"); if (e) e.textContent = m.message;
  setStatus(m.message, "warn");
});
conn.connect();
conn.send({ type: "join", pseudo: ME });

// ---------- Helpers ----------
function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function setStatus(t, cls) { const s = $("status"); if (!s) return; s.textContent = t || ""; s.className = "mm-status" + (cls ? " " + cls : ""); }
function toast(msg) {
  const el = $("toast"); if (!el) return;
  el.textContent = msg; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 1600);
}

// ---------- Rendu principal ----------
function render() {
  $("lobby").hidden = phase !== "lobby";
  $("game").hidden = phase !== "playing";
  $("finished").hidden = phase !== "finished";
  const main = document.querySelector(".room-main");
  if (main) main.classList.toggle("in-game", phase === "playing");
  if (phase === "lobby") renderLobby();
  else if (phase === "playing") renderGame();
}

// Version translucide de la couleur d'un joueur (pour le fond des cases trouvees).
function tintOf(i) {
  const h = colorOf(i).replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},0.22)`;
}

function renderLobby() {
  $("lobbyPlayers").innerHTML = players.map((p) => {
    const badges = [];
    if (p.isHost) badges.push('<span class="badge">hôte</span>');
    if (!p.isConnected) badges.push('<span class="badge off">hors ligne</span>');
    return `<div class="player-row"><span class="pname">${p.pseudo === ME ? "toi" : escapeHtml(p.pseudo)}</span>${badges.join(" ")}</div>`;
  }).join("");
  const pc = $("playerCount"); if (pc) pc.textContent = players.length;

  const connected = players.filter((p) => p.isConnected).length;
  if (isHost) {
    $("hostControls").hidden = false;
    $("waitNote").hidden = true;
    wireSeg("sizeSeg", (b) => (startCfg.gridSize = +b.dataset.n));
    wireSeg("diffSeg", (b) => (startCfg.level = b.dataset.l));
    const btn = $("startBtn");
    btn.disabled = connected < 2;
    $("startErr").textContent = connected < 2 ? "Il faut au moins 2 joueurs connectés." : "";
    btn.onclick = () => conn.send({ type: "start", gridSize: startCfg.gridSize, level: startCfg.level });
  } else {
    $("hostControls").hidden = true;
    $("waitNote").hidden = false;
  }
}

function wireSeg(id, apply) {
  const seg = $(id);
  seg.querySelectorAll("button").forEach((b) => {
    b.onclick = () => { seg.querySelectorAll("button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); apply(b); };
  });
}

// ---------- Jeu ----------
function renderGame() {
  if (!game) return;
  updateScoreboard();
  renderGrid();
  sizeGrid();
  requestAnimationFrame(sizeGrid);

  const eg = $("endGameBtn");
  if (eg) {
    eg.hidden = !isHost;
    eg.onclick = () => { if (confirm("Terminer la partie maintenant ? Le joueur en tête l'emporte.")) conn.send({ type: "endGame" }); };
  }
  setStatus("");
}

function updateScoreboard() {
  if (!game) return;
  const foundCount = game.found.length;
  const ordered = players.slice().sort((a, b) => b.score - a.score);
  $("scorePanel").innerHTML =
    `<div class="sb-goal">Mots trouvés <b>${foundCount}</b> / ${game.totalWords}</div>` +
    `<div class="sb-players">` +
    ordered.map((p) => {
      const me = p.pseudo === ME;
      return `<div class="sb-chip${me ? " me" : ""}">` +
        `<span class="sb-dot" style="background:${colorOf(p.color)}"></span>` +
        `<span class="sb-name">${me ? "toi" : escapeHtml(p.pseudo)}</span>` +
        `<b>${p.score}</b>` +
        (p.isConnected ? "" : ' <span class="badge off">off</span>') +
        `</div>`;
    }).join("") +
    `</div>`;
}

let cellEls = {};
function renderGrid() {
  const n = game.gridSize, g = game.grid;
  const grid = $("grid");
  grid.innerHTML = "";
  cellEls = {};
  const frag = document.createDocumentFragment();
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const d = document.createElement("div");
      d.className = "mm-cell";
      d.textContent = g[r][c];
      d.dataset.r = r; d.dataset.c = c;
      frag.appendChild(d);
      cellEls[r + "," + c] = d;
    }
  }
  grid.appendChild(frag);
  // Recolore les mots déjà trouvés (reconnexion / arrivée en cours).
  for (const w of game.found) applyFound(w);
}

function applyFound(w) {
  const tint = tintOf(w.color), ink = colorOf(w.color);
  for (const cc of w.cells) {
    const d = cellEls[cc.r + "," + cc.c];
    if (!d) continue;
    d.classList.add("found");
    d.style.background = tint;
    d.style.color = ink;
  }
}

// Sélection : clic case de début puis case de fin.
$("grid").addEventListener("click", (e) => {
  const cell = e.target.closest(".mm-cell");
  if (!cell || !game) return;
  const r = +cell.dataset.r, c = +cell.dataset.c;
  if (!sel) { sel = { r, c, el: cell }; cell.classList.add("sel-start"); return; }
  if (sel.r === r && sel.c === c) { cell.classList.remove("sel-start"); sel = null; return; }
  sel.el.classList.remove("sel-start");
  const path = buildPath(sel.r, sel.c, r, c);
  sel = null;
  if (!path) { setStatus("Sélection en ligne droite uniquement.", "warn"); return; }
  conn.send({ type: "claim", cells: path });
});

function buildPath(r1, c1, r2, c2) {
  const dR = r2 - r1, dC = c2 - c1;
  if (!(r1 === r2 || c1 === c2 || Math.abs(dR) === Math.abs(dC))) return null;
  const len = Math.max(Math.abs(dR), Math.abs(dC)) + 1;
  const sr = Math.sign(dR), sc = Math.sign(dC);
  const cells = [];
  for (let i = 0; i < len; i++) cells.push({ r: r1 + sr * i, c: c1 + sc * i });
  return cells;
}

function sizeGrid() {
  if (!game || $("game").hidden) return;
  const grid = $("grid");
  const n = game.gridSize;
  const avail = Math.min(grid.parentElement.clientWidth || 600, 600);
  const gap = 3, pad = 12;
  let c = Math.floor((avail - pad - gap * (n - 1)) / n);
  c = Math.max(18, Math.min(46, c));
  grid.style.setProperty("--c", c + "px");
  grid.style.setProperty("--n", n);
}
let _rz;
window.addEventListener("resize", () => { clearTimeout(_rz); _rz = setTimeout(sizeGrid, 120); });

// ---------- Fin de partie ----------
function renderFinished(m) {
  $("lobby").hidden = true; $("game").hidden = true; $("finished").hidden = false;
  const main = document.querySelector(".room-main");
  if (main) main.classList.remove("in-game");
  const won = m.winner === ME;
  $("winTitle").innerHTML = won ? "🏆 Gagné !" : `🏆 ${escapeHtml(m.winner)} l'emporte`;
  const medals = ["🥇", "🥈", "🥉"];
  const tiers = ["gold", "silver", "bronze"];
  $("ranking").innerHTML = m.ranking.map((p, i) => {
    const tier = tiers[i] || "";
    const badge = medals[i] || `<span class="rank-num">${i + 1}</span>`;
    return `<div class="rank-row${tier ? " " + tier : ""}">` +
      `<span class="rank-medal">${badge}</span>` +
      `<span class="pname">${p.pseudo === ME ? "toi" : escapeHtml(p.pseudo)}</span>` +
      `<span class="pscore">${p.score}</span></div>`;
  }).join("");
  const lb = $("lobbyBtn");
  lb.hidden = !isHost;
  lb.onclick = () => conn.send({ type: "backToLobby" });
}

// Copier le lien d'invitation
const copyBtn = $("copyBtn");
if (copyBtn) copyBtn.onclick = () => {
  navigator.clipboard?.writeText(inviteUrl);
  copyBtn.textContent = "Lien copié !";
  setTimeout(() => (copyBtn.textContent = "Copier le lien"), 1400);
};

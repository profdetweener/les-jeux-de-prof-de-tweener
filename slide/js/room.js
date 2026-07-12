import { RoomConnection } from "../../shared/js/ws.js";

// ---------- Contexte ----------
const params = new URLSearchParams(location.search);
const CODE = (params.get("code") || "").toUpperCase();
const ME = (sessionStorage.getItem("slide_pseudo") || "").trim();
if (!CODE || ME.length < 3) { location.href = "join.html"; }

const $ = (id) => document.getElementById(id);

// ---------- Etat ----------
let isHost = false;
let players = [];
let phase = "lobby";
let config = null;
let game = null;         // GameStateDTO
let selectedCardId = null;
let startCfg = { gridSize: 5, target: 50 };

// ---------- Connexion ----------
const conn = new RoomConnection(CODE, "slide");

// Lien d'invitation canonique : join.html#ABC123 (le code dans le hash).
// On rejoint la partie en ouvrant ce lien, comme sur les autres jeux.
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
const tag = $("roomCodeTag");
if (tag) tag.textContent = "";

conn.onStatus((s) => {
  const b = $("conn");
  if (s === "open") { b.hidden = true; }
  else if (s === "connecting") { b.hidden = false; b.textContent = "Connexion…"; }
  else if (s === "closed" || s === "error") { b.hidden = false; b.textContent = "Connexion perdue, reconnexion…"; }
});
conn.on("joined", (m) => { isHost = m.isHost; players = m.players; phase = m.phase; config = m.config; game = m.game; render(); });
conn.on("room_state", (m) => { players = m.players; phase = m.phase; render(); });
conn.on("game_state", (m) => { players = m.players; phase = m.phase; game = m.game; selectedCardId = null; render(); });
conn.on("finished", (m) => { players = m.players; phase = "finished"; game = null; renderFinished(m); });
conn.on("error", (m) => { const e = $("startErr"); if (e) e.textContent = m.message; setStatus(m.message); });
conn.connect();
conn.send({ type: "join", pseudo: ME });

// ---------- Rendu ----------
function myTurn() { return game && game.activePseudo === ME; }
function setStatus(t) { const s = $("status"); if (s) s.textContent = t || ""; }

function render() {
  $("lobby").hidden = phase !== "lobby";
  $("game").hidden = phase !== "playing";
  $("finished").hidden = phase !== "finished";
  if (phase === "lobby") renderLobby();
  else if (phase === "playing") renderGame();
}

function playerRow(p, opts = {}) {
  const active = opts.activePseudo && p.pseudo === opts.activePseudo;
  const badges = [];
  if (p.isHost) badges.push('<span class="badge">hôte</span>');
  if (!p.isConnected) badges.push('<span class="badge off">hors ligne</span>');
  return `<div class="player-row${active ? " active" : ""}">
    <span class="pname">${escapeHtml(p.pseudo)}${p.pseudo === ME ? " (toi)" : ""}</span>
    ${badges.join(" ")}
    ${opts.score ? `<span class="pscore">${p.score}</span>` : ""}
  </div>`;
}
function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function renderLobby() {
  $("lobbyPlayers").innerHTML = players.map((p) => playerRow(p)).join("");
  const pc = $("playerCount");
  if (pc) pc.textContent = players.length;
  const connected = players.filter((p) => p.isConnected).length;
  if (isHost) {
    $("hostControls").hidden = false;
    $("waitNote").hidden = true;
    wireSeg("sizeSeg", (b) => (startCfg.gridSize = +b.dataset.n));
    wireSeg("targetSeg", (b) => (startCfg.target = +b.dataset.t));
    const btn = $("startBtn");
    btn.disabled = connected < 2;
    $("startErr").textContent = connected < 2 ? "Il faut au moins 2 joueurs connectés." : "";
    btn.onclick = () => conn.send({ type: "start", gridSize: startCfg.gridSize, target: startCfg.target });
  } else {
    $("hostControls").hidden = true;
    $("waitNote").hidden = false;
  }
}

let segWired = false;
function wireSeg(id, apply) {
  const seg = $(id);
  seg.querySelectorAll("button").forEach((b) => {
    b.onclick = () => { seg.querySelectorAll("button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); apply(b); };
  });
}

function renderGame() {
  if (!game) return;
  const N = game.gridSize;
  const mine = myTurn();

  // Bandeau compact : objectif + une "chip" par joueur. Le joueur actif est
  // surligné avec un ▶ (remplace la bannière "Au tour de…").
  $("scorePanel").innerHTML =
    `<div class="sb-goal">Objectif ${game.target}</div>` +
    `<div class="sb-players">` +
    players.map((p) => {
      const isActive = p.pseudo === game.activePseudo;
      const me = p.pseudo === ME;
      return `<div class="sb-chip${isActive ? " active" : ""}">` +
        (isActive ? `<span class="sb-turn">▶</span>` : "") +
        `<span class="sb-name">${escapeHtml(p.pseudo)}${me ? " (toi)" : ""}</span>` +
        `<b>${p.score}</b>` +
        (p.isConnected ? "" : `<span class="badge off">off</span>`) +
        `</div>`;
    }).join("") +
    `</div>`;

  // Ensemble des cases encaissables -> cle du groupe
  const litKey = new Map();
  for (const g of game.lit) for (const c of g.cells) litKey.set(c.r + "," + c.c, g.key);

  // Plateau + fleches
  const canPush = mine && game.turnPhase === "push" && selectedCardId != null;
  let html = '<div class="arrow-row">';
  for (let c = 0; c < N; c++) html += arw("col", c, true, "\u25BC");
  html += '</div><div class="mid"><div class="arrow-col">';
  for (let r = 0; r < N; r++) html += arw("row", r, true, "\u25B6");
  html += '</div><div class="grid">';
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const card = game.board[r][c];
    const key = litKey.get(r + "," + c);
    const cls = "cell" + (key ? " lit" : "");
    html += `<div class="${cls}" data-r="${r}" data-c="${c}"${key ? ` data-key="${key}"` : ""}>${card.value}</div>`;
  }
  html += '</div><div class="arrow-col">';
  for (let r = 0; r < N; r++) html += arw("row", r, false, "\u25C0");
  html += '</div></div><div class="arrow-row">';
  for (let c = 0; c < N; c++) html += arw("col", c, false, "\u25B2");
  html += "</div>";
  const frame = $("frame");
  frame.className = "frame" + (canPush ? " aim" : "");
  frame.innerHTML = html;

  frame.querySelectorAll(".arrow").forEach((btn) => {
    btn.onclick = () => {
      if (!(mine && game.turnPhase === "push" && selectedCardId != null)) return;
      conn.send({ type: "push", cardId: selectedCardId, kind: btn.dataset.type, index: +btn.dataset.idx, fromStart: btn.dataset.fs === "1" });
    };
  });
  if (mine && game.turnPhase === "claim") {
    frame.querySelectorAll(".cell.lit").forEach((cell) => {
      cell.onclick = () => conn.send({ type: "claim", key: cell.dataset.key });
    });
  }

  // Riviere
  const rv = $("river"); rv.innerHTML = "";
  game.river.forEach((card) => {
    const d = document.createElement("button");
    const selectable = mine && game.turnPhase === "push";
    d.className = "river-card" + (card.id === selectedCardId ? " sel" : "");
    d.textContent = card.value;
    d.disabled = !selectable;
    d.onclick = () => { if (selectable) { selectedCardId = card.id; renderGame(); } };
    rv.appendChild(d);
  });

  // Statut + bouton terminer
  if (!mine) setStatus("");
  else if (game.turnPhase === "push") setStatus(selectedCardId == null ? "Choisis une carte dans la rivière." : "Clique une flèche pour insérer ta carte.");
  else setStatus(game.lit.length ? "Encaisse tes groupes, puis termine le tour." : "Aucun groupe formé. Termine le tour.");
  $("endTurn").style.display = mine && game.turnPhase === "claim" ? "" : "none";
  $("endTurn").onclick = () => conn.send({ type: "endTurn" });

  sizeBoard();
}

// Redimensionne le plateau pour qu'il tienne dans l'espace disponible,
// arrows comprises, sans jamais forcer un scroll (crucial sur mobile et
// avec beaucoup de joueurs). Recalcule aussi au resize / rotation.
function sizeBoard() {
  if (!game || $("game").hidden) return;
  const area = $("boardArea");
  if (!area) return;
  const N = game.gridSize;
  const gap = 6;
  const bottomH = $("gameBottom") ? $("gameBottom").offsetHeight : 0;
  const footer = document.querySelector(".app-footer");
  const footerH = footer ? footer.offsetHeight : 0;
  const top = area.getBoundingClientRect().top;
  const availH = Math.max(170, window.innerHeight - top - bottomH - footerH - 26);
  const availW = area.clientWidth;
  // Largeur : N colonnes + 2 demi-fleches (~0.62c chacune).
  // Hauteur : N lignes + 2 fleches (haut/bas).
  const cW = (availW - gap * (N + 1)) / (N + 1.24);
  const cH = (availH - gap * (N + 1)) / (N + 2);
  let c = Math.floor(Math.min(cW, cH));
  c = Math.max(26, Math.min(64, c));
  const root = document.documentElement.style;
  root.setProperty("--n", N);
  root.setProperty("--c", c + "px");
  root.setProperty("--gap", gap + "px");
}

let _rz;
window.addEventListener("resize", () => { clearTimeout(_rz); _rz = setTimeout(sizeBoard, 120); });

function arw(t, idx, fs, g) { return `<button class="arrow" data-type="${t}" data-idx="${idx}" data-fs="${fs ? 1 : 0}">${g}</button>`; }

function renderFinished(m) {
  $("lobby").hidden = true; $("game").hidden = true; $("finished").hidden = false;
  const won = m.winner === ME;
  $("winTitle").textContent = won ? "Gagné !" : `${m.winner} l'emporte`;
  $("ranking").innerHTML = m.ranking.map((p, i) => `<div class="player-row"><span class="rank">${i + 1}</span>` +
    `<span class="pname">${escapeHtml(p.pseudo)}${p.pseudo === ME ? " (toi)" : ""}</span>` +
    `<span class="pscore">${p.score}</span></div>`).join("");
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

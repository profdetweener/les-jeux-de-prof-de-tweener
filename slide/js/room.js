import { RoomConnection } from "../../shared/js/ws.js";

// ---------- Contexte ----------
const params = new URLSearchParams(location.search);
const CODE = (params.get("code") || "").toUpperCase();
const ME = (sessionStorage.getItem("slide_pseudo") || "").trim();
if (!CODE || ME.length < 3) { location.href = "join.html"; }

const $ = (id) => document.getElementById(id);
const colorFor = (i) => `hsl(${(i * 30) % 360} 60% 48%)`;
const colorDark = (i) => `hsl(${(i * 30) % 360} 60% 38%)`;

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
    <span class="swatch" style="background:${colorFor(p.color)}"></span>
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
  document.documentElement.style.setProperty("--n", N);
  document.documentElement.style.setProperty("--c", "clamp(38px," + Math.floor(86 / N) + "vw," + (N <= 4 ? 60 : N === 5 ? 54 : 46) + "px)");

  // Banniere de tour
  const mine = myTurn();
  $("turnBanner").className = "turn-banner" + (mine ? " mine" : "");
  $("turnBanner").innerHTML = mine
    ? "À toi de jouer"
    : `Au tour de <strong>${escapeHtml(game.activePseudo)}</strong>`;

  // Panneau des scores (objectif rappele)
  $("scorePanel").innerHTML = `<div class="score-goal">Objectif ${game.target}</div>` +
    players.map((p) => playerRow(p, { score: true, activePseudo: game.activePseudo })).join("");

  // Ensemble des cases encaissables -> cle du groupe
  const litKey = new Map();
  for (const g of game.lit) for (const c of g.cells) litKey.set(c.r + "," + c.c, g.key);
  const activeCol = game.activeColor;

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
    let cls = "cell", style = "";
    if (key) { cls += " lit"; style = `background:linear-gradient(160deg,${colorFor(activeCol)},${colorDark(activeCol)})`; }
    const claimable = mine && game.turnPhase === "claim" && key;
    html += `<div class="${cls}" data-r="${r}" data-c="${c}"${key ? ` data-key="${key}"` : ""} style="${style}">${card.value}</div>`;
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
}

function arw(t, idx, fs, g) { return `<button class="arrow" data-type="${t}" data-idx="${idx}" data-fs="${fs ? 1 : 0}">${g}</button>`; }

function renderFinished(m) {
  $("lobby").hidden = true; $("game").hidden = true; $("finished").hidden = false;
  const won = m.winner === ME;
  $("winTitle").textContent = won ? "Gagné !" : `${m.winner} l'emporte`;
  $("ranking").innerHTML = m.ranking.map((p, i) => `<div class="player-row"><span class="rank">${i + 1}</span>` +
    `<span class="swatch" style="background:${colorFor(p.color)}"></span>` +
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

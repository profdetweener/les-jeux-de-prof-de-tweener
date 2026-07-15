import { RoomConnection } from "../../shared/js/ws.js";

// ---------- Contexte ----------
const params = new URLSearchParams(location.search);
const CODE = (params.get("code") || "").toUpperCase();
const ME = (sessionStorage.getItem("mm_pseudo") || localStorage.getItem("mm_pseudo") || "").trim();
if (!CODE || ME.length < 3) { location.href = "join.html"; }
const ACTIVE_KEY = "mm_active";

const $ = (id) => document.getElementById(id);

const PALETTE = ["#c84545", "#4a6fa5", "#4a8c5a", "#d4a830", "#8a5fb0", "#2a9d8f",
                 "#e07a3f", "#c05a8f", "#3f7d9a", "#6b8e23", "#5b6bbf", "#b5843a"];
const colorOf = (i) => PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];
function tintOf(i) {
  const h = colorOf(i).replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},0.22)`;
}

// ---------- Etat ----------
let isHost = false;
let players = [];
let phase = "lobby";
let config = null;
let game = null;
let sel = null;
let startCfg = { mode: "commune", gridSize: 12, level: "moyen", duration: 300 };
let teamsOn = false;
let teamCount = 2;
let teamNames = [];
let toastTimer = null;
let timerInt = null;

const conn = new RoomConnection(CODE, "motsmeles");

function buildInviteUrl(code) {
  const url = new URL(location.href);
  url.pathname = url.pathname.replace(/room\.html$/, "join.html");
  url.search = ""; url.hash = code;
  return url.toString();
}
const inviteUrl = buildInviteUrl(CODE);
if ($("inviteUrl")) $("inviteUrl").textContent = inviteUrl;

conn.onStatus((s) => {
  const b = $("conn");
  if (s === "open") b.hidden = true;
  else if (s === "connecting") { b.hidden = false; b.textContent = "Connexion…"; }
  else { b.hidden = false; b.textContent = "Connexion perdue, reconnexion…"; }
});

conn.on("joined", (m) => {
  isHost = m.isHost; players = m.players; phase = m.phase; config = m.config; game = m.game;
  if (config && config.mode) startCfg.mode = config.mode;
  if (config) { teamsOn = !!config.teamsOn; teamCount = config.teamCount || 2; teamNames = config.teamNames || []; }
  try {
    localStorage.setItem("mm_pseudo", ME);
    localStorage.setItem(ACTIVE_KEY, JSON.stringify({ code: CODE, pseudo: ME, ts: Date.now() }));
  } catch {}
  render();
});
conn.on("room_state", (m) => { players = m.players; phase = m.phase; teamsOn = !!m.teamsOn; teamCount = m.teamCount || 2; teamNames = m.teamNames || []; render(); });
conn.on("game_state", (m) => { players = m.players; phase = m.phase; game = m.game; if (game) { teamsOn = !!game.teamsOn; teamNames = game.teamNames || []; } sel = null; render(); });
conn.on("found", (m) => {
  players = m.players;
  if (game) game.found.push(m.word);
  applyFound(m.word);
  updateScoreboard();
  const who = m.word.pseudo === ME ? "Toi" : m.word.pseudo;
  toast(`${who} : ${m.word.word}`);
  // En "chacun", grille vidée : il ne reste que les lettres du mystère.
  if (curMode() === "chacun" && m.remaining === 0) {
    const me = players.find((p) => p.pseudo === ME);
    if (me && !me.solvedMystery) setStatus("Grille terminée ! Il ne reste que le mot mystère.");
  }
});
conn.on("scores", (m) => { players = m.players; updateScoreboard(); });
// Résultat d'une tentative de mot mystère : la modale est forcément ouverte.
conn.on("mystery_result", (m) => {
  if (game) game.mysteryTriesLeft = m.triesLeft;
  $("mystMsg").textContent = m.message;
  $("mystMsg").className = "msg " + (m.ok ? "ok" : "err");
  if (m.ok) { toast("Mot mystère trouvé ! +3"); }
  refreshMystery();
  updateScoreboard();
});
conn.on("hint", (m) => setStatus(m.message, m.kind === "longer" ? "warn" : ""));
conn.on("finished", (m) => {
  players = m.players; phase = "finished"; game = null;
  stopTimer();
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
function normWord(s) { return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z]/g, ""); }
function fmtTime(sec) { sec = Math.max(0, sec); const m = Math.floor(sec / 60), s = sec % 60; return m + ":" + (s < 10 ? "0" : "") + s; }
function curMode() { return (game && game.mode) || (config && config.mode) || startCfg.mode; }

// ---------- Rendu principal ----------
function render() {
  $("lobby").hidden = phase !== "lobby";
  $("game").hidden = phase !== "playing";
  $("finished").hidden = phase !== "finished";
  const main = document.querySelector(".room-main");
  if (main) main.classList.toggle("in-game", phase === "playing");
  if (phase !== "playing") stopTimer();
  if (phase === "lobby") renderLobby();
  else if (phase === "playing") renderGame();
}

function teamNameOf(t) { return (teamNames && teamNames[t - 1]) || ("Équipe " + t); }

function lobbyPlayerRow(p) {
  const badges = [];
  if (p.isHost) badges.push('<span class="badge">hôte</span>');
  if (!p.isConnected) badges.push('<span class="badge off">hors ligne</span>');
  const name = `<span class="pname">${p.pseudo === ME ? "toi" : escapeHtml(p.pseudo)}</span>`;
  let team = "";
  if (teamsOn) {
    if (isHost) {
      const btns = [];
      for (let t = 1; t <= teamCount; t++) {
        const on = p.teamId === t;
        const style = on ? `background:${colorOf(t - 1)};border-color:${colorOf(t - 1)};color:#fff` : "";
        btns.push(`<button class="team-btn${on ? " on" : ""}" style="${style}" data-p="${encodeURIComponent(p.pseudo)}" data-t="${t}">${t}</button>`);
      }
      team = '<span class="team-pick">' + btns.join("") + "</span>";
    } else {
      const col = colorOf((p.teamId || 1) - 1);
      team = `<span class="badge team" style="border-color:${col};color:${col}">${escapeHtml(teamNameOf(p.teamId || 1))}</span>`;
    }
  }
  return `<div class="player-row">${name}${badges.join(" ")}${team}</div>`;
}

// Panneau hote : nombre d'equipes + noms.
function renderTeamConfig() {
  const box = $("teamConfig");
  if (!box) return;
  if (!isHost || !teamsOn || startCfg.mode !== "commune") { box.innerHTML = ""; box.hidden = true; return; }
  box.hidden = false;
  let html = `<div class="setup-row"><span class="setup-label">Nombre d'équipes</span>` +
    `<span class="stepper"><button id="teamMinus">−</button><b id="teamNb">${teamCount}</b><button id="teamPlus">+</button></span></div>`;
  html += '<div class="team-names">';
  for (let t = 1; t <= teamCount; t++) {
    html += `<div class="team-name-row"><span class="sb-dot" style="background:${colorOf(t - 1)}"></span>` +
      `<input class="team-name-input" data-t="${t}" maxlength="18" value="${escapeHtml(teamNameOf(t))}" placeholder="Équipe ${t}"></div>`;
  }
  html += "</div>";
  box.innerHTML = html;

  $("teamMinus").onclick = () => { if (teamCount > 2) conn.send({ type: "setTeamCount", n: teamCount - 1 }); };
  $("teamPlus").onclick = () => { if (teamCount < 8) conn.send({ type: "setTeamCount", n: teamCount + 1 }); };
  box.querySelectorAll(".team-name-input").forEach((inp) => {
    const send = () => conn.send({ type: "setTeamName", teamId: +inp.dataset.t, name: inp.value });
    inp.onchange = send;
    inp.onkeydown = (e) => { if (e.key === "Enter") inp.blur(); };
  });
}

function renderLobby() {
  $("lobbyPlayers").innerHTML = players.map(lobbyPlayerRow).join("");
  $("lobbyPlayers").querySelectorAll(".team-btn").forEach((b) => {
    b.onclick = () => conn.send({ type: "setTeam", pseudo: decodeURIComponent(b.dataset.p), teamId: +b.dataset.t });
  });
  const pc = $("playerCount"); if (pc) pc.textContent = players.length;

  const connected = players.filter((p) => p.isConnected).length;
  if (isHost) {
    $("hostControls").hidden = false;
    $("waitNote").hidden = true;
    wireSeg("modeSeg", (b) => { startCfg.mode = b.dataset.m; applyModeUI(); });
    wireSeg("sizeSeg", (b) => (startCfg.gridSize = +b.dataset.n));
    wireSeg("diffSeg", (b) => (startCfg.level = b.dataset.l));
    wireSeg("durSeg", (b) => (startCfg.duration = +b.dataset.d));
    const tseg = $("teamsSeg");
    if (tseg) tseg.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("on", (b.dataset.teams === "on") === teamsOn);
      b.onclick = () => conn.send({ type: "setTeamsMode", on: b.dataset.teams === "on" });
    });
    applyModeUI();
    renderTeamConfig();

    const teamsFilled = new Set(players.filter((p) => p.teamId >= 1).map((p) => p.teamId));
    let err = "";
    if (connected < 2) err = "Il faut au moins 2 joueurs connectés.";
    else if (teamsOn && teamsFilled.size < 2) err = "Répartis les joueurs dans au moins 2 équipes.";
    $("startBtn").disabled = !!err;
    $("startErr").textContent = err;
    $("startBtn").onclick = () => conn.send({ type: "start", mode: startCfg.mode, gridSize: startCfg.gridSize, level: startCfg.level, duration: startCfg.duration });
  } else {
    $("hostControls").hidden = true;
    $("waitNote").hidden = false;
  }
}

// Les equipes ne concernent que la grille commune ; la duree, que "chacun".
function applyModeUI() {
  const chacun = startCfg.mode === "chacun";
  if ($("durationRow")) $("durationRow").hidden = !chacun;
  if ($("teamsRow")) $("teamsRow").hidden = chacun;
  if ($("teamConfig")) $("teamConfig").hidden = chacun || !teamsOn;
  if (chacun && teamsOn) conn.send({ type: "setTeamsMode", on: false });
}

function wireSeg(id, apply) {
  const seg = $(id); if (!seg) return;
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

  if (curMode() === "chacun" && game.endsAt) startTimer(); else stopTimer();

  // La modale mystère ne s'ouvre plus toute seule : elle est à un clic de la
  // pastille du bandeau, quand le joueur le décide.
  closeMystery();
  if (curMode() === "commune") setStatus("");
}

function updateScoreboard() {
  if (!game) return;
  const chacun = curMode() === "chacun";
  const mine = game.found.length;
  const goal = chacun
    ? `Ta grille <b>${mine}</b> / ${game.totalWords} <span class="sb-timer" id="sbTimer"></span>${mysteryChip()}`
    : `Mots trouvés <b>${mine}</b> / ${game.totalWords}`;

  let chips;
  if (teamsOn) {
    // Agrégation par équipe (score cumulé).
    const agg = {};
    players.forEach((p) => {
      const t = p.teamId || 0; if (t < 1) return;
      (agg[t] = agg[t] || { teamId: t, score: 0, members: [] });
      agg[t].score += p.score; agg[t].members.push(p.pseudo);
    });
    const myTeam = (players.find((p) => p.pseudo === ME) || {}).teamId;
    chips = Object.values(agg).sort((a, b) => b.score - a.score).map((t) => {
      const me = t.teamId === myTeam;
      return `<div class="sb-chip${me ? " me" : ""}">` +
        `<span class="sb-dot" style="background:${colorOf(t.teamId - 1)}"></span>` +
        `<span class="sb-name">${escapeHtml(teamNameOf(t.teamId))}</span><b>${t.score}</b></div>`;
    }).join("");
  } else {
    chips = players.slice().sort((a, b) => b.score - a.score).map((p) => {
      const me = p.pseudo === ME;
      return `<div class="sb-chip${me ? " me" : ""}">` +
        `<span class="sb-dot" style="background:${colorOf(p.color)}"></span>` +
        `<span class="sb-name">${me ? "toi" : escapeHtml(p.pseudo)}</span>` +
        `<b>${p.score}</b>` +
        (p.solvedMystery ? " ⭐" : "") +
        (p.isConnected ? "" : ' <span class="badge off">off</span>') +
        `</div>`;
    }).join("");
  }

  $("scorePanel").innerHTML = `<div class="sb-goal">${goal}</div><div class="sb-players">${chips}</div>`;
  if (chacun) tickTimer();
}

// ---------- Minuteur (chacun) ----------
function startTimer() { if (timerInt) return; timerInt = setInterval(tickTimer, 1000); tickTimer(); }
function stopTimer() { if (timerInt) { clearInterval(timerInt); timerInt = null; } }
function tickTimer() {
  const el = $("sbTimer");
  if (!el || !game || !game.endsAt) return;
  const remaining = Math.round((game.endsAt - Date.now()) / 1000);
  el.textContent = "⏱ " + fmtTime(remaining);
  el.classList.toggle("low", remaining <= 30);
}

// ---------- Grille ----------
let cellEls = {};
let cellOwners = {};

function renderGrid() {
  const n = game.gridSize, g = game.grid;
  const grid = $("grid");
  grid.innerHTML = "";
  cellEls = {}; cellOwners = {};
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
  for (const w of game.found) addOwners(w);
  for (const key in cellOwners) paintCell(key);
}

function addOwners(w) {
  for (const cc of w.cells) {
    const key = cc.r + "," + cc.c;
    const arr = cellOwners[key] || (cellOwners[key] = []);
    if (!arr.includes(w.color)) arr.push(w.color);
  }
}
function applyFound(w) {
  addOwners(w);
  for (const cc of w.cells) paintCell(cc.r + "," + cc.c);
}
function paintCell(key) {
  const d = cellEls[key];
  if (!d) return;
  const owners = cellOwners[key];
  if (!owners || !owners.length) return;
  d.classList.add("found");
  if (owners.length === 1) {
    d.style.background = tintOf(owners[0]);
    d.style.color = colorOf(owners[0]);
  } else {
    const seg = 100 / owners.length;
    const stops = owners.map((cIdx, i) => `${tintOf(cIdx)} ${i * seg}% ${(i + 1) * seg}%`).join(", ");
    d.style.background = `linear-gradient(135deg, ${stops})`;
    d.style.color = "var(--bleu-nuit)";
  }
}

$("grid").addEventListener("click", (e) => {
  const cell = e.target.closest(".mm-cell");
  // Plus de garde sur game.mysteryOpen : le mystère est ouvert dès le
  // lancement, la grille reste jouable pendant toute la partie.
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
  const grid = $("grid"), n = game.gridSize;
  const avail = Math.min(grid.parentElement.clientWidth || 600, 600);
  const gap = 3, pad = 12;
  let c = Math.floor((avail - pad - gap * (n - 1)) / n);
  c = Math.max(18, Math.min(46, c));
  grid.style.setProperty("--c", c + "px");
  grid.style.setProperty("--n", n);
}
let _rz;
window.addEventListener("resize", () => { clearTimeout(_rz); _rz = setTimeout(sizeGrid, 120); });

// ---------- Mot mystère (chacun) ----------
// Le mystère est ouvert dès le lancement. Il n'occupe pas la page : une
// pastille dans le bandeau, et une modale à la demande.

function iSolvedMystery() {
  const me = players.find((p) => p.pseudo === ME);
  return !!(me && me.solvedMystery);
}
function triesLeft() {
  return game && typeof game.mysteryTriesLeft === "number" ? game.mysteryTriesLeft : 0;
}

function mysteryChip() {
  if (!game || !game.mysteryOpen) return "";
  if (iSolvedMystery()) return ` <button type="button" class="myst-chip done" id="mystChip">⭐ Mystère trouvé</button>`;
  const left = triesLeft();
  const len = game.mysteryLength ? game.mysteryLength + " lettres" : "";
  const cls = left > 0 ? "" : " spent";
  const essais = left > 0 ? left + (left > 1 ? " essais" : " essai") : "0 essai";
  return ` <button type="button" class="myst-chip${cls}" id="mystChip">⭐ Mystère · ${len} · ${essais}</button>`;
}

// Les lettres non barrées de MA grille, dans l'ordre de lecture (gauche à
// droite puis haut en bas). Le générateur garantit qu'aucun mot trouvable ne
// traverse le mystère : à grille vidée, cette chaîne EST le mot mystère.
function remainingLetters() {
  if (!game || !game.grid) return "";
  const taken = new Set();
  for (const w of game.found) for (const cc of w.cells) taken.add(cc.r + "," + cc.c);
  let out = "";
  for (let r = 0; r < game.gridSize; r++) {
    for (let c = 0; c < game.gridSize; c++) {
      if (!taken.has(r + "," + c)) out += game.grid[r][c];
    }
  }
  return out;
}

function openMystery() {
  if (!game || !game.mysteryOpen) return;
  $("mystDef").textContent = game.mysteryDefinition || "";
  refreshMystery();
  $("mystOverlay").hidden = false;
  const inp = $("mystInput");
  if (!inp.disabled) { inp.value = ""; inp.focus(); }
}
function closeMystery() {
  const o = $("mystOverlay");
  if (o) o.hidden = true;
}

// Rafraîchit le contenu de la modale (lettres, essais, état résolu).
function refreshMystery() {
  if (!game) return;
  const letters = remainingLetters();
  const solved = iSolvedMystery();
  const target = game.mysteryLength || 0;

  const box = $("mystLetters");
  box.textContent = letters;
  box.classList.toggle("solved", target > 0 && letters.length === target);

  // Au lancement, la chaîne vaut toute la grille : les lettres du mystère sont
  // noyées dans celles des mots pas encore trouvés. Elle se dégage à mesure.
  $("mystLettersLbl").textContent = target > 0 && letters.length === target
    ? "Il ne reste que le mystère."
    : `${letters.length} lettres restantes, dans l'ordre de lecture. Les ${target} du mystère sont dedans.`;

  const left = triesLeft();
  const done = solved || left <= 0;
  $("mystInput").disabled = done;
  $("mystSubmit").disabled = done;
  $("mystTries").textContent = solved
    ? "Bonus +3 empoché."
    : (left > 0 ? left + (left > 1 ? " essais restants." : " essai restant.") : "Plus d'essais.");
  if (solved && !$("mystMsg").textContent) {
    $("mystMsg").textContent = "Déjà trouvé ! +3 points.";
    $("mystMsg").className = "msg ok";
  }
}

function submitMystery() {
  const guess = normWord($("mystInput").value);
  if (!guess) return;
  conn.send({ type: "mysteryGuess", guess });
  $("mystInput").select();
}

// Le bandeau est re-rendu en innerHTML : on délègue le clic au conteneur.
$("scorePanel").addEventListener("click", (e) => {
  if (!e.target.closest("#mystChip")) return;
  $("mystMsg").textContent = ""; $("mystMsg").className = "msg";
  openMystery();
});
$("mystClose").onclick = closeMystery;
$("mystOverlay").addEventListener("click", (e) => { if (e.target === $("mystOverlay")) closeMystery(); });
$("mystSubmit").onclick = submitMystery;
$("mystInput").onkeydown = (e) => { if (e.key === "Enter") submitMystery(); };
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("mystOverlay") && !$("mystOverlay").hidden) closeMystery();
});

// ---------- Fin de partie ----------
function renderFinished(m) {
  $("lobby").hidden = true; $("game").hidden = true; $("finished").hidden = false;
  const main = document.querySelector(".room-main");
  if (main) main.classList.remove("in-game");
  const myTeam = (m.players.find((p) => p.pseudo === ME) || {}).teamId;
  const names = m.teamNames || [];
  const nameOf = (t) => names[t - 1] || ("Équipe " + t);
  const won = m.teamsOn ? (m.winner === nameOf(myTeam)) : (m.winner === ME);
  $("winTitle").innerHTML = won ? "🏆 Gagné !" : `🏆 ${escapeHtml(m.winner)} l'emporte`;
  const rev = $("mysteryReveal");
  if (m.mode === "chacun" && m.mysteryWord) {
    rev.innerHTML = `Le mot mystère était <b>${escapeHtml(m.mysteryWord)}</b>.`;
    rev.hidden = false;
  } else { rev.hidden = true; }

  const medals = ["🥇", "🥈", "🥉"];
  const tiers = ["gold", "silver", "bronze"];
  let rows;
  if (m.teamsOn) {
    const agg = {};
    m.players.forEach((p) => {
      const t = p.teamId || 0; if (t < 1) return;
      (agg[t] = agg[t] || { teamId: t, score: 0, members: [] });
      agg[t].score += p.score; agg[t].members.push(p.pseudo === ME ? "toi" : p.pseudo);
    });
    rows = Object.values(agg).sort((a, b) => b.score - a.score).map((t, i) => {
      const tier = tiers[i] || "";
      const badge = medals[i] || `<span class="rank-num">${i + 1}</span>`;
      return `<div class="rank-row${tier ? " " + tier : ""}">` +
        `<span class="rank-medal">${badge}</span>` +
        `<span class="sb-dot" style="background:${colorOf(t.teamId - 1)}"></span>` +
        `<span class="pname">${escapeHtml(nameOf(t.teamId))}</span>` +
        `<span class="rank-members">${t.members.map(escapeHtml).join(", ")}</span>` +
        `<span class="pscore">${t.score}</span></div>`;
    }).join("");
  } else {
    rows = m.ranking.map((p, i) => {
      const tier = tiers[i] || "";
      const badge = medals[i] || `<span class="rank-num">${i + 1}</span>`;
      return `<div class="rank-row${tier ? " " + tier : ""}">` +
        `<span class="rank-medal">${badge}</span>` +
        `<span class="pname">${p.pseudo === ME ? "toi" : escapeHtml(p.pseudo)}</span>` +
        (p.solvedMystery ? '<span class="myst-badge" title="A trouvé le mot mystère">⭐</span>' : "") +
        `<span class="pscore">${p.score}</span></div>`;
    }).join("");
  }
  $("ranking").innerHTML = rows;
  const lb = $("lobbyBtn");
  lb.hidden = !isHost;
  lb.onclick = () => conn.send({ type: "backToLobby" });
}

const copyBtn = $("copyBtn");
if (copyBtn) copyBtn.onclick = () => {
  navigator.clipboard?.writeText(inviteUrl);
  copyBtn.textContent = "Lien copié !";
  setTimeout(() => (copyBtn.textContent = "Copier le lien"), 1400);
};

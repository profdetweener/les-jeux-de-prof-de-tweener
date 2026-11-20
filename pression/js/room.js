/**
 * Pression, page de partie (salon, jeu, fin).
 *
 * La page de l'hote lit le tchat Twitch (IRC anonyme, shared/js/twitch.js) et
 * relaie au Worker : !join (inscriptions) et les mots. Le serveur arbitre tout
 * et n'accepte ces relais que de l'hote. Les autres connectes regardent.
 */

import { RoomConnection } from "../../shared/js/ws.js";
import { TwitchChat } from "../../shared/js/twitch.js";

// ---------- Contexte ----------
const params = new URLSearchParams(location.search);
const CODE = (params.get("code") || "").toUpperCase();
const ME = (sessionStorage.getItem("pr_pseudo") || localStorage.getItem("pr_pseudo") || "").trim();
if (!CODE || ME.length < 3) { location.href = "index.html"; }
const ACTIVE_KEY = "pr_active";
const CHANNEL_KEY = "pr_channel";
const CFG_KEY = "pr_cfg";
const SOUND_KEY = "pr_sound";

const $ = (id) => document.getElementById(id);

// Une couleur par equipe (memes teintes que Mots meles).
const PALETTE = ["#c84545", "#4a6fa5", "#4a8c5a", "#d4a830", "#8a5fb0", "#2a9d8f", "#e07a3f", "#c05a8f"];
const colorOf = (i) => PALETTE[Math.max(0, Math.floor(i) || 0) % PALETTE.length];

const RULE_LABEL = {
  contient: "CONTIENT",
  commence: "COMMENCE PAR",
  finit: "FINIT PAR",
  chaine: "CHAÎNE · COMMENCE PAR",
};
const RULE_HELP = {
  contient: "le mot doit contenir la syllabe",
  commence: "le mot doit commencer par la syllabe",
  finit: "le mot doit finir par la syllabe",
  chaine: "le mot doit commencer par la syllabe, et ses 2 dernières lettres deviennent la syllabe suivante",
};
const LEVEL_LABEL = { facile: "faciles", moyen: "moyennes", difficile: "difficiles" };

// ---------- Etat ----------
let isHost = false;
let hostPseudo = "";
let players = [];
let phase = "lobby";
let mode = "equipes";
let teamCount = 2;
let teamNames = [];
let game = null;
let prevSyllable = "";
let clockOffset = 0;
let feed = [];
let lastBlast = null;
let toastTimer = null;
let loopId = null;
let wasMyTurn = false;

const DEFAULT_CFG = {
  rules: ["contient"], level: "moyen", fuse: "moyenne", minTurnSec: 12,
  lives: 3, livesStreamer: 3, livesChat: 3, charge: 50,
};
let cfg = { ...DEFAULT_CFG };
try { cfg = { ...DEFAULT_CFG, ...(JSON.parse(localStorage.getItem(CFG_KEY) || "{}")) }; } catch {}
if (!Array.isArray(cfg.rules) || !cfg.rules.length) cfg.rules = ["contient"];
function saveCfg() { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch {} }

// ---------- Connexion ----------
const conn = new RoomConnection(CODE, "pression");

function buildInviteUrl(code) {
  const url = new URL(location.href);
  url.pathname = url.pathname.replace(/room\.html$/, "index.html");
  url.search = ""; url.hash = code;
  return url.toString();
}
const inviteUrl = buildInviteUrl(CODE);
$("inviteUrl").textContent = inviteUrl;

conn.onStatus((s) => {
  const b = $("conn");
  if (s === "open") b.hidden = true;
  else if (s === "connecting") { b.hidden = false; b.textContent = "Connexion…"; }
  else { b.hidden = false; b.textContent = "Connexion perdue, reconnexion…"; }
});

conn.on("joined", (m) => {
  isHost = m.isHost; hostPseudo = m.hostPseudo; players = m.players; phase = m.phase;
  mode = m.mode; teamCount = m.teamCount; teamNames = m.teamNames || [];
  game = m.game;
  if (game) setClock(game.serverNow);
  try {
    localStorage.setItem("pr_pseudo", ME);
    localStorage.setItem(ACTIVE_KEY, JSON.stringify({ code: CODE, pseudo: ME, ts: Date.now() }));
  } catch {}
  render();
});
conn.on("room_state", (m) => {
  const wasHost = isHost;
  players = m.players; hostPseudo = m.hostPseudo; mode = m.mode;
  teamCount = m.teamCount; teamNames = m.teamNames || [];
  isHost = hostPseudo === ME || players.some((p) => p.isHost && p.pseudo === ME);
  // Changement de phase (lancement, retour au salon) : on bascule d'ecran.
  // Au lancement, room_state arrive juste avant le premier game_state.
  if (m.phase !== phase) {
    phase = m.phase;
    if (phase === "playing") feed = [];
    else game = null;
    render();
    return;
  }
  if (phase === "playing") { if (wasHost !== isHost) render(); else renderGame(); }
  else if (phase === "lobby") render();
});
conn.on("game_state", (m) => {
  if (game && game.syllable !== m.game.syllable) prevSyllable = game.syllable;
  game = m.game;
  setClock(game.serverNow);
  if (phase !== "playing") { phase = "playing"; feed = []; render(); }
  if (m.event) handleEvent(m.event);
  renderGame();
});
conn.on("reject", (m) => {
  const why = m.reason === "used" ? "déjà joué" : "pas dans le dictionnaire";
  pushFeed("ko", `<span class="dot" style="background:${colorOf(m.teamId - 1)}"></span>` +
    `<span class="w">${esc(m.word)}</span> <span>${why}</span><span class="by">${esc(m.by)}</span>`);
  if (mode === "streamer" && isHost && m.teamId === 1) {
    const box = $("hostInput");
    box.classList.remove("bad"); void box.offsetWidth; box.classList.add("bad");
  }
  renderFeed();
});
conn.on("finished", (m) => {
  phase = "finished"; game = null;
  try { localStorage.removeItem(ACTIVE_KEY); } catch {}
  render();
  renderFinished(m);
});
conn.on("error", (m) => {
  const e = $("startErr"); if (e) e.textContent = m.message;
  toast(m.message);
});
conn.connect();
conn.send({ type: "join", pseudo: ME });

// ---------- Helpers ----------
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function toast(msg) {
  const el = $("toast");
  el.textContent = msg; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}
function setClock(serverNow) { if (serverNow) clockOffset = serverNow - Date.now(); }
function serverTime() { return Date.now() + clockOffset; }
function teamNameOf(t) { return teamNames[t - 1] || ("Équipe " + t); }
function gameTeam(id) { return game ? game.teams.find((t) => t.id === id) : null; }
function normWord(s) {
  return String(s || "").replace(/œ/g, "oe").replace(/Œ/g, "OE").replace(/æ/g, "ae").replace(/Æ/g, "AE")
    .normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z]/g, "");
}
function matchesRule(w, rule, syl) {
  if (!syl || w.length <= syl.length) return false;
  if (rule === "contient") return w.includes(syl);
  if (rule === "finit") return w.endsWith(syl);
  return w.startsWith(syl);
}

// ---------- Rendu principal ----------
function render() {
  $("lobby").hidden = phase !== "lobby";
  $("game").hidden = phase !== "playing";
  $("finished").hidden = phase !== "finished";
  if (phase === "lobby") renderLobby();
  if (phase === "playing") { renderGame(); startLoop(); } else stopLoop();
  syncRelay();
}

// ---------- Salon ----------
function lobbyViewerRow(p) {
  let team = "";
  if (isHost) {
    const btns = [];
    for (let t = 1; t <= teamCount; t++) {
      const on = p.teamId === t;
      const style = on ? `background:${colorOf(t - 1)};border-color:${colorOf(t - 1)};color:#fff` : "";
      btns.push(`<button class="team-btn" style="${style}" data-p="${encodeURIComponent(p.pseudo)}" data-t="${t}">${t}</button>`);
    }
    team = '<span class="team-pick">' + btns.join("") + "</span>";
  } else {
    const col = colorOf((p.teamId || 1) - 1);
    team = `<span class="badge team" style="border-color:${col};color:${col}">${esc(teamNameOf(p.teamId || 1))}</span>`;
  }
  return `<div class="player-row"><span class="pname">${esc(p.pseudo)}</span>${team}</div>`;
}

function renderLobby() {
  const viewers = players.filter((p) => p.isViewer);
  const spectators = players.filter((p) => !p.isViewer);

  if (mode === "equipes") {
    $("playersTitle").textContent = viewers.length + (viewers.length > 1 ? " inscrits" : " inscrit");
    $("viewerList").innerHTML = viewers.length
      ? viewers.map(lobbyViewerRow).join("")
      : '<p class="empty-note">Personne pour l\'instant. Les viewers tapent <b>!join</b> (ou <b>!join 2</b>) dans le tchat.</p>';
    $("viewerList").querySelectorAll(".team-btn").forEach((b) => {
      b.onclick = () => conn.send({ type: "setTeam", pseudo: decodeURIComponent(b.dataset.p), teamId: +b.dataset.t });
    });
  } else {
    $("playersTitle").textContent = "Joueurs";
    $("viewerList").innerHTML =
      `<p class="empty-note">${esc(hostPseudo || "Le streamer")} contre tout le tchat. Pas d'inscription : ` +
      "n'importe quel viewer peut répondre quand c'est au tchat.</p>";
  }
  $("spectatorList").innerHTML = spectators.map((p) =>
    `<div class="player-row"><span class="pname">${p.pseudo === ME ? "toi" : esc(p.pseudo)}</span>` +
    (p.isHost ? ' <span class="badge">hôte</span>' : "") +
    (p.isConnected ? "" : ' <span class="badge off">hors ligne</span>') + "</div>").join("");

  if (!isHost) {
    $("hostControls").hidden = true;
    $("waitNote").hidden = false;
    $("waitNote").textContent = mode === "equipes"
      ? "En attente que l'hôte lance la partie. Pour jouer, tape !join dans le tchat Twitch."
      : "En attente que l'hôte lance la partie. Le tchat Twitch jouera contre le streamer.";
    return;
  }
  $("hostControls").hidden = false;
  $("waitNote").hidden = true;

  // Mode
  $("modeSeg").querySelectorAll("button").forEach((b) => {
    b.classList.toggle("on", b.dataset.m === mode);
    b.onclick = () => { if (b.dataset.m !== mode) conn.send({ type: "setMode", mode: b.dataset.m }); };
  });

  renderTeamConfig(viewers);

  // Regles : au moins une cochee.
  $("rulesChips").querySelectorAll(".chip").forEach((b) => {
    b.classList.toggle("on", cfg.rules.includes(b.dataset.r));
    b.onclick = () => {
      const r = b.dataset.r;
      if (cfg.rules.includes(r)) { if (cfg.rules.length > 1) cfg.rules = cfg.rules.filter((x) => x !== r); }
      else cfg.rules = cfg.rules.concat(r);
      saveCfg(); renderLobby();
    };
  });
  wireSeg("levelSeg", "level", false);
  wireSeg("fuseSeg", "fuse", false);
  wireSeg("minTurnSeg", "minTurnSec", true);
  wireSeg("chargeSeg", "charge", true);
  renderLives();

  $("modeNote").textContent = mode === "equipes"
    ? "La cocotte passe d'équipe en équipe. N'importe quel membre de l'équipe qui la tient peut répondre dans le tchat. Le premier mot valide reçu la fait passer."
    : "La cocotte fait l'aller-retour entre toi et le tchat. Tu tapes tes mots sur cette page, le tchat répond dans le tchat. Tes propres messages dans le tchat sont ignorés.";

  let err = "";
  const filled = new Set(viewers.map((p) => p.teamId).filter((t) => t >= 1));
  if (!channelName()) err = "Indique la chaîne Twitch à écouter.";
  else if (mode === "equipes" && filled.size < 2) err = "Il faut des inscrits (!join) dans au moins 2 équipes.";
  $("startBtn").disabled = !!err;
  $("startErr").textContent = err;
  $("startBtn").onclick = () => {
    saveCfg();
    try { localStorage.setItem(CHANNEL_KEY, channelName()); } catch {}
    unlockAudio();
    conn.send({ type: "start", mode, config: cfg });
  };
}

function wireSeg(id, key, numeric) {
  const seg = $(id);
  seg.querySelectorAll("button").forEach((b) => {
    const v = numeric ? +b.dataset.v : b.dataset.v;
    b.classList.toggle("on", cfg[key] === v);
    b.onclick = () => { cfg[key] = v; saveCfg(); wireSeg(id, key, numeric); };
  });
}

function stepperRow(label, key) {
  return `<div class="setup-row"><span class="setup-label">${label}</span>` +
    `<span class="stepper"><button data-k="${key}" data-d="-1">−</button><b>${cfg[key]}</b>` +
    `<button data-k="${key}" data-d="1">+</button></span></div>`;
}
function renderLives() {
  const box = $("livesRows");
  box.innerHTML = mode === "equipes"
    ? stepperRow("Vies par équipe", "lives")
    : stepperRow("Tes vies", "livesStreamer") + stepperRow("Vies du tchat", "livesChat");
  box.querySelectorAll("button").forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.k;
      cfg[k] = Math.max(1, Math.min(6, cfg[k] + (+b.dataset.d)));
      saveCfg(); renderLives();
    };
  });
}

function renderTeamConfig(viewers) {
  const box = $("teamConfig");
  if (mode !== "equipes") { box.innerHTML = ""; return; }
  const counts = {};
  viewers.forEach((p) => { counts[p.teamId] = (counts[p.teamId] || 0) + 1; });
  let html = `<div class="setup-row"><span class="setup-label">Nombre d'équipes</span>` +
    `<span class="stepper"><button id="teamMinus">−</button><b>${teamCount}</b><button id="teamPlus">+</button></span></div>`;
  html += '<div class="team-names">';
  for (let t = 1; t <= teamCount; t++) {
    const n = counts[t] || 0;
    html += `<div class="team-name-row"><span class="dot" style="background:${colorOf(t - 1)}"></span>` +
      `<input class="team-name-input" data-t="${t}" maxlength="18" value="${esc(teamNameOf(t))}" placeholder="Équipe ${t}">` +
      `<span class="count">${n} ${n > 1 ? "joueurs" : "joueur"}</span></div>`;
  }
  html += "</div>";
  html += `<div class="setup-row"><span class="setup-label">Les viewers choisissent avec !join 1, !join 2…</span>` +
    `<button class="btn btn-ghost btn-sm" id="shuffleBtn">Répartir au hasard</button></div>`;
  box.innerHTML = html;
  $("shuffleBtn").onclick = () => conn.send({ type: "shuffleTeams" });
  $("teamMinus").onclick = () => { if (teamCount > 2) conn.send({ type: "setTeamCount", n: teamCount - 1 }); };
  $("teamPlus").onclick = () => { if (teamCount < 8) conn.send({ type: "setTeamCount", n: teamCount + 1 }); };
  box.querySelectorAll(".team-name-input").forEach((inp) => {
    inp.onchange = () => conn.send({ type: "setTeamName", teamId: +inp.dataset.t, name: inp.value });
    inp.onkeydown = (e) => { if (e.key === "Enter") inp.blur(); };
  });
}

// ---------- Jeu ----------
function pushFeed(cls, html) {
  feed.unshift({ cls, html });
  if (feed.length > 7) feed.length = 7;
}
function renderFeed() {
  $("feed").innerHTML = feed.map((f) => `<div class="item ${f.cls}">${f.html}</div>`).join("");
}

function handleEvent(ev) {
  if (ev.kind === "manche") {
    lastBlast = null;
    pushFeed("info", `Manche ${game.manche} : ${esc(RULE_LABEL[game.rule].toLowerCase())} <b>${esc(game.syllable)}</b>`);
    sound("manche");
  } else if (ev.kind === "pass") {
    pushFeed("ok", `<span class="dot" style="background:${colorOf(ev.teamId - 1)}"></span>` +
      `<span class="w">${esc(ev.word)}</span><span class="by">${esc(ev.by)} · +${ev.word.length}</span>`);
    if (ev.bonus) {
      const t = gameTeam(ev.teamId);
      pushFeed("info", `Boîte pleine : +1 vie pour ${esc(t ? t.name : "")} !`);
      toast("Boîte pleine : +1 vie !");
      sound("bonus");
    } else sound("pass");
    if (ev.chainBroken) pushFeed("info", "Chaîne cassée (trop peu de mots possibles), nouvelle syllabe.");
    flashTeam(ev.teamId);
  } else if (ev.kind === "explode") {
    lastBlast = ev;
    const t = gameTeam(ev.teamId);
    const name = t ? t.name : "";
    pushFeed("info", ev.eliminated ? `💥 ${esc(name)} est éliminée !` : `💥 Ça a sauté chez ${esc(name)} : une vie en moins.`);
    const st = $("stage");
    st.classList.remove("boom"); void st.offsetWidth; st.classList.add("boom");
    setTimeout(() => st.classList.remove("boom"), 1600);
    sound("boom");
  }
  renderFeed();
}

function flashTeam(id) {
  const el = document.querySelector(`.ct-team[data-t="${id}"]`);
  if (!el) return;
  el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
}

function renderGame() {
  if (!game) return;
  const holder = gameTeam(game.holder);
  const inter = game.interUntil !== null;

  $("ruleBar").innerHTML = `<span>Manche <b>${game.manche}</b></span>` +
    `<span class="rule">${RULE_LABEL[game.rule]}</span>` +
    `<span>syllabes ${LEVEL_LABEL[game.level] || ""} · <b>${game.usedCount}</b> mots joués</span>`;

  const label = $("potLabel");
  label.textContent = inter ? "" : game.syllable;
  label.setAttribute("font-size", game.syllable.length > 2 ? "48" : "56");
  $("potBand").style.fill = holder ? colorOf(holder.color) : "";

  // Qui tient la cocotte.
  const myTurn = mode === "streamer" && isHost && game.holder === 1 && !inter;
  if (inter) $("turn").innerHTML = "";
  else if (myTurn) $("turn").innerHTML = `<span class="who" style="background:${colorOf(0)}">À toi !</span> ${esc(RULE_HELP[game.rule])}`;
  else if (holder) $("turn").innerHTML = `Au tour de <span class="who" style="background:${colorOf(holder.color)}">${esc(holder.name)}</span>`;

  // Pause entre deux manches.
  $("inter").hidden = !inter;
  if (inter) {
    const t = lastBlast ? gameTeam(lastBlast.teamId) : null;
    $("interBig").textContent = lastBlast
      ? (lastBlast.eliminated ? `💥 ${t ? t.name : ""} éliminée !` : `💥 Ça a sauté chez ${t ? t.name : ""} !`)
      : "💥 Ça a sauté !";
  }

  // Equipes.
  $("teams").innerHTML = game.teams.map((t) => {
    const col = colorOf(t.color);
    let lives = "";
    for (let i = 0; i < Math.max(t.lives, 0); i++) lives += '<span class="life full"></span>';
    const pct = Math.min(100, Math.round((t.charge / game.chargeMax) * 100));
    const isHolder = t.id === game.holder && !inter && t.alive;
    const members = mode === "equipes"
      ? `${t.members} ${t.members > 1 ? "joueurs" : "joueur"}`
      : (t.id === 1 ? "streamer" : `${t.members} ${t.members > 1 ? "viewers" : "viewer"}`);
    return `<div class="ct-team${isHolder ? " holder" : ""}${t.alive ? "" : " out"}" data-t="${t.id}"` +
      ` style="border-color:${isHolder ? col : "var(--gris-clair)"}">` +
      `<div class="tname"><span class="dot" style="background:${col}"></span>${esc(t.name)}<span class="members">${members}</span></div>` +
      `<div class="lives" style="color:${col}" title="${t.lives} vie(s)">${lives}</div>` +
      `<div class="charge" title="Boîte de chargement"><span style="width:${pct}%;background:${col}"></span></div>` +
      `<div class="charge-lbl">Charge ${t.charge} / ${game.chargeMax}</div></div>`;
  }).join("");

  // Saisie du streamer.
  const hi = $("hostInput");
  hi.hidden = !(mode === "streamer" && isHost);
  const inp = $("hostWord");
  inp.disabled = !myTurn;
  $("hostSend").disabled = !myTurn;
  if (myTurn && !wasMyTurn) { inp.value = ""; inp.focus(); }
  wasMyTurn = myTurn;

  $("help").textContent = mode === "equipes"
    ? "Répondez dans le tchat Twitch, un mot par message. Pas encore inscrit ? Tape !join (ou !join 2)."
    : "Le tchat répond dans le tchat Twitch, un mot par message.";

  const eg = $("endGameBtn");
  eg.hidden = !isHost;
  eg.onclick = () => { if (confirm("Terminer la partie maintenant ?")) conn.send({ type: "endGame" }); };

  renderFeed();
}

// Saisie du streamer.
function sendHostWord() {
  const inp = $("hostWord");
  const w = inp.value.trim();
  if (!w || inp.disabled) return;
  conn.send({ type: "hostWord", word: w });
  inp.select();
}
$("hostSend").onclick = sendHostWord;
$("hostWord").onkeydown = (e) => { if (e.key === "Enter") sendHostWord(); };

// ---------- Manometre (boucle d'animation) ----------
const DIAL = { cx: 214, cy: 66 };
(function drawDial() {
  const g = $("dialTicks");
  const pt = (deg, r) => {
    const a = (deg * Math.PI) / 180;
    return [DIAL.cx + r * Math.sin(a), DIAL.cy - r * Math.cos(a)];
  };
  let html = "";
  for (let d = -120; d <= 120; d += 30) {
    const [x1, y1] = pt(d, 13), [x2, y2] = pt(d, 17);
    html += `<line class="dial-tick" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
  }
  const [ax, ay] = pt(75, 15.5), [bx, by] = pt(120, 15.5);
  html += `<path d="M ${ax.toFixed(1)} ${ay.toFixed(1)} A 15.5 15.5 0 0 1 ${bx.toFixed(1)} ${by.toFixed(1)}" stroke="#c84545" stroke-width="3.5" fill="none"/>`;
  g.innerHTML = html;
})();

function frame() {
  loopId = requestAnimationFrame(frame);
  if (!game) return;
  const st = $("stage");
  const now = serverTime();
  let p;
  if (game.interUntil !== null) {
    p = 1;
    const s = Math.max(0, Math.ceil((game.interUntil - now) / 1000));
    $("interSmall").textContent = `Nouvelle manche dans ${s} s`;
    st.classList.remove("cooking", "hot");
  } else {
    p = Math.max(0, Math.min(1, (now - game.fuseStartAt) / game.fuseMaxMs));
    st.classList.add("cooking");
    st.classList.toggle("hot", p > 0.75);
    st.style.setProperty("--steam-speed", (2.4 - 1.8 * p).toFixed(2) + "s");
  }
  $("needle").setAttribute("transform", `rotate(${(-120 + 240 * p).toFixed(1)} ${DIAL.cx} ${DIAL.cy})`);
}
function startLoop() { if (!loopId) loopId = requestAnimationFrame(frame); }
function stopLoop() { if (loopId) { cancelAnimationFrame(loopId); loopId = null; } }

// ---------- Fin ----------
function renderFinished(m) {
  const medals = ["🥇", "🥈", "🥉"];
  const tiers = ["gold", "silver", "bronze"];
  if (m.mode === "streamer") {
    $("winTitle").textContent = m.winnerTeamId === 1 ? `🏆 ${m.hostPseudo || "Le streamer"} l'emporte !` : "🏆 Le tchat l'emporte !";
  } else {
    $("winTitle").textContent = `🏆 ${m.winnerName} l'emporte !`;
  }
  let note = `${m.totalWords} ${m.totalWords > 1 ? "mots joués" : "mot joué"}.`;
  if (m.longest) note += ` Mot le plus long : <b>${esc(m.longest.word)}</b> (${esc(m.longest.by)}, ${m.longest.word.length} lettres).`;
  $("endNote").innerHTML = note;

  $("ranking").innerHTML = m.teams.map((t, i) => {
    const tier = tiers[i] || "";
    const badge = medals[i] || `<span class="rank-num">${i + 1}</span>`;
    const detail = t.alive ? `${t.lives} ${t.lives > 1 ? "vies restantes" : "vie restante"}` : "éliminée";
    return `<div class="rank-row${tier ? " " + tier : ""}"><span class="rank-medal">${badge}</span>` +
      `<span class="dot" style="background:${colorOf(t.color)}"></span>` +
      `<span class="pname">${esc(t.name)}</span><span class="detail">${detail}</span></div>`;
  }).join("");

  $("topTitle").hidden = !m.top.length;
  $("top").innerHTML = m.top.map((v, i) =>
    `<div class="rank-row"><span class="rank-medal"><span class="rank-num">${i + 1}</span></span>` +
    `<span class="dot" style="background:${colorOf(v.teamId - 1)}"></span>` +
    `<span class="pname">${esc(v.name)}</span>` +
    `<span class="detail">${v.letters} lettres</span>` +
    `<span class="pscore">${v.words} ${v.words > 1 ? "mots" : "mot"}</span></div>`).join("");

  const lb = $("lobbyBtn");
  lb.hidden = !isHost;
  lb.onclick = () => conn.send({ type: "backToLobby" });
}

// ---------- Tchat Twitch (hote) ----------
let chat = null;
const savedChannel = (localStorage.getItem(CHANNEL_KEY) || "").trim();
if (savedChannel) $("channelInput").value = savedChannel;
$("channelInput").addEventListener("change", () => {
  try { localStorage.setItem(CHANNEL_KEY, channelName()); } catch {}
  syncRelay(true);
  if (phase === "lobby") renderLobby();
});

function channelName() {
  const v = $("channelInput").value.toLowerCase().replace(/^#/, "").trim();
  return v || (localStorage.getItem(CHANNEL_KEY) || "").trim();
}

const JOIN_RE = /^!join(?:\s+(\d+))?\s*$/i;
function parseJoin(text) {
  const m = JOIN_RE.exec(text);
  return m ? { team: m[1] ? parseInt(m[1], 10) : 0 } : null;
}
function looksLikeWord(t) {
  if (!t || t.startsWith("!") || /\s/.test(t)) return false;
  if (t.length < 3 || t.length > 30) return false;
  return /^[\p{L}'-]+$/u.test(t);
}

const DOT_CLASS = { wait: "connecting", on: "open", err: "error" };
function setChatStatus(state, text) {
  const box = $("chatStatus");
  box.hidden = false;
  box.querySelector(".dot").className = "dot " + (DOT_CLASS[state] || "");
  $("chatStatusText").textContent = text;
}

// Connexion IRC idempotente : on ne la refait que si la chaine change. Un
// render (a chaque !join par exemple) ne doit pas couper le tchat.
function syncRelay(force) {
  const ch = channelName();
  const want = isHost && !!ch && phase !== "finished";
  if (!want) { stopRelay(); return; }
  if (chat && chat.channel === ch && !force) return;
  stopRelay();
  chat = new TwitchChat(ch);
  chat.on("status", (s) => setChatStatus(s.state, s.text));
  chat.on("message", onChatMessage);
  chat.connect();
}
function stopRelay() {
  if (chat) { chat.close(); chat = null; }
  $("chatStatus").hidden = true;
}

function onChatMessage(m) {
  const text = String(m.text || "").trim();
  if (mode === "equipes") {
    const j = parseJoin(text);
    if (j) { conn.send({ type: "chatJoin", viewer: m.name, team: j.team }); return; }
  }
  if (phase !== "playing" || !game || game.interUntil !== null) return;
  // En streamer, le streamer joue sur sa page : ses messages du tchat ne comptent pas.
  if (mode === "streamer" && chat && m.name.toLowerCase() === chat.channel) return;
  if (!looksLikeWord(text)) return;
  // Pre-filtre : seuls les mots qui respectent la regle partent au serveur.
  // On tolere l'avant-derniere syllabe, le temps que l'etat se mette a jour.
  const w = normWord(text);
  if (!matchesRule(w, game.rule, game.syllable) && !matchesRule(w, game.rule, prevSyllable)) return;
  conn.send({ type: "chatWord", viewer: m.name, word: text });
}

// ---------- Son (WebAudio, aucun fichier) ----------
let soundOn = localStorage.getItem(SOUND_KEY) !== "off";
let actx = null;
function renderSoundBtn() { $("soundBtn").textContent = soundOn ? "🔊" : "🔇"; }
renderSoundBtn();
$("soundBtn").onclick = () => {
  soundOn = !soundOn;
  try { localStorage.setItem(SOUND_KEY, soundOn ? "on" : "off"); } catch {}
  renderSoundBtn();
  unlockAudio();
};
function unlockAudio() {
  if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { actx = null; } }
  if (actx && actx.state === "suspended") actx.resume();
}
document.addEventListener("pointerdown", unlockAudio, { once: true });

function tone(freq, start, dur, vol, type) {
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type || "sine"; o.frequency.value = freq;
  g.gain.setValueAtTime(vol, actx.currentTime + start);
  g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + start + dur);
  o.connect(g).connect(actx.destination);
  o.start(actx.currentTime + start); o.stop(actx.currentTime + start + dur + 0.02);
}
function noise(dur, vol) {
  const len = Math.floor(actx.sampleRate * dur);
  const buf = actx.createBuffer(1, len, actx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = actx.createBufferSource(), f = actx.createBiquadFilter(), g = actx.createGain();
  src.buffer = buf; f.type = "lowpass"; f.frequency.value = 900; g.gain.value = vol;
  src.connect(f).connect(g).connect(actx.destination);
  src.start();
}
function sound(kind) {
  if (!soundOn || !actx || actx.state !== "running") return;
  if (kind === "pass") tone(880, 0, 0.09, 0.12, "triangle");
  else if (kind === "bonus") { tone(660, 0, 0.1, 0.12, "triangle"); tone(990, 0.1, 0.16, 0.12, "triangle"); }
  else if (kind === "manche") tone(520, 0, 0.12, 0.08, "sine");
  else if (kind === "boom") { noise(0.7, 0.45); tone(90, 0, 0.4, 0.25, "sine"); }
}

// ---------- Divers ----------
$("copyBtn").onclick = () => {
  navigator.clipboard?.writeText(inviteUrl);
  $("copyBtn").textContent = "Lien copié !";
  setTimeout(() => ($("copyBtn").textContent = "Copier le lien"), 1400);
};

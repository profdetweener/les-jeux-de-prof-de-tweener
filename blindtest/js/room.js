/**
 * Blind Test en navigateur : salon, partie et fin.
 *
 * Le serveur choisit les morceaux et verifie les reponses. Chaque page joue
 * l'extrait au moment indique par le serveur (heure de depart commune), et
 * le joueur tape ses reponses dans sa case : personne ne voit les reponses
 * des autres, seulement qui a trouve quoi.
 */

import { RoomConnection } from "../../shared/js/ws.js";

// ---------- Contexte ----------
const params = new URLSearchParams(location.search);
const CODE = (params.get("code") || "").toUpperCase();
const ME = (sessionStorage.getItem("bt_pseudo") || localStorage.getItem("bt_pseudo") || "").trim();
if (!CODE) location.href = "index.html";
else if (ME.length < 3) location.href = `join.html#${encodeURIComponent(CODE)}`;
const ACTIVE_KEY = "bt_active";
const CFG_KEY = "bt_nav_cfg";
const VOL_KEY = "bt_volume";

const $ = (id) => document.getElementById(id);
const PALETTE = ["#c84545", "#4a6fa5", "#4a8c5a", "#d4a830", "#8a5fb0", "#2a9d8f", "#e07a3f", "#c05a8f"];
const colorOf = (i) => PALETTE[Math.max(0, Math.floor(i) || 0) % PALETTE.length];

// ---------- Etat ----------
let isHost = false;
let hostPseudo = "";
let players = [];
let phase = "lobby";
let solo = true;
let teamCount = 2;
let teamNames = [];
let decades = [];
let game = null;
let clockOffset = 0;
let toastTimer = null;
let loopId = null;
let prevScores = new Map();   // pour detecter qui vient de trouver
let feed = [];
let lastRoundKey = "";

const DEFAULT_CFG = { rounds: 10, duration: 20, tolerance: 20, pop: 75, decades: [], scoring: "temps" };
let cfg = { ...DEFAULT_CFG };
try { cfg = { ...DEFAULT_CFG, ...(JSON.parse(localStorage.getItem(CFG_KEY) || "{}")) }; } catch {}
if (!Array.isArray(cfg.decades)) cfg.decades = [];
function saveCfg() { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch {} }

// ---------- Connexion ----------
const conn = new RoomConnection(CODE, "blindtest");

conn.onStatus((s) => {
  const b = $("conn");
  if (s === "open") b.hidden = true;
  else if (s === "connecting") { b.hidden = false; b.textContent = "Connexion…"; }
  else { b.hidden = false; b.textContent = "Connexion perdue, reconnexion…"; }
});

conn.on("joined", (m) => {
  isHost = m.isHost; hostPseudo = m.hostPseudo; players = m.players; phase = m.phase;
  solo = !!m.solo; teamCount = m.teamCount; teamNames = m.teamNames || [];
  decades = m.decades || [];
  game = m.game;
  if (game) setClock(game.serverNow);
  try {
    localStorage.setItem("bt_pseudo", ME);
    localStorage.setItem(ACTIVE_KEY, JSON.stringify({ code: CODE, pseudo: ME, ts: Date.now() }));
  } catch {}
  render();
});
conn.on("room_state", (m) => {
  players = m.players; hostPseudo = m.hostPseudo;
  solo = !!m.solo; teamCount = m.teamCount; teamNames = m.teamNames || [];
  isHost = hostPseudo === ME;
  if (m.phase !== phase) {
    if (m.phase === "finished") return;   // l'ecran de fin arrive avec "finished"
    phase = m.phase;
    if (phase !== "playing") game = null;
    render();
    return;
  }
  if (phase === "lobby") renderLobby();
  else if (phase === "playing") $("hostBtns").hidden = !isHost;
});
conn.on("game_state", (m) => {
  setClock(m.game.serverNow);
  const firstGame = phase !== "playing";
  game = m.game;
  if (firstGame) { phase = "playing"; render(); }
  else renderGame();
});
conn.on("answer_result", (m) => {
  const fb = $("feedback");
  const inp = $("answerInput");
  if (m.ok) {
    const parts = [];
    if (m.title) parts.push(`titre +${m.title.pts}`);
    if (m.artist) parts.push(`artiste +${m.artist.pts}`);
    fb.className = "bt-feedback ok";
    fb.textContent = "✓ Bien vu : " + parts.join(", ");
    inp.value = "";
    $("answerForm").classList.remove("bad");
    sound("ok");
  } else {
    fb.className = "bt-feedback ko";
    fb.textContent = "✗ Ce n'est pas ça";
    inp.select();
    const f = $("answerForm");
    f.classList.remove("bad"); void f.offsetWidth; f.classList.add("bad");
  }
});
conn.on("finished", (m) => {
  phase = "finished";
  hostPseudo = m.hostPseudo;
  isHost = hostPseudo === ME;
  stopAudio();
  stopLoop();
  renderFinished(m);
  showSection("finished");
});
conn.on("error", (m) => {
  if (m.code === "ROOM_FULL") {
    conn.close();
    try { sessionStorage.setItem("bt_full", m.message); localStorage.removeItem(ACTIVE_KEY); } catch {}
    location.href = `join.html#${encodeURIComponent(CODE)}`;
    return;
  }
  const e = $("startErr"); if (e && phase === "lobby") e.textContent = m.message;
  toast(m.message);
});

conn.connect();
conn.send({ type: "join", pseudo: ME });

// ---------- Helpers ----------
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}
function setClock(serverNow) { if (serverNow) clockOffset = serverNow - Date.now(); }
function serverTime() { return Date.now() + clockOffset; }
function teamNameOf(t) { return teamNames[t - 1] || `Équipe ${t}`; }
const sec = (t) => String(t).replace(".", ",") + " s";
function showSection(id) {
  for (const s of ["lobby", "game", "finished"]) $(s).hidden = s !== id;
}

// Lien canonique : join.html#CODE.
const INVITE_URL = (() => {
  const u = new URL(location.href);
  u.pathname = u.pathname.replace(/room\.html$/, "join.html");
  u.search = ""; u.hash = CODE;
  return u.toString();
})();
$("inviteUrl").textContent = INVITE_URL;
$("copyBtn").onclick = async () => {
  try { await navigator.clipboard.writeText(INVITE_URL); toast("Lien copié !"); }
  catch { toast("Impossible de copier, sélectionne le lien à la main."); }
};

function render() {
  if (phase === "lobby") { stopAudio(); stopLoop(); showSection("lobby"); renderLobby(); }
  else if (phase === "playing") { showSection("game"); renderGame(); startLoop(); }
}

// ---------- Salon ----------
function teamPicker(p) {
  let h = '<span class="team-pick">';
  for (let t = 1; t <= teamCount; t++) {
    const on = p.teamId === t;
    const st = on ? `background:${colorOf(t - 1)};border-color:${colorOf(t - 1)};color:#fff` : "";
    h += `<button class="team-btn" style="${st}" data-p="${encodeURIComponent(p.pseudo)}" data-t="${t}">${t}</button>`;
  }
  return h + "</span>";
}
function playerRow(p) {
  const host = p.isHost ? ' <span class="badge">hôte</span>' : "";
  const me = p.pseudo === ME ? ' <span class="badge">toi</span>' : "";
  let team = "";
  if (!solo) {
    if (isHost) team = teamPicker(p);
    else {
      const col = colorOf((p.teamId || 1) - 1);
      team = `<span class="badge team" style="border-color:${col};color:${col}">${esc(teamNameOf(p.teamId || 1))}</span>`;
    }
  }
  return `<div class="player-row"><span class="pname">${esc(p.pseudo)}</span>${host}${me}${team}</div>`;
}

// Reglages a boutons - / + : paliers.
const STEPS = {
  rounds: { label: "Manches", values: [3, 5, 10, 15, 20, 25, 30, 40, 50], fmt: (v) => `${v}` },
  duration: { label: "Durée d'un extrait", values: [10, 15, 20, 25, 30], fmt: (v) => `${v} s` },
  tolerance: { label: "Tolérance aux fautes", values: [0, 5, 10, 15, 20, 25, 30, 35, 40], fmt: (v) => `${v} %` },
};
function renderSteps() {
  const box = $("stepRows");
  box.innerHTML = Object.entries(STEPS).map(([k, st]) => {
    const i = st.values.indexOf(cfg[k]);
    return `<div class="setup-row"><span class="setup-label">${st.label}</span>` +
      `<span class="stepper"><button data-k="${k}" data-d="-1"${i <= 0 ? " disabled" : ""}>−</button>` +
      `<b class="unit">${st.fmt(cfg[k])}</b>` +
      `<button data-k="${k}" data-d="1"${i >= st.values.length - 1 ? " disabled" : ""}>+</button></span></div>`;
  }).join("");
  box.querySelectorAll("button").forEach((b) => {
    b.onclick = () => {
      const st = STEPS[b.dataset.k];
      const i = Math.max(0, st.values.indexOf(cfg[b.dataset.k])) + Number(b.dataset.d);
      if (i < 0 || i >= st.values.length) return;
      cfg[b.dataset.k] = st.values[i];
      saveCfg(); renderSteps();
    };
  });
}
// Valeurs gardees d'une partie a l'autre : on les ramene sur un palier.
for (const [k, st] of Object.entries(STEPS)) {
  if (!st.values.includes(cfg[k])) cfg[k] = DEFAULT_CFG[k];
}

function wireSeg(id, get, set) {
  $(id).querySelectorAll("button").forEach((b) => {
    b.classList.toggle("on", String(get()) === b.dataset.v);
    b.onclick = () => { set(b.dataset.v); };
  });
}

function renderTeamConfig(list) {
  const box = $("teamConfig");
  if (solo) { box.innerHTML = ""; return; }
  const counts = {};
  list.forEach((p) => { counts[p.teamId] = (counts[p.teamId] || 0) + 1; });
  let html = `<div class="setup-row"><span class="setup-label">Nombre d'équipes</span>` +
    `<span class="stepper"><button id="teamMinus"${teamCount <= 2 ? " disabled" : ""}>−</button><b>${teamCount}</b>` +
    `<button id="teamPlus"${teamCount >= 8 ? " disabled" : ""}>+</button></span></div><div class="team-names">`;
  for (let t = 1; t <= teamCount; t++) {
    const n = counts[t] || 0;
    html += `<div class="team-name-row"><span class="dot" style="background:${colorOf(t - 1)}"></span>` +
      `<input class="team-name-input" data-t="${t}" maxlength="18" value="${esc(teamNameOf(t))}" placeholder="Équipe ${t}">` +
      `<span class="count">${n} ${n > 1 ? "joueurs" : "joueur"}</span></div>`;
  }
  html += `</div><div class="setup-row"><span class="setup-label">Les nouveaux arrivent dans l'équipe la moins remplie. Clique sur un numéro pour déplacer un joueur.</span>` +
    `<button class="btn btn-ghost btn-sm" id="shuffleBtn">Répartir au hasard</button></div>`;
  box.innerHTML = html;
  $("shuffleBtn").onclick = () => conn.send({ type: "shuffleTeams" });
  $("teamMinus").onclick = () => conn.send({ type: "setTeamCount", n: teamCount - 1 });
  $("teamPlus").onclick = () => conn.send({ type: "setTeamCount", n: teamCount + 1 });
  box.querySelectorAll(".team-name-input").forEach((inp) => {
    inp.onchange = () => conn.send({ type: "setTeamName", teamId: +inp.dataset.t, name: inp.value });
    inp.onkeydown = (e) => { if (e.key === "Enter") inp.blur(); };
  });
}

function renderLobby() {
  const list = players;
  $("playersTitle").textContent = list.length + (list.length > 1 ? " joueurs" : " joueur");
  $("playerList").innerHTML = list.map(playerRow).join("") +
    (list.length < 2 ? '<p class="empty-note">Envoie le lien d\'invitation aux autres joueurs.</p>' : "");
  $("playerList").querySelectorAll(".team-btn").forEach((b) => {
    b.onclick = () => conn.send({ type: "setTeam", pseudo: decodeURIComponent(b.dataset.p), teamId: +b.dataset.t });
  });

  if (!isHost) { $("hostControls").hidden = true; $("waitNote").hidden = false; return; }
  $("hostControls").hidden = false;
  $("waitNote").hidden = true;

  wireSeg("soloSeg", () => (solo ? "solo" : "teams"), (v) => {
    const s = v === "solo";
    if (s !== solo) conn.send({ type: "setSolo", solo: s });
  });
  renderTeamConfig(list);
  wireSeg("scoringSeg", () => cfg.scoring, (v) => { cfg.scoring = v; saveCfg(); renderLobby(); });
  $("scoringNote").textContent = cfg.scoring === "rang"
    ? "Titre : 10, 8, 6, 4 points pour les premiers, puis 2. Artiste : 5, 4, 3, 2, puis 1."
    : "Titre : jusqu'à 100 points, artiste : jusqu'à 50. Plus tu réponds tôt dans l'extrait, plus tu marques.";
  renderSteps();
  wireSeg("popSeg", () => cfg.pop, (v) => { cfg.pop = Number(v); saveCfg(); renderLobby(); });

  // Epoques : toutes cochees par defaut (liste vide = toutes).
  const sel = cfg.decades.length ? new Set(cfg.decades) : new Set(decades);
  $("decadeChips").innerHTML = decades.map((d) =>
    `<button class="chip${sel.has(d) ? " on" : ""}" data-d="${d}">${String(d).slice(2)}s</button>`).join("");
  $("decadeChips").querySelectorAll(".chip").forEach((b) => {
    b.onclick = () => {
      const d = Number(b.dataset.d);
      const s = cfg.decades.length ? new Set(cfg.decades) : new Set(decades);
      if (s.has(d)) s.delete(d); else s.add(d);
      cfg.decades = s.size === decades.length ? [] : [...s].sort();
      if (!s.size) cfg.decades = [-1];   // rien de coche : refuse au lancement
      saveCfg(); renderLobby();
    };
  });

  let err = "";
  const filled = new Set(list.filter((p) => p.isConnected).map((p) => p.teamId).filter((t) => t >= 1));
  if (!solo && filled.size < 2) err = "Il faut des joueurs dans au moins 2 équipes.";
  else if (cfg.decades.length === 1 && cfg.decades[0] === -1) err = "Choisis au moins une époque.";
  $("startBtn").disabled = !!err;
  $("startErr").textContent = err;
  $("startBtn").onclick = () => {
    unlockAudio();
    conn.send({ type: "start", config: { ...cfg } });
  };
}

// ---------- Jeu ----------
const audio = $("audio");
let volume = 75;
try { volume = Math.max(0, Math.min(100, Number(localStorage.getItem(VOL_KEY) ?? 75))); } catch {}
$("volume").value = volume;
audio.volume = volume / 100;
$("volume").addEventListener("input", (e) => {
  volume = Number(e.target.value) || 0;
  audio.volume = volume / 100;
  try { localStorage.setItem(VOL_KEY, String(volume)); } catch {}
});

// Les navigateurs bloquent le son tant que la page n'a pas recu de clic ou de
// touche. Chrome se contente du clic sur "Rejoindre" ; Firefox et Safari
// demandent une action sur cette page : on profite de la premiere.
let unlocked = false;
function unlockAudio() {
  if (unlocked) return;
  unlocked = true;
  const wasSrc = audio.src;
  const p = audio.play();
  if (p && p.then) p.then(() => { if (!playing) audio.pause(); }).catch(() => { unlocked = false; });
  if (!wasSrc) audio.pause();
}
document.addEventListener("pointerdown", unlockAudio, { capture: true });
document.addEventListener("keydown", unlockAudio, { capture: true });

let playing = false;       // l'extrait de la manche en cours doit jouer
let audioSrc = "";
let playTimer = null;
function stopAudio() {
  playing = false;
  clearTimeout(playTimer);
  try { audio.pause(); } catch {}
  $("unmute").hidden = true;
}
// Joue l'extrait a partir de l'heure de depart commune (rattrape le retard
// si on arrive en cours d'ecoute).
function syncAudio() {
  if (!game || !game.preview || game.step === "loading") { if (playing) stopAudio(); return; }
  if (game.pausedAt) { if (playing) stopAudio(); return; }
  if (audioSrc !== game.preview) {
    audioSrc = game.preview;
    audio.src = game.preview;
    audio.load();
  }
  if (playing) return;
  playing = true;
  const startLocal = game.startAt - clockOffset;
  const go = () => {
    if (!playing) return;
    const ahead = (Date.now() - startLocal) / 1000;
    // On ne cale la lecture que si l'ecart est net (arrivee en cours
    // d'ecoute) : apres une pause, on repart simplement de l'endroit atteint.
    try { if (ahead > 0.3 && Math.abs(audio.currentTime - ahead) > 0.4) audio.currentTime = ahead; } catch {}
    const p = audio.play();
    if (p && p.catch) p.then(() => { $("unmute").hidden = true; }).catch(() => { $("unmute").hidden = false; });
  };
  const wait = startLocal - Date.now();
  clearTimeout(playTimer);
  if (wait > 0) playTimer = setTimeout(go, wait); else go();
}
$("unmute").onclick = () => {
  if (!game || game.pausedAt) return;
  const ahead = (serverTime() - game.startAt) / 1000;
  try { if (ahead > 0) audio.currentTime = ahead; } catch {}
  audio.play().then(() => { $("unmute").hidden = true; }).catch(() => {});
};

function myUnit() {
  if (!game) return "";
  if (game.solo) return ME;
  const me = players.find((p) => p.pseudo === ME);
  return me && me.teamId ? "t" + me.teamId : "";
}

function renderGame() {
  if (!game) return;
  $("hostBtns").hidden = !isHost;
  const paused = !!game.pausedAt;
  $("pauseBtn").textContent = paused ? "▶ Reprendre" : "⏸ Pause";
  $("pauseBtn").classList.toggle("on", paused);
  $("gameCard").classList.toggle("paused", paused);
  const key = game.round + ":" + game.step;
  const newRound = !lastRoundKey.startsWith(game.round + ":");
  if (key !== lastRoundKey) {
    if (newRound) { feed = []; $("feedback").textContent = ""; $("answerInput").value = ""; $("answerForm").classList.remove("bad"); stopAudio(); }
    if (game.step === "listening" && lastRoundKey !== key) sound("start");
    if (game.step === "reveal") sound("reveal");
    lastRoundKey = key;
  }
  $("roundPill").textContent = `Manche ${game.round} / ${game.total}`;

  // Disque : tourne pendant l'ecoute, pochette a la revelation.
  const v = $("vinyl"), lbl = $("vinylLabel");
  if (game.step === "reveal" && game.reveal && game.reveal.cover) {
    lbl.innerHTML = `<img src="${esc(game.reveal.cover)}" alt="">`;
    lbl.classList.add("cover");
  } else { lbl.textContent = "🎵"; lbl.classList.remove("cover"); }

  // Cartes Titre / Artiste : ce que j'ai (ou mon equipe a) trouve, puis tout
  // a la revelation.
  const me = game.me || {};
  const rv = game.step === "reveal" ? game.reveal : null;
  paintCard("Title", me.title, rv ? rv.title : null);
  paintCard("Artist", me.artist, rv ? rv.artist : null);

  // Fil : qui vient de trouver quoi (sans la reponse).
  const now = new Map(game.scores.map((s) => [s.id, s]));
  if (!newRound) {
    for (const s of game.scores) {
      const old = prevScores.get(s.id);
      if (!old) continue;
      if (s.title !== null && old.title === null) feed.unshift({ who: s.name, kind: "titre", t: s.title, me: s.id === myUnit() });
      if (s.artist !== null && old.artist === null) feed.unshift({ who: s.name, kind: "artiste", t: s.artist, me: s.id === myUnit() });
    }
  }
  prevScores = now;
  feed = feed.slice(0, 4);
  $("feed").innerHTML = feed.map((f) =>
    `<li class="${f.me ? "me" : ""}"><b>${esc(f.who)}</b> a trouvé ${f.kind === "titre" ? "le titre" : "l'artiste"} <span>${sec(f.t)}</span></li>`).join("");

  renderBoard();
  renderHistory();

  const mine = myUnit();
  const done = !!(me.title && me.artist);
  const canAnswer = game.step === "listening" && !!mine && !done && !paused;
  $("answerInput").disabled = !canAnswer;
  $("answerSend").disabled = !canAnswer;
  $("answerInput").placeholder = !mine ? "Tu regardes cette partie"
    : paused && game.step === "listening" ? "Partie en pause"
    : done ? "Tu as tout trouvé, bravo !"
    : "Titre, artiste, ou les deux";
  syncAudio();
  tick();
}

function paintCard(kind, found, revealed) {
  const card = $("card" + kind), val = $(kind.toLowerCase() + "Val"), info = $(kind.toLowerCase() + "Info");
  card.classList.remove("found", "miss");
  if (found) {
    card.classList.add("found");
    // Mode streamer : la case passe au vert mais la reponse reste cachee
    // tant qu'elle n'est pas devoilee a tous.
    val.textContent = streamer && !revealed ? "Trouvé ✓" : found.text;
    const by = !game.solo && found.by !== ME ? ` · trouvé par ${found.by}` : "";
    info.textContent = `+${found.pts} · ${sec(found.t)}${by}`;
  } else if (revealed) {
    card.classList.add("miss");
    val.textContent = revealed;
    info.textContent = "Raté";
  } else {
    val.textContent = "?";
    info.textContent = "";
  }
}

// Recap de fin : sous le nom d'une equipe, ses joueurs (pas pendant la
// partie, ou seul le nom de l'equipe est affiche). Inutile si l'equipe ne
// compte qu'un joueur qui porte le meme nom.
function showMembers(s) {
  if (!s.members.length) return false;
  return !(s.members.length === 1 && s.members[0].toLowerCase() === String(s.name).toLowerCase());
}

// Classement : rang en chiffre, nom, jauge titre / artiste de la manche, score.
function renderBoard() {
  const mine = myUnit();
  let rank = 0, prev = null;
  $("board").innerHTML = game.scores.map((s, i) => {
    if (s.score !== prev) { rank = i + 1; prev = s.score; }
    const gain = game.step === "reveal" && s.gain ? `<span class="bt-gain">+${s.gain}</span>` : "";
    const dot = s.color >= 0 ? `<span class="dot" style="background:${colorOf(s.color)}"></span>` : "";
    return `<div class="bt-row${s.id === mine ? " me" : ""}">` +
      `<span class="bt-rank">${rank}</span>` +
      `<span class="bt-who">${dot}<span class="bt-name">${esc(s.name)}</span></span>` +
      `<span class="bt-gauge" title="Titre / artiste"><i class="${s.title !== null ? "t" : ""}"></i><i class="${s.artist !== null ? "a" : ""}"></i></span>` +
      gain + `<span class="bt-score">${s.score}</span></div>`;
  }).join("") || '<p class="empty-note">Personne pour l\'instant.</p>';
}

function renderHistory() {
  const h = game.history || [];
  $("history").innerHTML = h.length ? h.map((x) =>
    `<div class="bt-hist">${x.cover ? `<img src="${esc(x.cover)}" alt="">` : '<span class="bt-hist-ph">🎵</span>'}` +
    `<span class="bt-hist-info"><b>${esc(x.title)}</b><em>${esc(x.artist)}${x.year ? " · " + x.year : ""}</em></span></div>`).join("")
    : '<p class="empty-note">Les morceaux joués s\'afficheront ici.</p>';
}

// Chrono et texte d'etat, rafraichis en continu.
function tick() {
  if (!game) return;
  const paused = !!game.pausedAt;
  const now = paused ? game.pausedAt : serverTime();
  let status = "", timer = "";
  const v = $("vinyl");
  if (game.step === "loading") { status = "Chargement de l'extrait…"; timer = "-"; v.classList.remove("spinning"); }
  else if (game.step === "listening") {
    if (now < game.startAt) {
      status = `Manche ${game.round} : prépare-toi…`;
      timer = String(Math.ceil((game.startAt - now) / 1000));
      v.classList.remove("spinning");
    } else {
      const left = Math.max(0, Math.ceil((game.endsAt - now) / 1000));
      status = "À l'écoute…";
      timer = String(left);
      v.classList.add("spinning");
      $("timer").classList.toggle("low", left <= 5);
      // Fin du temps cote page : on ferme la case en attendant la revelation.
      if (now > game.endsAt + 600 && !$("answerInput").disabled) {
        $("answerInput").disabled = true; $("answerSend").disabled = true;
      }
    }
  } else if (game.step === "reveal") {
    v.classList.remove("spinning");
    const left = game.revealUntil ? Math.max(0, Math.ceil((game.revealUntil - now) / 1000)) : 0;
    status = game.round >= game.total ? `Résultats dans ${left} s` : `Manche suivante dans ${left} s`;
    timer = "";
    $("timer").classList.remove("low");
    // Le son s'efface doucement avant la manche suivante.
    if (playing && game.revealUntil) {
      const fade = Math.max(0, Math.min(1, (game.revealUntil - now) / 2500));
      audio.volume = (volume / 100) * fade;
    }
  }
  if (game.step !== "reveal") audio.volume = volume / 100;
  if (paused) { status = "⏸ En pause"; v.classList.remove("spinning"); }
  $("status").textContent = status;
  $("timer").textContent = timer;
}
function startLoop() {
  if (loopId) return;
  loopId = setInterval(tick, 200);
}
function stopLoop() { clearInterval(loopId); loopId = null; }

$("answerInput").addEventListener("input", () => $("answerForm").classList.remove("bad"));
$("answerForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const inp = $("answerInput");
  const t = inp.value.trim();
  if (!t || inp.disabled) return;
  conn.send({ type: "answer", text: t });
});
$("skipBtn").onclick = () => conn.send({ type: "skip" });
$("pauseBtn").onclick = () => { if (game) conn.send({ type: "pause", paused: !game.pausedAt }); };

// Mode streamer (propre a chaque joueur, retenu sur l'appareil) : masque ce
// que l'on tape et le contenu des cases trouvees, pour ne rien devoiler au
// stream. Le cadre vert reste visible.
let streamer = false;
try { streamer = localStorage.getItem("bt_streamer") === "1"; } catch {}
function applyStreamer() {
  document.body.classList.toggle("streamer", streamer);
  // Navigateurs sans masquage CSS : on passe la case en champ masque.
  if (!(window.CSS && CSS.supports("-webkit-text-security", "disc"))) {
    $("answerInput").type = streamer ? "password" : "text";
  }
  const b = $("streamerBtn");
  b.classList.toggle("on", streamer);
  b.setAttribute("aria-pressed", String(streamer));
  b.title = streamer
    ? "Mode streamer activé : tes réponses sont masquées à l'écran"
    : "Mode streamer : masque tes réponses à l'écran";
  if (game && phase === "playing") renderGame();
}
$("streamerBtn").onclick = () => {
  streamer = !streamer;
  try { localStorage.setItem("bt_streamer", streamer ? "1" : "0"); } catch {}
  applyStreamer();
};
applyStreamer();
$("endGameBtn").onclick = () => {
  if (confirm("Terminer la partie maintenant ?")) conn.send({ type: "endGame" });
};

// ---------- Fin ----------
function renderFinished(m) {
  const rows = m.scores;
  const top = rows[0];
  $("endWinner").textContent = !top || !top.score ? "Personne n'a marqué cette partie."
    : rows.length > 1 && rows[1].score === top.score ? "Égalité en tête !"
    : `${top.name} l'emporte avec ${top.score} points.`;
  let rank = 0, prev = null;
  $("endRanking").innerHTML = rows.map((s, i) => {
    if (s.score !== prev) { rank = i + 1; prev = s.score; }
    const members = showMembers(s) ? `<span class="detail">${s.members.map(esc).join(", ")}</span>` : "";
    return `<div class="rank-row${s.id === myUnitFor(m) ? " me" : ""}"><span class="rank-num">${rank}</span>` +
      `<span class="pname">${esc(s.name)}</span>${members}<span class="pscore">${s.score}</span></div>`;
  }).join("");
  $("endTable").innerHTML = "<tr><th>Joueur</th><th>Titres</th><th>Artistes</th><th>Points</th><th>Plus rapide</th></tr>" +
    m.players.map((p) => `<tr${p.name === ME ? ' class="me"' : ""}><td>${esc(p.name)}</td><td>${p.titles}</td><td>${p.artists}</td>` +
      `<td>${p.points}</td><td>${p.best === null ? "-" : sec(p.best)}</td></tr>`).join("");
  $("lobbyBtn").hidden = !isHost;
  $("endWait").hidden = isHost;
  $("lobbyBtn").onclick = () => conn.send({ type: "backToLobby" });
  sound("end");
}
function myUnitFor(m) {
  if (m.solo) return ME;
  const me = players.find((p) => p.pseudo === ME);
  return me && me.teamId ? "t" + me.teamId : "";
}

// ---------- Petits sons (WebAudio) ----------
let actx = null;
function sound(kind) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const tones = { ok: [[880, 0, .09], [1320, .09, .12]], start: [[660, 0, .08]], reveal: [[520, 0, .1], [390, .1, .14]], end: [[523, 0, .12], [659, .12, .12], [784, .24, .2]] }[kind];
    if (!tones) return;
    const t0 = actx.currentTime;
    for (const [f, at, d] of tones) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = f; o.type = "sine";
      g.gain.setValueAtTime(0.0001, t0 + at);
      g.gain.exponentialRampToValueAtTime(0.12 * (volume / 100 + 0.2), t0 + at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + d);
      o.connect(g); g.connect(actx.destination);
      o.start(t0 + at); o.stop(t0 + at + d + 0.02);
    }
  } catch {}
}

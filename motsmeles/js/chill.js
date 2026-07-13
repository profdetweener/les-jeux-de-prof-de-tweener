/**
 * Mots meles, mode chill (solo, 100% cote navigateur).
 *
 * Deroule : on choisit taille + difficulte, on genere la grille (via
 * MMGenerator), on trouve les mots caches en cliquant case de debut puis case
 * de fin. Aucune liste de mots affichee (volontaire : c'est de la recherche a
 * l'aveugle). Deux aides douces : le compteur de longueurs restantes et un
 * bouton "Indice" qui fait clignoter le depart d'un mot non trouve.
 *
 * Une fois tous les mots trouves, les cases restantes forment le MOT MYSTERE :
 * on affiche sa definition et on le devine pour gagner.
 */
(function () {
  "use strict";

  // Palette de couleurs cyclees par mot trouve (memes tokens que le site).
  var COLORS = ["#4a8c5a", "#4a6fa5", "#d4a830", "#de7ae3", "#c84545", "#2a9d8f", "#8a5fb0", "#c9772e"];

  var el = {
    setup: document.getElementById("setup"),
    game: document.getElementById("game"),
    sizeSeg: document.getElementById("sizeSeg"),
    diffSeg: document.getElementById("diffSeg"),
    launchBtn: document.getElementById("launchBtn"),
    grid: document.getElementById("grid"),
    found: document.getElementById("found"),
    total: document.getElementById("total"),
    timer: document.getElementById("timer"),
    lenChips: document.getElementById("lenChips"),
    status: document.getElementById("status"),
    hintBtn: document.getElementById("hintBtn"),
    newBtn: document.getElementById("newBtn"),
    backBtn: document.getElementById("backBtn"),
    mystery: document.getElementById("mystery"),
    mystDef: document.getElementById("mystDef"),
    mystHint: document.getElementById("mystHint"),
    mystInput: document.getElementById("mystInput"),
    mystSubmit: document.getElementById("mystSubmit"),
    mystMsg: document.getElementById("mystMsg"),
    win: document.getElementById("win"),
    winTime: document.getElementById("winTime"),
    winWord: document.getElementById("winWord"),
    winMeta: document.getElementById("winMeta"),
    winNew: document.getElementById("winNew"),
    winBack: document.getElementById("winBack"),
    toast: document.getElementById("toast"),
  };

  var state = null;
  var toastTimer = null;

  function toast(msg) {
    if (!el.toast) return;
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove("show"); }, 1600);
  }

  function stripAccents(s) {
    return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }
  function normWord(s) {
    return stripAccents(String(s || "")).toUpperCase().replace(/[^A-Z]/g, "");
  }
  function cellKey(cells) {
    return cells.map(function (c) { return c.r + "," + c.c; }).join(";");
  }
  function fmtTime(sec) {
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  // --- Selection courante dans les onglets segmentes -------------------------
  function segValue(seg) {
    var on = seg.querySelector("button.on");
    return on ? on.getAttribute("data-v") : null;
  }
  function wireSeg(seg) {
    seg.addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      seg.querySelectorAll("button").forEach(function (x) { x.classList.remove("on"); });
      b.classList.add("on");
    });
  }
  wireSeg(el.sizeSeg);
  wireSeg(el.diffSeg);

  // --- Dimensionnement de la grille pour tenir en largeur --------------------
  function sizeGrid() {
    if (!state) return;
    var n = state.size;
    var avail = Math.min(el.grid.parentElement.clientWidth || 600, 600);
    var gap = 3, pad = 12;
    var c = Math.floor((avail - pad - gap * (n - 1)) / n);
    c = Math.max(20, Math.min(46, c));
    el.grid.style.setProperty("--c", c + "px");
    el.grid.style.setProperty("--n", n);
  }
  window.addEventListener("resize", sizeGrid);

  // --- Lancement d'une partie ------------------------------------------------
  function start(size, level) {
    var res = window.MMGenerator.generate({
      size: size, level: level,
      targetWords: window.MM_TARGET, mysteryBank: window.MM_MYSTERY,
    });
    if (!res) { toast("Grille impossible, reessaie"); return; }

    // Precalcule les cles de cellules de chaque mot (pour matcher une selection).
    var words = res.placed.map(function (p) {
      return { word: p.word, cells: p.cells, key: cellKey(p.cells), rkey: cellKey(p.cells.slice().reverse()), found: false, color: null };
    });

    state = {
      size: size, level: level,
      grid: res.grid, words: words, mystery: res.mystery,
      foundCount: 0, sel: null, cellEls: {},
      startTs: Date.now(), timerId: null, done: false,
    };

    renderGrid();
    sizeGrid();
    el.total.textContent = words.length;
    el.found.textContent = "0";
    el.status.textContent = "";
    updateLenChips();

    el.mystery.hidden = true;
    el.win.hidden = true;
    el.game.hidden = false;
    el.setup.hidden = true;

    clearInterval(state.timerId);
    state.timerId = setInterval(tick, 1000);
    tick();
  }

  function tick() {
    if (!state || state.done) return;
    var sec = Math.floor((Date.now() - state.startTs) / 1000);
    el.timer.textContent = fmtTime(sec);
  }

  function renderGrid() {
    var n = state.size, g = state.grid;
    var frag = document.createDocumentFragment();
    state.cellEls = {};
    el.grid.innerHTML = "";
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        var d = document.createElement("div");
        d.className = "mm-cell";
        d.textContent = g[r][c];
        d.setAttribute("data-r", r);
        d.setAttribute("data-c", c);
        frag.appendChild(d);
        state.cellEls[r + "," + c] = d;
      }
    }
    el.grid.appendChild(frag);
  }

  // --- Selection : clic depart puis clic arrivee -----------------------------
  el.grid.addEventListener("click", function (e) {
    var cell = e.target.closest(".mm-cell");
    if (!cell || !state || state.done) return;
    var r = +cell.getAttribute("data-r"), c = +cell.getAttribute("data-c");

    if (!state.sel) {
      state.sel = { r: r, c: c, el: cell };
      cell.classList.add("sel-start");
      return;
    }
    // Meme case -> on annule la selection.
    if (state.sel.r === r && state.sel.c === c) {
      cell.classList.remove("sel-start");
      state.sel = null;
      return;
    }
    var start = state.sel;
    start.el.classList.remove("sel-start");
    state.sel = null;
    handleLine(start.r, start.c, r, c);
  });

  function handleLine(r1, c1, r2, c2) {
    var dR = r2 - r1, dC = c2 - c1;
    var straight = (r1 === r2) || (c1 === c2) || (Math.abs(dR) === Math.abs(dC));
    if (!straight) { flashBad(); return; }
    var len = Math.max(Math.abs(dR), Math.abs(dC)) + 1;
    var sr = Math.sign(dR), sc = Math.sign(dC);
    var cells = [];
    for (var i = 0; i < len; i++) cells.push({ r: r1 + sr * i, c: c1 + sc * i });
    var key = cellKey(cells);

    for (var w = 0; w < state.words.length; w++) {
      var word = state.words[w];
      if (word.found) continue;
      if (key === word.key || key === word.rkey) {
        markFound(word);
        return;
      }
    }
    flashBad();
  }

  function flashBad() {
    el.grid.classList.remove("bad");
    // reflow pour rejouer l'animation
    void el.grid.offsetWidth;
    el.grid.classList.add("bad");
  }

  function markFound(word) {
    word.found = true;
    word.color = COLORS[state.foundCount % COLORS.length];
    state.foundCount++;
    for (var i = 0; i < word.cells.length; i++) {
      var cc = word.cells[i];
      var d = state.cellEls[cc.r + "," + cc.c];
      if (!d.classList.contains("found")) {
        d.classList.add("found");
        d.style.background = word.color;
      }
    }
    el.found.textContent = state.foundCount;
    el.status.textContent = word.word + " !";
    toast(word.word);
    updateLenChips();

    if (state.foundCount === state.words.length) revealMystery();
  }

  // Compteur de longueurs restantes : "5:•• 7:•" sans reveler les mots.
  function updateLenChips() {
    var rem = {};
    state.words.forEach(function (w) { if (!w.found) rem[w.word.length] = (rem[w.word.length] || 0) + 1; });
    var lens = Object.keys(rem).map(Number).sort(function (a, b) { return a - b; });
    if (!lens.length) { el.lenChips.innerHTML = ""; return; }
    el.lenChips.innerHTML = lens.map(function (L) {
      return '<span class="len-chip"><b>' + L + '</b>&nbsp;' + "•".repeat(rem[L]) + "</span>";
    }).join("");
  }

  // Indice : fait clignoter la case de depart d'un mot non trouve.
  el.hintBtn.addEventListener("click", function () {
    if (!state || state.done) return;
    var remaining = state.words.filter(function (w) { return !w.found; });
    if (!remaining.length) return;
    var w = remaining[Math.floor(Math.random() * remaining.length)];
    var first = w.cells[0];
    var d = state.cellEls[first.r + "," + first.c];
    d.classList.add("sel-start");
    setTimeout(function () { if (!w.found) d.classList.remove("sel-start"); }, 900);
    toast("Un mot commence ici");
  });

  function revealMystery() {
    // Met en avant les cases restantes (= le mot mystere).
    state.mystery.cells.forEach(function (cc) {
      var d = state.cellEls[cc.r + "," + cc.c];
      d.classList.add("myst");
    });
    el.status.textContent = "Tous les mots trouves !";
    el.mystDef.textContent = state.mystery.definition;
    el.mystHint.textContent =
      state.mystery.word.length + " lettres, cases jaunes lues de gauche a droite puis de haut en bas.";
    el.mystMsg.textContent = "";
    el.mystMsg.className = "msg";
    el.mystInput.value = "";
    el.mystery.hidden = false;
    el.mystInput.focus();
  }

  function submitMystery() {
    if (!state || state.done) return;
    var guess = normWord(el.mystInput.value);
    if (!guess) return;
    if (guess === state.mystery.word) {
      state.done = true;
      clearInterval(state.timerId);
      win();
    } else {
      el.mystMsg.textContent = "Pas encore, reessaie.";
      el.mystMsg.className = "msg err";
      el.mystInput.select();
    }
  }
  el.mystSubmit.addEventListener("click", submitMystery);
  el.mystInput.addEventListener("keydown", function (e) { if (e.key === "Enter") submitMystery(); });

  function win() {
    var sec = Math.floor((Date.now() - state.startTs) / 1000);
    el.winTime.textContent = fmtTime(sec);
    el.winWord.textContent = state.mystery.word;
    el.winMeta.textContent =
      state.words.length + " mots trouves, grille " + state.size + "×" + state.size + ".";
    el.mystery.hidden = true;
    el.win.hidden = false;
  }

  // --- Boutons ---------------------------------------------------------------
  el.launchBtn.addEventListener("click", function () {
    var size = parseInt(segValue(el.sizeSeg), 10);
    var level = segValue(el.diffSeg);
    start(size, level);
  });
  function newGrid() { start(state.size, state.level); }
  function backToSetup() {
    if (state) { clearInterval(state.timerId); }
    el.game.hidden = true;
    el.mystery.hidden = true;
    el.win.hidden = true;
    el.setup.hidden = false;
  }
  el.newBtn.addEventListener("click", newGrid);
  el.backBtn.addEventListener("click", backToSetup);
  el.winNew.addEventListener("click", newGrid);
  el.winBack.addEventListener("click", backToSetup);
})();

/**
 * Generateur de grille de mots meles "facon papier" : la grille est
 * entierement remplie de mots a trouver, et les cases restantes (aucune
 * associee a un mot) forment, lues de gauche a droite puis de haut en bas,
 * un MOT MYSTERE que l'on devine grace a une definition.
 *
 * Approche : plutot que de fixer le mot mystere d'abord (ce qui oblige le
 * reliquat de cases a tomber pile sur sa longueur, tres contraignant et donc
 * peu de tailles de grille possibles)...
 *
 * Ici on inverse : on empile des mots jusqu'a ce que le reliquat tombe
 * n'importe ou dans une FENETRE [MIN_MYST, MAX_MYST] (par defaut 5..12), puis
 * on choisit un mot mystere de cette longueur exacte. La fenetre (8 valeurs
 * acceptables au lieu d'une seule) rend la convergence bien plus facile, donc
 * on debloque des tailles de grille variees.
 *
 * Aucun DOM ici : le fichier tourne aussi sous Node (tests). L'affichage et la
 * detection des clics sont geres ailleurs (chill.js).
 */
(function (root) {
  "use strict";

  var MIN_MYST = 5;
  var MAX_MYST = 12;

  // 8 directions, identifiees par un libelle pour composer les niveaux.
  var DIRS = {
    E: { dr: 0, dc: 1 },   // horizontal ->
    S: { dr: 1, dc: 0 },   // vertical v
    SE: { dr: 1, dc: 1 },  // diagonale \
    NE: { dr: -1, dc: 1 }, // diagonale /
    W: { dr: 0, dc: -1 },  // horizontal <- (mot a l'envers)
    N: { dr: -1, dc: 0 },  // vertical ^ (a l'envers)
    NW: { dr: -1, dc: -1 },// diagonale \ a l'envers
    SW: { dr: 1, dc: -1 }, // diagonale / a l'envers
  };

  // Niveaux : quelles directions sont autorisees a la POSE des mots.
  // (La lecture par le joueur, elle, accepte toujours les 8 sens.)
  var LEVELS = {
    facile: ["E", "S", "SE"],
    moyen: ["E", "S", "SE", "NE", "W", "N"],
    difficile: ["E", "S", "SE", "NE", "W", "N", "NW", "SW"],
  };

  // --- RNG optionnellement seedable (pour reproduire un tirage en test) -----
  function makeRng(seed) {
    if (seed == null) return Math.random;
    var s = seed >>> 0;
    return function () {
      // xorshift32
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      return (s >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rng) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  function pick(arr, rng) { return arr[Math.floor(rng() * arr.length)]; }

  // Toutes les placements valides d'un mot sur la grille courante.
  // Un placement est valide si chaque case est vide OU deja egale a la lettre.
  // On compte les "croisements" (cases deja remplies compatibles) pour
  // privilegier les poses qui densifient la grille.
  function placementsFor(word, grid, n, dirKeys) {
    var res = [];
    for (var di = 0; di < dirKeys.length; di++) {
      var d = DIRS[dirKeys[di]];
      for (var r = 0; r < n; r++) {
        for (var c = 0; c < n; c++) {
          var er = r + d.dr * (word.length - 1);
          var ec = c + d.dc * (word.length - 1);
          if (er < 0 || er >= n || ec < 0 || ec >= n) continue;
          var ok = true, crosses = 0;
          for (var i = 0; i < word.length; i++) {
            var cell = grid[r + d.dr * i][c + d.dc * i];
            if (cell === "") continue;
            if (cell === word[i]) { crosses++; }
            else { ok = false; break; }
          }
          if (ok) res.push({ r: r, c: c, dir: dirKeys[di], d: d, crosses: crosses });
        }
      }
    }
    return res;
  }

  function place(word, p, grid) {
    var cells = [];
    for (var i = 0; i < word.length; i++) {
      var rr = p.r + p.d.dr * i, cc = p.c + p.d.dc * i;
      grid[rr][cc] = word[i];
      cells.push({ r: rr, c: cc });
    }
    return cells;
  }

  function countEmpty(grid, n) {
    var e = 0;
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (grid[r][c] === "") e++;
    return e;
  }

  function emptyCellsReadingOrder(grid, n) {
    var out = [];
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (grid[r][c] === "") out.push({ r: r, c: c });
    return out;
  }

  /**
   * Un essai de remplissage. Renvoie {grid, placed, empty} ou null si bloque.
   * Strategie : mots les plus longs d'abord (avec un peu d'alea), pose
   * privilegiant les croisements, jusqu'a ce que le reliquat passe sous
   * MAX_MYST. Puis on tente d'atterrir dans [MIN_MYST, MAX_MYST].
   */
  function attempt(n, dirKeys, pool, rng) {
    var grid = [];
    for (var r = 0; r < n; r++) { grid[r] = []; for (var c = 0; c < n; c++) grid[r][c] = ""; }

    // Mots candidats qui tiennent dans la grille, longs d'abord, un peu melanges.
    var words = pool.slice();
    shuffle(words, rng);
    words.sort(function (a, b) { return b.length - a.length; });
    // leger jitter pour ne pas toujours poser exactement le meme ordre
    for (var k = 0; k < words.length - 1; k++) {
      if (rng() < 0.35) { var t = words[k]; words[k] = words[k + 1]; words[k + 1] = t; }
    }

    var placed = [];
    var used = {};
    var target = n * n; // on vise le remplissage maximal, mystere gere apres
    var stalled = 0;

    for (var wi = 0; wi < words.length; wi++) {
      var w = words[wi];
      if (used[w]) continue;
      var empty = countEmpty(grid, n);
      // Ne pas descendre sous MIN_MYST : si poser ce mot risque de trop remplir,
      // on l'ignore (on garde de la place pour le mot mystere).
      if (empty - w.length < MIN_MYST) {
        // encore trop de vide ? on continue a chercher des mots plus courts.
        if (empty > MAX_MYST) continue;
        else break; // reliquat deja dans la fenetre visee
      }
      var places = placementsFor(w, grid, n, dirKeys);
      if (!places.length) { stalled++; continue; }
      // Privilegier les croisements (densite), avec un peu d'alea.
      places.sort(function (a, b) { return b.crosses - a.crosses; });
      var top = places.filter(function (p) { return p.crosses === places[0].crosses; });
      var chosen = pick(top.length && rng() < 0.7 ? top : places, rng);
      var cells = place(w, chosen, grid);
      placed.push({ word: w, cells: cells, dir: chosen.dir });
      used[w] = true;

      var e = countEmpty(grid, n);
      if (e <= MAX_MYST) break;
    }

    var emptyCount = countEmpty(grid, n);

    // Reliquat trop gros : la grille est restee trop creuse -> echec de l'essai.
    if (emptyCount > MAX_MYST) return null;

    // Reliquat trop petit : on a surcharge. On retire des mots recents jusqu'a
    // revenir dans la fenetre, si possible.
    while (emptyCount < MIN_MYST && placed.length) {
      var last = placed.pop();
      for (var ci = 0; ci < last.cells.length; ci++) {
        var cell = last.cells[ci];
        // Ne vider que si aucune autre pose ne partage cette case.
        var shared = false;
        for (var pj = 0; pj < placed.length && !shared; pj++) {
          var pc = placed[pj].cells;
          for (var pk = 0; pk < pc.length; pk++) {
            if (pc[pk].r === cell.r && pc[pk].c === cell.c) { shared = true; break; }
          }
        }
        if (!shared) grid[cell.r][cell.c] = "";
      }
      used[last.word] = false;
      emptyCount = countEmpty(grid, n);
    }

    if (emptyCount < MIN_MYST || emptyCount > MAX_MYST) return null;
    if (placed.length < 6) return null; // grille trop pauvre, pas fun
    return { grid: grid, placed: placed, empty: emptyCount };
  }

  /**
   * API publique.
   * opts = { size, level|dirKeys, targetWords:{len:[...]}, mysteryBank:[{w,d,l}],
   *          maxAttempts, seed }
   * Renvoie { grid, size, placed:[{word,cells,dir}], mystery:{word,definition,cells}, attempts }
   * ou null si echec apres maxAttempts.
   */
  function generate(opts) {
    var n = opts.size;
    var dirKeys = opts.dirKeys || LEVELS[opts.level || "moyen"];
    var rng = makeRng(opts.seed);
    var maxAttempts = opts.maxAttempts || 1500;

    // Pool de mots qui tiennent dans la grille (longueur <= n).
    var pool = [];
    var byLen = opts.targetWords;
    for (var L in byLen) {
      if (!byLen.hasOwnProperty(L)) continue;
      if (parseInt(L, 10) > n) continue;
      pool = pool.concat(byLen[L]);
    }

    // Index des mots mysteres par longueur, restreint a la fenetre.
    var mystByLen = {};
    for (var mi = 0; mi < opts.mysteryBank.length; mi++) {
      var m = opts.mysteryBank[mi];
      if (m.l < MIN_MYST || m.l > MAX_MYST) continue;
      (mystByLen[m.l] = mystByLen[m.l] || []).push(m);
    }

    for (var a = 0; a < maxAttempts; a++) {
      var res = attempt(n, dirKeys, pool, rng);
      if (!res) continue;
      var L = res.empty;
      var cand = mystByLen[L];
      if (!cand || !cand.length) continue; // pas de mystere a cette longueur
      var myst = pick(cand, rng);
      var slots = emptyCellsReadingOrder(res.grid, n);
      // Ecrit le mot mystere dans les cases vides, en ordre de lecture.
      for (var s = 0; s < slots.length; s++) {
        res.grid[slots[s].r][slots[s].c] = myst.w[s];
      }
      return {
        grid: res.grid,
        size: n,
        placed: res.placed,
        mystery: { word: myst.w, definition: myst.d, cells: slots },
        attempts: a + 1,
      };
    }
    return null;
  }

  var api = { generate: generate, LEVELS: LEVELS, DIRS: DIRS, MIN_MYST: MIN_MYST, MAX_MYST: MAX_MYST };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.MMGenerator = api;
})(typeof window !== "undefined" ? window : globalThis);

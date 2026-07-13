/**
 * Generateur de grille de mots meles "facon papier" : la grille est
 * entierement remplie de mots a trouver, et les cases restantes (aucune
 * associee a un mot) forment, lues de gauche a droite puis de haut en bas,
 * un MOT MYSTERE que l'on devine grace a une definition.
 *
 * Approche : plutot que de fixer le mot mystere d'abord (ce qui oblige le
 * reliquat de cases a tomber pile sur sa longueur, tres contraignant et donc
 * peu de tailles de grille possibles), on empile des mots jusqu'a ce que le
 * reliquat tombe dans une FENETRE [MIN_MYST, MAX_MYST] (par defaut 5..12), puis
 * on choisit un mot mystere de cette longueur exacte. La fenetre (8 valeurs
 * acceptables au lieu d'une seule) rend la convergence facile et debloque des
 * tailles de grille variees.
 *
 * Variete des longueurs : on ne pose PAS les mots du plus long au plus court
 * (ca sature la grille de mots de longueur maxi). On amorce avec quelques mots
 * longs pour la structure, puis on remplit en tirant la longueur suivante avec
 * une ponderation qui favorise la diversite (une longueur deja beaucoup posee
 * devient moins probable).
 *
 * Aucun DOM ici : le fichier tourne aussi sous Node (tests).
 */
(function (root) {
  "use strict";

  var MIN_MYST = 5;
  var MAX_MYST = 12;

  var DIRS = {
    E: { dr: 0, dc: 1 }, S: { dr: 1, dc: 0 }, SE: { dr: 1, dc: 1 }, NE: { dr: -1, dc: 1 },
    W: { dr: 0, dc: -1 }, N: { dr: -1, dc: 0 }, NW: { dr: -1, dc: -1 }, SW: { dr: 1, dc: -1 },
  };

  // Niveaux : directions autorisees a la POSE. (La lecture par le joueur
  // accepte toujours les 8 sens.)
  var LEVELS = {
    facile: ["E", "S", "SE"],
    moyen: ["E", "S", "SE", "NE", "W", "N"],
    difficile: ["E", "S", "SE", "NE", "W", "N", "NW", "SW"],
  };

  function makeRng(seed) {
    if (seed == null) return Math.random;
    var s = seed >>> 0;
    return function () {
      s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
      return (s >>> 0) / 4294967296;
    };
  }
  function pick(arr, rng) { return arr[Math.floor(rng() * arr.length)]; }

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
            if (cell === word[i]) crosses++;
            else { ok = false; break; }
          }
          if (ok) res.push({ r: r, c: c, d: d, dir: dirKeys[di], crosses: crosses });
        }
      }
    }
    return res;
  }

  function placeWord(word, p, grid) {
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

  // Tente de poser UN mot de longueur L (non deja utilise). Renvoie le mot pose ou null.
  function tryPlaceLen(L, poolByLen, used, grid, n, dirKeys, rng) {
    var list = poolByLen[L];
    if (!list || !list.length) return null;
    for (var t = 0; t < 8; t++) {
      var w = pick(list, rng);
      if (used[w]) continue;
      var places = placementsFor(w, grid, n, dirKeys);
      if (!places.length) continue;
      places.sort(function (a, b) { return b.crosses - a.crosses; });
      var top = places.filter(function (p) { return p.crosses === places[0].crosses; });
      var chosen = pick(top.length && rng() < 0.65 ? top : places, rng);
      var cells = placeWord(w, chosen, grid);
      used[w] = true;
      return { word: w, cells: cells, dir: chosen.dir };
    }
    return null;
  }

  function attempt(n, dirKeys, poolByLen, rng) {
    var grid = [];
    for (var r = 0; r < n; r++) { grid[r] = []; for (var c = 0; c < n; c++) grid[r][c] = ""; }

    var maxLen = Math.min(10, n);
    var lengths = [];
    for (var L = 4; L <= maxLen; L++) if (poolByLen[L] && poolByLen[L].length) lengths.push(L);
    if (!lengths.length) return null;

    var placed = [];
    var used = {};
    var countLen = {};
    function record(pl) { if (pl) { placed.push(pl); countLen[pl.word.length] = (countLen[pl.word.length] || 0) + 1; } }

    // 1) Amorce : quelques mots longs pour donner de la structure.
    var longLens = lengths.filter(function (L) { return L >= Math.max(7, maxLen - 2); });
    var seed = n <= 10 ? 2 : n <= 12 ? 3 : 4;
    for (var s = 0; s < seed && longLens.length; s++) {
      record(tryPlaceLen(pick(longLens, rng), poolByLen, used, grid, n, dirKeys, rng));
    }

    // 2) Remplissage varie.
    var guard = 0;
    while (guard++ < 6000) {
      var empty = countEmpty(grid, n);
      if (empty <= MAX_MYST) break;

      var cand = lengths.filter(function (L) { return L <= empty - MIN_MYST; });
      if (!cand.length) cand = lengths.filter(function (L) { return L <= empty; });
      if (!cand.length) break;

      var weights = cand.map(function (L) {
        var u = countLen[L] || 0;
        // Cloche centree sur 6-7 : les mots moyens dominent, les tres courts
        // (4) et tres longs (10) restent minoritaires -> repartition naturelle.
        var base = Math.exp(-((L - 6.5) * (L - 6.5)) / 7);
        return base / (1 + u * 1.25);
      });
      var sum = weights.reduce(function (a, b) { return a + b; }, 0);
      var x = rng() * sum, L2 = cand[cand.length - 1];
      for (var wi = 0; wi < cand.length; wi++) { x -= weights[wi]; if (x <= 0) { L2 = cand[wi]; break; } }

      var pl = tryPlaceLen(L2, poolByLen, used, grid, n, dirKeys, rng);
      if (!pl) {
        // Repli : on tente les autres longueurs, des PLUS LONGUES aux plus
        // courtes, pour que le 4 lettres reste un dernier recours (sinon il
        // sature la fin de remplissage).
        var placedAny = false;
        for (var ci = cand.length - 1; ci >= 0 && !placedAny; ci--) {
          var alt = tryPlaceLen(cand[ci], poolByLen, used, grid, n, dirKeys, rng);
          if (alt) { record(alt); placedAny = true; }
        }
        if (!placedAny) break;
      } else {
        record(pl);
      }
    }

    var emptyCount = countEmpty(grid, n);
    if (emptyCount > MAX_MYST) return null;

    while (emptyCount < MIN_MYST && placed.length) {
      var last = placed.pop();
      countLen[last.word.length]--;
      for (var ci2 = 0; ci2 < last.cells.length; ci2++) {
        var cell = last.cells[ci2], shared = false;
        for (var pj = 0; pj < placed.length && !shared; pj++) {
          var pc = placed[pj].cells;
          for (var pk = 0; pk < pc.length; pk++) if (pc[pk].r === cell.r && pc[pk].c === cell.c) { shared = true; break; }
        }
        if (!shared) grid[cell.r][cell.c] = "";
      }
      used[last.word] = false;
      emptyCount = countEmpty(grid, n);
    }

    if (emptyCount < MIN_MYST || emptyCount > MAX_MYST) return null;
    if (placed.length < 6) return null;
    return { grid: grid, placed: placed, empty: emptyCount };
  }

  // Directions canoniques pour scanner les mots presents dans la grille
  // (on teste aussi le mot inverse, ce qui couvre les 8 sens).
  var SCAN_DIRS = [{ dr: 0, dc: 1 }, { dr: 1, dc: 0 }, { dr: 1, dc: 1 }, { dr: -1, dc: 1 }];

  function keyOf(cells) { return cells.map(function (c) { return c.r + "," + c.c; }).join(";"); }
  function isContiguousSub(A, B) {
    if (A.length >= B.length) return false;
    for (var o = 0; o + A.length <= B.length; o++) {
      var ok = true;
      for (var i = 0; i < A.length; i++) { if (A[i].r !== B[o + i].r || A[i].c !== B[o + i].c) { ok = false; break; } }
      if (ok) return true;
    }
    return false;
  }

  // Tous les mots du pool presents en ligne droite dans la grille, MAXIMAUX
  // (pas sous-segment d'un mot plus long). C'est l'ensemble reellement
  // trouvable par un joueur, pas seulement les mots poses par le generateur :
  // un mot du dico forme "par hasard" par des lettres alignees est accepte.
  function computeFindable(grid, n, poolSet) {
    var maxL = Math.min(10, n);
    var occ = [];
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) {
      for (var di = 0; di < SCAN_DIRS.length; di++) {
        var d = SCAN_DIRS[di];
        for (var len = 4; len <= maxL; len++) {
          var er = r + d.dr * (len - 1), ec = c + d.dc * (len - 1);
          if (er < 0 || er >= n || ec < 0 || ec >= n) continue;
          var s = "", cells = [];
          for (var i = 0; i < len; i++) { var rr = r + d.dr * i, cc = c + d.dc * i; s += grid[rr][cc]; cells.push({ r: rr, c: cc }); }
          if (poolSet[s]) occ.push({ word: s, cells: cells });
          var rs = s.split("").reverse().join("");
          if (rs !== s && poolSet[rs]) occ.push({ word: rs, cells: cells.slice().reverse() });
        }
      }
    }
    // dedoublonne par ensemble de cases
    var seen = {}, uniq = [];
    for (var u = 0; u < occ.length; u++) {
      var sorted = occ[u].cells.slice().sort(function (a, b) { return a.r - b.r || a.c - b.c; });
      var k = keyOf(sorted);
      if (!seen[k]) { seen[k] = true; uniq.push(occ[u]); }
    }
    // ne garde que les maximaux
    return uniq.filter(function (A) {
      return !uniq.some(function (B) {
        if (B === A) return false;
        return isContiguousSub(A.cells, B.cells) || isContiguousSub(A.cells, B.cells.slice().reverse());
      });
    });
  }

  function generate(opts) {
    var n = opts.size;
    var dirKeys = opts.dirKeys || LEVELS[opts.level || "moyen"];
    var rng = makeRng(opts.seed);
    var maxAttempts = opts.maxAttempts || 2000;
    var protectMystery = opts.protectMystery !== false; // vrai par defaut (chill, compet 2)

    var poolByLen = {};
    var poolSet = {};
    var byLen = opts.targetWords;
    for (var L in byLen) {
      if (!byLen.hasOwnProperty(L)) continue;
      var Ln = parseInt(L, 10);
      for (var wi2 = 0; wi2 < byLen[L].length; wi2++) poolSet[byLen[L][wi2]] = true;
      if (Ln > n) continue;
      poolByLen[Ln] = byLen[L];
    }

    var mystByLen = {};
    for (var mi = 0; mi < opts.mysteryBank.length; mi++) {
      var m = opts.mysteryBank[mi];
      if (m.l < MIN_MYST || m.l > MAX_MYST) continue;
      (mystByLen[m.l] = mystByLen[m.l] || []).push(m);
    }

    for (var a = 0; a < maxAttempts; a++) {
      var res = attempt(n, dirKeys, poolByLen, rng);
      if (!res) continue;
      var cand = mystByLen[res.empty];
      if (!cand || !cand.length) continue;
      var myst = pick(cand, rng);
      var slots = emptyCellsReadingOrder(res.grid, n);
      for (var si = 0; si < slots.length; si++) res.grid[slots[si].r][slots[si].c] = myst.w[si];

      var findable = computeFindable(res.grid, n, poolSet);

      // En mode mystere, aucun mot trouvable ne doit passer par une case du
      // mystere (sinon le trouver colorierait une case du mot cache). Sinon on
      // regenere.
      if (protectMystery) {
        var slotSet = {};
        for (var s2 = 0; s2 < slots.length; s2++) slotSet[slots[s2].r + "," + slots[s2].c] = true;
        var touches = findable.some(function (w) {
          return w.cells.some(function (c) { return slotSet[c.r + "," + c.c]; });
        });
        if (touches) continue;
      }

      return {
        grid: res.grid, size: n, placed: res.placed, findable: findable,
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

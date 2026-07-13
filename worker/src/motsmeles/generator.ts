/**
 * Generateur de grille de mots meles (port TS du generateur client, meme algo).
 * La grille est entierement remplie de mots a trouver ; les cases restantes
 * forment, lues de gauche a droite puis de haut en bas, un mot mystere.
 *
 * On empile des mots (amorce longue + remplissage varie pondere sur les
 * longueurs moyennes) jusqu'a ce que le reliquat tombe dans [MIN_MYST, MAX_MYST],
 * puis on choisit un mystere de cette longueur exacte.
 */

import { TARGET_WORDS, MYSTERY_BANK, type TargetWords, type MysteryEntry } from "./data";

export const MIN_MYST = 5;
export const MAX_MYST = 12;

export interface Cell { r: number; c: number; }
export interface PlacedWord { word: string; cells: Cell[]; dir: string; }
export interface GeneratedGrid {
  grid: string[][];
  size: number;
  placed: PlacedWord[];
  mystery: { word: string; definition: string; cells: Cell[] };
  attempts: number;
}

const DIRS: Record<string, { dr: number; dc: number }> = {
  E: { dr: 0, dc: 1 }, S: { dr: 1, dc: 0 }, SE: { dr: 1, dc: 1 }, NE: { dr: -1, dc: 1 },
  W: { dr: 0, dc: -1 }, N: { dr: -1, dc: 0 }, NW: { dr: -1, dc: -1 }, SW: { dr: 1, dc: -1 },
};

export const LEVELS: Record<string, string[]> = {
  facile: ["E", "S", "SE"],
  moyen: ["E", "S", "SE", "NE", "W", "N"],
  difficile: ["E", "S", "SE", "NE", "W", "N", "NW", "SW"],
};

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

interface Placement { r: number; c: number; d: { dr: number; dc: number }; dir: string; crosses: number; }

function placementsFor(word: string, grid: string[][], n: number, dirKeys: string[]): Placement[] {
  const res: Placement[] = [];
  for (const dk of dirKeys) {
    const d = DIRS[dk];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const er = r + d.dr * (word.length - 1);
        const ec = c + d.dc * (word.length - 1);
        if (er < 0 || er >= n || ec < 0 || ec >= n) continue;
        let ok = true, crosses = 0;
        for (let i = 0; i < word.length; i++) {
          const cell = grid[r + d.dr * i][c + d.dc * i];
          if (cell === "") continue;
          if (cell === word[i]) crosses++;
          else { ok = false; break; }
        }
        if (ok) res.push({ r, c, d, dir: dk, crosses });
      }
    }
  }
  return res;
}

function placeWord(word: string, p: Placement, grid: string[][]): Cell[] {
  const cells: Cell[] = [];
  for (let i = 0; i < word.length; i++) {
    const rr = p.r + p.d.dr * i, cc = p.c + p.d.dc * i;
    grid[rr][cc] = word[i];
    cells.push({ r: rr, c: cc });
  }
  return cells;
}

function countEmpty(grid: string[][], n: number): number {
  let e = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (grid[r][c] === "") e++;
  return e;
}
function emptyCellsReadingOrder(grid: string[][], n: number): Cell[] {
  const out: Cell[] = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (grid[r][c] === "") out.push({ r, c });
  return out;
}

function tryPlaceLen(
  L: number, pool: TargetWords, used: Record<string, boolean>,
  grid: string[][], n: number, dirKeys: string[]
): PlacedWord | null {
  const list = pool[L];
  if (!list || !list.length) return null;
  for (let t = 0; t < 8; t++) {
    const w = pick(list);
    if (used[w]) continue;
    const places = placementsFor(w, grid, n, dirKeys);
    if (!places.length) continue;
    places.sort((a, b) => b.crosses - a.crosses);
    const top = places.filter((p) => p.crosses === places[0].crosses);
    const chosen = pick(top.length && Math.random() < 0.65 ? top : places);
    const cells = placeWord(w, chosen, grid);
    used[w] = true;
    return { word: w, cells, dir: chosen.dir };
  }
  return null;
}

interface AttemptResult { grid: string[][]; placed: PlacedWord[]; empty: number; }

function attempt(n: number, dirKeys: string[], pool: TargetWords): AttemptResult | null {
  const grid: string[][] = [];
  for (let r = 0; r < n; r++) { grid[r] = []; for (let c = 0; c < n; c++) grid[r][c] = ""; }

  const maxLen = Math.min(10, n);
  const lengths: number[] = [];
  for (let L = 4; L <= maxLen; L++) if (pool[L] && pool[L].length) lengths.push(L);
  if (!lengths.length) return null;

  const placed: PlacedWord[] = [];
  const used: Record<string, boolean> = {};
  const countLen: Record<number, number> = {};
  const record = (pl: PlacedWord | null) => {
    if (pl) { placed.push(pl); countLen[pl.word.length] = (countLen[pl.word.length] || 0) + 1; }
  };

  const longLens = lengths.filter((L) => L >= Math.max(7, maxLen - 2));
  const seed = n <= 10 ? 2 : n <= 12 ? 3 : 4;
  for (let s = 0; s < seed && longLens.length; s++) {
    record(tryPlaceLen(pick(longLens), pool, used, grid, n, dirKeys));
  }

  let guard = 0;
  while (guard++ < 6000) {
    const empty = countEmpty(grid, n);
    if (empty <= MAX_MYST) break;

    let cand = lengths.filter((L) => L <= empty - MIN_MYST);
    if (!cand.length) cand = lengths.filter((L) => L <= empty);
    if (!cand.length) break;

    const weights = cand.map((L) => {
      const u = countLen[L] || 0;
      const base = Math.exp(-((L - 6.5) * (L - 6.5)) / 7);
      return base / (1 + u * 1.25);
    });
    const sum = weights.reduce((a, b) => a + b, 0);
    let x = Math.random() * sum, L2 = cand[cand.length - 1];
    for (let wi = 0; wi < cand.length; wi++) { x -= weights[wi]; if (x <= 0) { L2 = cand[wi]; break; } }

    const pl = tryPlaceLen(L2, pool, used, grid, n, dirKeys);
    if (!pl) {
      let placedAny = false;
      for (let ci = cand.length - 1; ci >= 0 && !placedAny; ci--) {
        const alt = tryPlaceLen(cand[ci], pool, used, grid, n, dirKeys);
        if (alt) { record(alt); placedAny = true; }
      }
      if (!placedAny) break;
    } else {
      record(pl);
    }
  }

  let emptyCount = countEmpty(grid, n);
  if (emptyCount > MAX_MYST) return null;

  while (emptyCount < MIN_MYST && placed.length) {
    const last = placed.pop()!;
    countLen[last.word.length]--;
    for (const cell of last.cells) {
      let shared = false;
      for (const p of placed) {
        for (const pc of p.cells) if (pc.r === cell.r && pc.c === cell.c) { shared = true; break; }
        if (shared) break;
      }
      if (!shared) grid[cell.r][cell.c] = "";
    }
    used[last.word] = false;
    emptyCount = countEmpty(grid, n);
  }

  if (emptyCount < MIN_MYST || emptyCount > MAX_MYST) return null;
  if (placed.length < 6) return null;
  return { grid, placed, empty: emptyCount };
}

export function generate(opts: {
  size: number; level?: string; dirKeys?: string[]; maxAttempts?: number;
}): GeneratedGrid | null {
  const n = opts.size;
  const dirKeys = opts.dirKeys || LEVELS[opts.level || "moyen"] || LEVELS.moyen;
  const maxAttempts = opts.maxAttempts || 2000;

  const pool: TargetWords = {};
  for (const L in TARGET_WORDS) {
    if (parseInt(L, 10) > n) continue;
    pool[L] = TARGET_WORDS[L];
  }

  const mystByLen: Record<number, MysteryEntry[]> = {};
  for (const m of MYSTERY_BANK) {
    if (m.l < MIN_MYST || m.l > MAX_MYST) continue;
    (mystByLen[m.l] = mystByLen[m.l] || []).push(m);
  }

  for (let a = 0; a < maxAttempts; a++) {
    const res = attempt(n, dirKeys, pool);
    if (!res) continue;
    const cand = mystByLen[res.empty];
    if (!cand || !cand.length) continue;
    const myst = pick(cand);
    const slots = emptyCellsReadingOrder(res.grid, n);
    for (let si = 0; si < slots.length; si++) res.grid[slots[si].r][slots[si].c] = myst.w[si];
    return {
      grid: res.grid, size: n, placed: res.placed,
      mystery: { word: myst.w, definition: myst.d, cells: slots },
      attempts: a + 1,
    };
  }
  return null;
}

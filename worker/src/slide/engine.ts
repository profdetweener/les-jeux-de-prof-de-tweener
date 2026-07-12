/**
 * Moteur pur de Slide, cote serveur. Aucune dependance au DO : uniquement la
 * logique de plateau (decalage, detection de groupes par nouveau voisinage,
 * score). Reutilise a l'identique le proto solo, valide separement.
 */

export interface Card {
  id: number;
  value: number;
}

export interface Group {
  value: number;
  cells: { r: number; c: number }[];
  key: string; // "r,c" de la case en haut a gauche du groupe
  edges: string[];
}

export const VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
export const PER_VALUE = 12;

export function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function makeBag(): number[] {
  const a: number[] = [];
  for (const v of VALUES) for (let k = 0; k < PER_VALUE; k++) a.push(v);
  return shuffle(a);
}

function keyOf(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

/**
 * Remplit un plateau N x N sans aucune paire de meme valeur deja collee :
 * chaque case evite la valeur de ses voisins gauche et haut. Consomme le sac
 * (valeurs) et attribue des identifiants via `nextId`.
 */
export function fillBoard(
  N: number,
  bag: number[],
  nextId: () => number
): Card[][] {
  const board: Card[][] = [];
  for (let r = 0; r < N; r++) {
    const row: Card[] = [];
    for (let c = 0; c < N; c++) {
      const bad = new Set<number>();
      if (c > 0) bad.add(row[c - 1].value);
      if (r > 0) bad.add(board[r - 1][c].value);
      let k = bag.findIndex((v) => !bad.has(v));
      if (k < 0) k = 0;
      const value = bag.splice(k, 1)[0];
      row.push({ id: nextId(), value });
    }
    board.push(row);
  }
  return board;
}

export function edgesOf(board: (Card | null)[][], N: number): Set<string> {
  const e = new Set<string>();
  for (let r = 0; r < N; r++)
    for (let c = 0; c < N; c++) {
      const cur = board[r][c];
      if (!cur) continue;
      if (c + 1 < N) {
        const n = board[r][c + 1];
        if (n && n.value === cur.value) e.add(keyOf(cur.id, n.id));
      }
      if (r + 1 < N) {
        const n = board[r + 1][c];
        if (n && n.value === cur.value) e.add(keyOf(cur.id, n.id));
      }
    }
  return e;
}

export function components(board: (Card | null)[][], N: number): Group[] {
  const seen = Array.from({ length: N }, () => new Array<boolean>(N).fill(false));
  const out: Group[] = [];
  for (let r = 0; r < N; r++)
    for (let c = 0; c < N; c++) {
      if (seen[r][c] || !board[r][c]) continue;
      const val = board[r][c]!.value;
      const st: [number, number][] = [[r, c]];
      const cells: { r: number; c: number }[] = [];
      const es = new Set<string>();
      seen[r][c] = true;
      while (st.length) {
        const [cr, cc] = st.pop()!;
        cells.push({ r: cr, c: cc });
        const nb: [number, number][] = [
          [cr - 1, cc],
          [cr + 1, cc],
          [cr, cc - 1],
          [cr, cc + 1],
        ];
        for (const [nr, nc] of nb) {
          if (nr < 0 || nc < 0 || nr >= N || nc >= N) continue;
          const n = board[nr][nc];
          if (!n || n.value !== val) continue;
          es.add(keyOf(board[cr][cc]!.id, n.id));
          if (!seen[nr][nc]) {
            seen[nr][nc] = true;
            st.push([nr, nc]);
          }
        }
      }
      if (cells.length >= 2) {
        cells.sort((a, b) => a.r - b.r || a.c - b.c);
        out.push({
          value: val,
          cells,
          key: `${cells[0].r},${cells[0].c}`,
          edges: [...es],
        });
      }
    }
  return out;
}

function getLine(board: Card[][], N: number, kind: "row" | "col", i: number): Card[] {
  const l: Card[] = [];
  for (let k = 0; k < N; k++) l.push(kind === "row" ? board[i][k] : board[k][i]);
  return l;
}
function setLine(board: Card[][], N: number, kind: "row" | "col", i: number, arr: Card[]): void {
  for (let k = 0; k < N; k++) {
    if (kind === "row") board[i][k] = arr[k];
    else board[k][i] = arr[k];
  }
}

/**
 * Applique un decalage : insere `inserted` par un bord de la ligne/colonne,
 * tout coulisse d'un cran, renvoie la carte sortie. Mutation en place.
 */
export function applyPush(
  board: Card[][],
  N: number,
  kind: "row" | "col",
  index: number,
  fromStart: boolean,
  inserted: Card
): Card {
  const line = getLine(board, N, kind, index);
  let fallen: Card;
  let nl: Card[];
  if (fromStart) {
    fallen = line[N - 1];
    nl = [inserted, ...line.slice(0, N - 1)];
  } else {
    fallen = line[0];
    nl = [...line.slice(1), inserted];
  }
  setLine(board, N, kind, index, nl);
  return fallen;
}

/**
 * Groupes encaissables apres un coup : composantes de meme valeur (>= 2) qui
 * ont gagne au moins un voisinage cree par ce coup.
 */
export function litGroups(
  board: Card[][],
  N: number,
  before: Set<string>
): Group[] {
  const after = edgesOf(board, N);
  const isNew = (k: string) => after.has(k) && !before.has(k);
  return components(board, N).filter((g) => g.edges.some(isNew));
}

export function scoreOf(g: Group): number {
  const n = g.cells.length;
  return g.value * n + n * (n - 1);
}

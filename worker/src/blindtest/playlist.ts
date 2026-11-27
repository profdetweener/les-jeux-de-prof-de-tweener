/**
 * Playlist et verification des reponses du Blind Test en navigateur.
 *
 * La playlist est la meme que celle du mode tchat (blindtest/playlist.txt),
 * copiee ici pour que le serveur choisisse les morceaux et verifie les
 * reponses sans jamais les envoyer aux joueurs a l'avance.
 * Format : deezer:ID | titre(s) | artiste(s) | annee | notoriete
 *
 * La comparaison reprend celle du mode tchat : accents, ponctuation et
 * articles ignores, petites fautes tolerees, et un mot significatif suffit
 * (le nom de famille pour l'artiste, un mot-cle du titre).
 */

import PLAYLIST from "./data/playlist.txt";

export interface Variant { orig: string; norm: string; }
export interface Track {
  id: string;            // ID Deezer
  titles: Variant[];
  artists: Variant[];
  year: number | null;
  pop: number | null;
}

export function normalize(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(the|le|la|les|un|une|des|du)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array<number>(n + 1), cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

// La reponse apparait-elle dans le message, avec tolerance ?
function fuzzyContains(msg: string, v: string, tolPct: number): boolean {
  const L = v.length;
  if (!L) return false;
  if (msg.includes(v)) return true;
  // Reponses tres courtes : quasi exact, pour eviter les faux positifs.
  const maxDist = L <= 4 ? 0 : Math.max(1, Math.floor(L * (tolPct / 100)));
  if (maxDist === 0) return false;
  const M = msg.length;
  for (let i = 0; i <= M; i++) {
    for (let w = Math.max(1, L - maxDist); w <= L + maxDist; w++) {
      if (i + w > M + 1) break;
      const sub = msg.substr(i, w);
      if (!sub || Math.abs(sub.length - L) > maxDist) continue;
      if (levenshtein(sub, v) <= maxDist) return true;
    }
  }
  return false;
}

// Le message contient la reponse entiere, ou un de ses mots significatifs.
export function matchesAny(msgNorm: string, variants: Variant[], tolPct: number): boolean {
  return variants.some((v) => {
    if (fuzzyContains(msgNorm, v.norm, tolPct)) return true;
    return v.norm.split(" ").filter((w) => w.length >= 4).some((w) => fuzzyContains(msgNorm, w, tolPct));
  });
}

let cache: Track[] | null = null;
export function tracks(): Track[] {
  if (cache) return cache;
  const out: Track[] = [];
  const seen = new Set<string>();
  for (const raw of (PLAYLIST as string).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("|").map((p) => p.trim());
    const m = /^deezer:(\d+)$/i.exec(parts[0] || "");
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    const mk = (s: string) => (s || "").split(",").map((x) => x.trim()).filter(Boolean)
      .map((orig) => ({ orig, norm: normalize(orig) })).filter((v) => v.norm);
    const titles = mk(parts[1]), artists = mk(parts[2]);
    if (!titles.length && !artists.length) continue;
    const year = parseInt(parts[3] || "", 10);
    const pop = parseInt(parts[4] || "", 10);
    out.push({ id: m[1], titles, artists, year: Number.isFinite(year) ? year : null, pop: Number.isFinite(pop) ? pop : null });
  }
  cache = out;
  return out;
}

export function decadesOf(list: Track[]): number[] {
  return [...new Set(list.map((t) => t.year).filter((y): y is number => !!y).map((y) => Math.floor(y / 10) * 10))]
    .sort((a, b) => a - b);
}

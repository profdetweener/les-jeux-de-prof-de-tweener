/**
 * Dictionnaire et syllabes de Pression.
 *
 * Les donnees sont generees par scripts/build-pression-dict.mjs a partir du
 * Lefff (Inria, LGPL-LR), sans les formes conjuguees. Voir ce script pour
 * les regenerer.
 *
 * Le Set de mots est construit a la premiere partie lancee, puis partage par
 * toutes les rooms de l'isolat (variable de module) : ~117 000 mots.
 */

import MOTS from "./data/mots.txt";
import SYLLABES from "./data/syllabes.json";
import type { Level, Rule } from "./messages";

type Pool = Array<[string, number]>;
const DATA = SYLLABES as unknown as { contient: Pool; commence: Pool; finit: Pool };

let WORDS: Set<string> | null = null;
function words(): Set<string> {
  if (!WORDS) WORDS = new Set(MOTS.split("\n").filter((w) => w.length > 0));
  return WORDS;
}

/** Charge le dictionnaire a l'avance (au lancement d'une partie). */
export function warmUp(): void { words(); }

export function isWord(w: string): boolean { return words().has(w); }

/** Normalisation commune au script de generation : A-Z, sans accent ni tiret. */
export function norm(s: string): string {
  return String(s || "")
    .replace(/œ/g, "oe").replace(/Œ/g, "OE").replace(/æ/g, "ae").replace(/Æ/g, "AE")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().replace(/[^A-Z]/g, "");
}

// Niveaux : on tire dans les N syllabes les plus fournies (pools inclusifs :
// une syllabe "facile" peut tomber en "difficile"). Par rang plutot que par
// seuil, pour que les niveaux tiennent si on regenere le dictionnaire.
// Sur la liste actuelle, la syllabe la moins fournie de chaque pool accepte :
//   contient : 1205 / 409 / 138 mots
//   commence :  517 / 160 /  62
//   finit    :  978 / 160 /  45
const RANKS: Record<Level, { contient: number; commence: number; finit: number }> = {
  facile:    { contient: 300,  commence: 100, finit: 50 },
  moyen:     { contient: 800,  commence: 300, finit: 150 },
  difficile: { contient: 1600, commence: 650, finit: 300 },
};

// Regle "chaine" : la syllabe suivante = les 2 dernieres lettres du mot joue,
// en debut de mot. En dessous de ce nombre de mots possibles, la chaine casse
// et on tire une syllabe "commence" au hasard (sinon, impasse garantie).
export const CHAIN_MIN = 25;

const POOLS = new Map<string, string[]>();
function pool(kind: "contient" | "commence" | "finit", level: Level): string[] {
  const key = kind + ":" + level;
  let p = POOLS.get(key);
  if (!p) {
    p = DATA[kind].slice(0, RANKS[level][kind]).map(([s]) => s);
    POOLS.set(key, p);
  }
  return p;
}

const START_COUNT = new Map<string, number>(DATA.commence);
export function startCount(s: string): number { return START_COUNT.get(s) || 0; }

/**
 * Tire une syllabe pour la regle, en evitant les syllabes recentes.
 * "chaine" tire dans le pool "commence" (debut de manche ou chaine cassee).
 */
export function drawSyllable(rule: Rule, level: Level, recent: string[]): string {
  const kind = rule === "chaine" ? "commence" : rule;
  const p = pool(kind, level);
  for (let i = 0; i < 20; i++) {
    const s = p[Math.floor(Math.random() * p.length)];
    if (!recent.includes(s)) return s;
  }
  return p[Math.floor(Math.random() * p.length)];
}

/** Vrai si le mot respecte la regle pour la syllabe (sans regarder le dictionnaire). */
export function matchesRule(word: string, rule: Rule, syl: string): boolean {
  if (word.length <= syl.length) return false;
  if (rule === "contient") return word.includes(syl);
  if (rule === "finit") return word.endsWith(syl);
  return word.startsWith(syl); // commence, chaine
}

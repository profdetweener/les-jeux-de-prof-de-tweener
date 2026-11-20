/**
 * Genere le dictionnaire de Pression (sans formes conjuguees).
 *
 *   node scripts/build-pression-dict.mjs chemin/vers/lefff-3.4.mlex
 *
 * Source : le Lefff, Lexique des formes flechies du francais (Benoit Sagot,
 * Inria), licence LGPL-LR. Fourni par le paquet npm "node-lefff"
 * (dossier src/lefff-3.4.mlex/ : npm pack node-lefff, puis decompresser).
 * Il donne la nature de chaque forme, ce qui permet d'ecarter les
 * conjugaisons.
 *
 * Regle de tri :
 *  - on GARDE une forme si le Lefff la connait comme nom commun, adjectif
 *    (hors participe), adverbe, preposition, conjonction, determinant ou
 *    pronom, ou comme verbe a l'infinitif. Pluriels et feminins compris.
 *    Ex. : PORTE, MARCHE, LIVRES (aussi des noms), FATIGUE, COURANT (adjectifs
 *    a part entiere), MANGER.
 *  - on RETIRE une forme que le Lefff ne connait que comme verbe conjugue ou
 *    participe. Ex. : MANGE, MANGEONS, CHANTAIT, MANGEES.
 *  - noms propres exclus, 3 lettres minimum.
 *
 * Sorties (dans src/pression/data/) :
 *  - mots.txt      : un mot par ligne, normalise (A-Z, sans accent ni tiret).
 *  - syllabes.json : pour chaque regle, les syllabes de 2 et 3 lettres avec le
 *                    nombre de mots qui les acceptent, triees par frequence.
 *  - LICENSE-LGPLLR.txt : copie de la licence du Lefff (obligatoire).
 *
 * Pour ajouter ou retirer des mots a la main : listes AJOUTS / RETRAITS
 * ci-dessous, puis relancer.
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [lefffPath] = process.argv.slice(2);
if (!lefffPath) {
  console.error("Usage : node scripts/build-pression-dict.mjs lefff-3.4.mlex");
  process.exit(1);
}

// Retouches manuelles (mots normalises, en majuscules sans accent).
const AJOUTS = ["SMARTPHONE", "SMARTPHONES", "STREAMER", "STREAMERS", "TCHAT", "TCHATS", "EMOJI", "EMOJIS"];
const RETRAITS = [];

// Meme normalisation que le worker (src/pression/dict.ts).
function norm(s) {
  return String(s)
    .replace(/œ/g, "oe").replace(/Œ/g, "OE").replace(/æ/g, "ae").replace(/Æ/g, "AE")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().replace(/[^A-Z]/g, "");
}

// ----- Lefff : formes acceptees / formes seulement verbales -----
const KEEP_POS = new Set(["nc", "adj", "adv", "prep", "csu", "det", "pro", "coo", "pri", "prel", "pres"]);
const lefffOk = new Set();      // au moins un emploi non conjugue
const lefffVerbal = new Set();  // au moins un emploi conjugue / participe
const FORM_RE = /^[a-zàâäçéèêëîïôöùûüÿœæ'-]+$/;

for (const line of readFileSync(lefffPath, "utf8").split(/\r?\n/)) {
  const p = line.split("\t");
  if (p.length < 4) continue;
  const [form, pos, , tag] = p;
  if (!FORM_RE.test(form)) continue;
  const n = norm(form);
  if (n.length < 3) continue;
  if (pos === "v") {
    if (tag === "W") lefffOk.add(n);           // infinitif
    else lefffVerbal.add(n);
  } else if (pos === "adj" && /^[KG]/.test(tag)) {
    lefffVerbal.add(n);                        // participe employe comme adjectif
  } else if (KEEP_POS.has(pos)) {
    lefffOk.add(n);
  }
}

const words = new Set(lefffOk);
for (const w of AJOUTS) words.add(norm(w));
for (const w of RETRAITS) words.delete(norm(w));
const sorted = [...words].filter((w) => w.length >= 3).sort();

// ----- Syllabes -----
// Un mot compte une fois par syllabe. Le mot peut etre la syllabe elle-meme
// (meme regle que le serveur).
const contient = new Map(), commence = new Map(), finit = new Map();
const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
for (const w of sorted) {
  const seen = new Set();
  for (const L of [2, 3]) {
    for (let i = 0; i + L <= w.length; i++) seen.add(w.slice(i, i + L));
    if (w.length >= L) { inc(commence, w.slice(0, L)); inc(finit, w.slice(-L)); }
  }
  for (const s of seen) inc(contient, s);
}
// "commence" est garde en entier : la regle chaine a besoin du compte de
// n'importe quel debut de 2 lettres. Ailleurs, on coupe sous 20 mots.
const toList = (m, min) => [...m.entries()].filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
const data = {
  source: "Lefff 3.4 (Benoit Sagot, Inria), LGPL-LR, sans les formes conjuguees",
  mots: sorted.length,
  contient: toList(contient, 20),
  commence: toList(commence, 1),
  finit: toList(finit, 20),
};

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "src", "pression", "data");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "mots.txt"), sorted.join("\n") + "\n");
writeFileSync(join(out, "syllabes.json"), JSON.stringify(data));
const lic = join(dirname(lefffPath), "LICENSE");
if (existsSync(lic)) copyFileSync(lic, join(out, "LICENSE-LGPLLR.txt"));
console.log(`${sorted.length} mots.`);
console.log(`${data.contient.length} syllabes "contient", ${data.commence.length} debuts, ${data.finit.length} fins.`);

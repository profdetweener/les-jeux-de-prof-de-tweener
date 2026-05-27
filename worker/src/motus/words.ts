/**
 * Motus — coloration des essais et validation des mots.
 *
 * La coloration suit l'algo standard "Wordle" (2 passes), enrichi du drapeau
 * `hasMore` pour la 4e situation : lettre bien placee ET presente ailleurs.
 *
 * Le dictionnaire est embarque (importe en JSON) :
 *   - playable.json : mots autorises a la saisie (~180k, 5-10 lettres)
 *   - drawable.json : sous-ensemble curé pour le tirage du mot a deviner (~45k)
 *
 * Les deux fichiers sont des dictionnaires { "5": [...], ..., "10": [...] }
 * indexes par longueur, listes triees ASC pour la recherche binaire.
 */

import playableData from "./data/playable.json";
import drawableData from "./data/drawable.json";
import type { Attempt, LetterFeedback, LetterStatus } from "./messages";

// Le type assertion contourne le fait que TS infère un type tres precis depuis
// le JSON (toutes les cles en dur). On veut une signature generique.
const PLAYABLE: Record<string, string[]> = playableData as Record<string, string[]>;
const DRAWABLE: Record<string, string[]> = drawableData as Record<string, string[]>;

/**
 * Verifie si un mot est dans la liste playable (autorise a la saisie).
 * Recherche binaire pour rester O(log n) sur 30k+ mots par longueur.
 */
export function isPlayableWord(word: string): boolean {
  const upper = word.toUpperCase();
  const list = PLAYABLE[String(upper.length)];
  if (!list) return false;
  // Recherche binaire (les listes sont triees ASC)
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cmp = list[mid].localeCompare(upper);
    if (cmp === 0) return true;
    if (cmp < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/**
 * Tire un mot aleatoire de longueur donnee dans la liste drawable.
 * Renvoie null si la longueur n'est pas couverte.
 */
export function pickRandomWord(length: number): string | null {
  const list = DRAWABLE[String(length)];
  if (!list || list.length === 0) return null;
  const i = Math.floor(Math.random() * list.length);
  return list[i];
}

/**
 * Renvoie le nombre de mots tirables d'une longueur donnee. Utile pour
 * verifier que la config de partie est viable.
 */
export function drawablePoolSize(length: number): number {
  const list = DRAWABLE[String(length)];
  return list ? list.length : 0;
}

/**
 * Colore un essai par rapport a un mot cible.
 *
 * Algo en 3 passes :
 *   1) Marquer toutes les positions "good" (lettre bonne et a la bonne place).
 *      Construire un compteur des lettres restantes dans le mot cible.
 *   2) Pour les positions non-"good", consommer du compteur pour decider
 *      entre "misplaced" et "absent".
 *   3) Pour chaque case "good", calculer hasMore : existe-t-il encore une
 *      autre occurrence de cette lettre dans le mot cible qui n'est PAS
 *      deja correctement placee dans l'essai ?
 *
 * Pre-conditions :
 *   - target et guess sont uppercase, A-Z, meme longueur
 *   - target est un mot legal (verifie en amont)
 *
 * @param target le mot a deviner (uppercase, A-Z)
 * @param guess  l'essai du joueur (uppercase, A-Z, meme longueur)
 */
export function colorize(target: string, guess: string): Attempt {
  const n = target.length;
  if (guess.length !== n) {
    throw new Error(`colorize: length mismatch (target=${n}, guess=${guess.length})`);
  }

  const status: LetterStatus[] = new Array(n).fill("absent");
  // Compteur des lettres restantes dans le mot cible (apres avoir consomme
  // les positions "good").
  const remaining: Record<string, number> = {};
  for (const ch of target) remaining[ch] = (remaining[ch] ?? 0) + 1;

  // Passe 1 : positions exactes
  for (let i = 0; i < n; i++) {
    if (guess[i] === target[i]) {
      status[i] = "good";
      remaining[guess[i]]--;
    }
  }
  // Passe 2 : positions decalees
  for (let i = 0; i < n; i++) {
    if (status[i] === "good") continue;
    const ch = guess[i];
    if ((remaining[ch] ?? 0) > 0) {
      status[i] = "misplaced";
      remaining[ch]--;
    }
    // sinon reste "absent"
  }

  // Passe 3 : calcul du drapeau hasMore pour les cases "good".
  //
  // hasMore[i] vaut true ssi guess[i] est "good" ET il existe au moins une
  // autre occurrence de cette lettre dans target qui n'est pas DEJA signalee
  // au joueur (par un "good" ou un "misplaced" sur cette meme lettre).
  //
  // Implementation : pour chaque lettre,
  //   countInTarget(letter) = nb total dans target
  //   countSignaled(letter) = nb de "good" + nb de "misplaced" dans guess
  // hasMore vrai ssi countInTarget > countSignaled.
  const countInTarget: Record<string, number> = {};
  for (const ch of target) countInTarget[ch] = (countInTarget[ch] ?? 0) + 1;
  const countSignaled: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    if (status[i] === "good" || status[i] === "misplaced") {
      const ch = guess[i];
      countSignaled[ch] = (countSignaled[ch] ?? 0) + 1;
    }
  }

  const feedback: LetterFeedback[] = [];
  for (let i = 0; i < n; i++) {
    const ch = guess[i];
    let hasMore = false;
    if (status[i] === "good") {
      const total = countInTarget[ch] ?? 0;
      const signaled = countSignaled[ch] ?? 0;
      hasMore = total > signaled;
    }
    feedback.push({ letter: ch, status: status[i], hasMore });
  }
  return { guess, feedback };
}

/**
 * Normalise un essai utilisateur : trim, uppercase, suppression des accents.
 * On accepte que l'utilisateur tape "banané" ou " BANANE " — ça donne "BANANE".
 */
export function normalizeGuess(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim();
}

/**
 * Module de scoring de la manche (modele collaboratif).
 *
 * Les joueurs editent collectivement l'etat de chaque cellule (cellStates),
 * et le score final est une simple lecture de cet etat. Plus de calcul
 * de majorite, plus de detection automatique de doublon : c'est l'etat
 * partage qui fait foi.
 */

import type { LengthConstraint, ScoringConfig, VoteValue } from "./messages";

/**
 * Normalise une chaine pour comparaison :
 *   - supprime les accents (NFD + suppression diacritiques)
 *   - lowercase
 *   - supprime espaces de tete/queue
 *   - reduit espaces multiples a un seul
 *
 * Utilise pour normaliser les categories (eviter les doublons en config)
 * et pour la verification "commence par la bonne lettre".
 */
export function normalizeAnswer(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * La reponse commence-t-elle par la lettre attendue (apres normalisation) ?
 * Renvoie false si reponse vide.
 */
export function answerMatchesLetter(answer: string, letter: string): boolean {
  const normalized = normalizeAnswer(answer);
  if (normalized.length === 0) return false;
  const expected = normalizeAnswer(letter);
  return normalized.startsWith(expected);
}

/**
 * La reponse respecte-t-elle la contrainte de longueur (si une est definie) ?
 *
 * On compte les caracteres apres normalisation (donc trim + dedup espaces,
 * sans les accents). Cela donne une longueur stable et previsible cote
 * client et serveur.
 *
 * Si la contrainte est absente, "none", ou invalide, on renvoie toujours
 * true (= pas de contrainte applique).
 *
 * Renvoie false si la reponse est vide (longueur 0).
 */
export function answerMatchesLength(
  answer: string,
  constraint: LengthConstraint | undefined | null
): boolean {
  const normalized = normalizeAnswer(answer);
  if (normalized.length === 0) return false;
  if (!constraint || constraint.mode === "none") return true;
  if (typeof constraint.value !== "number" || !Number.isFinite(constraint.value)) {
    return true;
  }
  const len = normalized.length;
  if (constraint.mode === "min") return len >= constraint.value;
  if (constraint.mode === "max") return len <= constraint.value;
  return true;
}

/**
 * Helper unifie : la reponse est-elle syntaxiquement valide pour cette manche ?
 * = non-vide + bonne lettre + respecte la contrainte de longueur.
 *
 * Une cellule syntaxiquement invalide est forcee a "reject" (= invalidOrEmpty
 * points) au scoring, peu importe ce qu'on a vote dessus, et le STOP est
 * refuse tant qu'au moins une cellule est syntaxiquement invalide.
 */
export function answerIsSyntacticallyValid(
  answer: string,
  letter: string,
  lengthConstraint: LengthConstraint | undefined | null
): boolean {
  return (
    answerMatchesLetter(answer, letter) &&
    answerMatchesLength(answer, lengthConstraint)
  );
}

/**
 * Calcule les scores de la manche en lisant directement les cellStates.
 *
 * Regles :
 *   1. Si reponse vide ou ne commence pas par la lettre : invalidOrEmpty
 *      (peu importe ce que dit cellStates : la realite syntaxique l'emporte)
 *   2. Sinon, lecture directe de cellStates :
 *      - "reject"    -> invalidOrEmpty
 *      - "duplicate" -> duplicateAnswer
 *      - "unique"    -> uniqueAnswer (ou aloneInCategory si seul valide)
 *   3. Le cas "seul valide dans la categorie" : si un seul joueur a une cellule
 *      `unique` ou `duplicate` (= valide) dans la categorie, il prend aloneInCategory.
 */
export function computeRoundScores(
  letter: string,
  categories: string[],
  pseudos: string[],
  answers: Record<string, Record<string, string>>,
  cellStates: Record<string, Record<string, VoteValue>>,
  scoring: ScoringConfig,
  lengthConstraint?: LengthConstraint | null
): {
  cellScores: Record<string, Record<string, number>>;
  scoreByPlayer: Record<string, number>;
} {
  const cellScores: Record<string, Record<string, number>> = {};
  const scoreByPlayer: Record<string, number> = {};

  for (const p of pseudos) {
    cellScores[p] = {};
    scoreByPlayer[p] = 0;
  }

  for (const category of categories) {
    // Etape 1 : pour chaque joueur, determiner l'etat effectif de la cellule.
    // Une cellule dont la reponse n'est pas syntaxiquement valide (vide,
    // mauvaise lettre, ou contrainte de longueur violee) est forcee a
    // "reject", peu importe ce que dit cellStates.
    const effectiveStates: Record<string, VoteValue> = {};
    for (const pseudo of pseudos) {
      const raw = answers[pseudo]?.[category] ?? "";
      if (!answerIsSyntacticallyValid(raw, letter, lengthConstraint)) {
        effectiveStates[pseudo] = "reject";
        continue;
      }
      const declared = cellStates[pseudo]?.[category] ?? "unique";
      effectiveStates[pseudo] = declared;
    }

    // Etape 2 : compter les joueurs avec cellule valide (unique ou duplicate)
    const validCount = Object.values(effectiveStates).filter(
      (s) => s === "unique" || s === "duplicate"
    ).length;

    // Etape 3 : score par joueur
    for (const pseudo of pseudos) {
      const state = effectiveStates[pseudo];
      let score: number;
      if (state === "reject") {
        score = scoring.invalidOrEmpty;
      } else if (state === "duplicate") {
        score = scoring.duplicateAnswer;
      } else {
        // state === "unique"
        score = validCount === 1 ? scoring.aloneInCategory : scoring.uniqueAnswer;
      }
      cellScores[pseudo][category] = score;
      scoreByPlayer[pseudo] += score;
    }
  }

  return { cellScores, scoreByPlayer };
}

/**
 * Tirage d'une lettre dans le pool, en evitant celles deja tirees.
 * Si toutes ont ete tirees, on reset le pool.
 */
export function drawLetter(
  pool: string,
  alreadyDrawn: string[]
): string {
  const remaining = pool.split("").filter((l) => !alreadyDrawn.includes(l));
  const candidates = remaining.length > 0 ? remaining : pool.split("");
  const buf = new Uint8Array(1);
  crypto.getRandomValues(buf);
  return candidates[buf[0] % candidates.length];
}

/**
 * Validation de la GameConfig fournie par le host.
 */
export function validateGameConfig(
  cfg: unknown
):
  | { ok: true }
  | { ok: false; error: string } {
  if (!cfg || typeof cfg !== "object") {
    return { ok: false, error: "Configuration invalide." };
  }
  const c = cfg as Record<string, unknown>;

  if (!Array.isArray(c.categories)) {
    return { ok: false, error: "Categories manquantes." };
  }
  const cats = c.categories as unknown[];
  if (cats.length < 2 || cats.length > 12) {
    return { ok: false, error: "Entre 2 et 12 categories." };
  }
  for (const cat of cats) {
    if (typeof cat !== "string" || cat.trim().length === 0 || cat.length > 30) {
      return { ok: false, error: "Categorie invalide ou trop longue." };
    }
  }
  const normCats = cats.map((c) => normalizeAnswer(c as string));
  if (new Set(normCats).size !== normCats.length) {
    return { ok: false, error: "Categories en doublon." };
  }

  if (typeof c.totalRounds !== "number" || c.totalRounds < 0 || c.totalRounds > 20) {
    return { ok: false, error: "Nombre de manches invalide." };
  }
  if (typeof c.timerSeconds !== "number" || c.timerSeconds < 30 || c.timerSeconds > 300) {
    return { ok: false, error: "Timer invalide (30-300 sec)." };
  }
  if (!c.scoring || typeof c.scoring !== "object") {
    return { ok: false, error: "Bareme manquant." };
  }
  const s = c.scoring as Record<string, unknown>;
  for (const k of ["aloneInCategory", "uniqueAnswer", "duplicateAnswer", "invalidOrEmpty"]) {
    if (typeof s[k] !== "number" || !Number.isFinite(s[k]) || (s[k] as number) < -100 || (s[k] as number) > 100) {
      return { ok: false, error: `Bareme invalide (${k}).` };
    }
  }
  // Champ optionnel : cheaterPenaltyPerCheat (≤ 0, ≥ -100). Absent ou invalide -> traite comme 0.
  if (s.cheaterPenaltyPerCheat !== undefined) {
    const cp = s.cheaterPenaltyPerCheat;
    if (typeof cp !== "number" || !Number.isFinite(cp) || cp > 0 || cp < -100) {
      return { ok: false, error: "Malus tricheur invalide (entre -100 et 0)." };
    }
  }
  // Champ optionnel : endMode. Absent ou invalide -> traite comme "stop_or_timer".
  if (c.endMode !== undefined && c.endMode !== "stop_or_timer" && c.endMode !== "timer_only") {
    return { ok: false, error: "Mode de fin de manche invalide." };
  }
  // Champ optionnel : letterPool. Doit etre une chaine de caracteres A-Z (uppercase),
  // au moins 1 lettre. Si absent ou invalide, le serveur retombe sur le pool par defaut.
  if (c.letterPool !== undefined) {
    if (typeof c.letterPool !== "string") {
      return { ok: false, error: "Pool de lettres invalide." };
    }
    // On accepte le pool meme avec des minuscules ou doublons, le serveur normalisera.
    const cleaned = c.letterPool.toUpperCase().replace(/[^A-Z]/g, "");
    if (cleaned.length === 0) {
      return { ok: false, error: "Au moins une lettre est requise." };
    }
  }
  // Champ optionnel : lengthConstraint. Absent ou mode "none" -> aucune contrainte.
  if (c.lengthConstraint !== undefined && c.lengthConstraint !== null) {
    if (typeof c.lengthConstraint !== "object") {
      return { ok: false, error: "Contrainte de longueur invalide." };
    }
    const lc = c.lengthConstraint as Record<string, unknown>;
    if (lc.mode !== "none" && lc.mode !== "min" && lc.mode !== "max") {
      return { ok: false, error: "Mode de contrainte de longueur invalide." };
    }
    if (lc.mode !== "none") {
      if (
        typeof lc.value !== "number" ||
        !Number.isFinite(lc.value) ||
        !Number.isInteger(lc.value) ||
        lc.value < 1 ||
        lc.value > 30
      ) {
        return { ok: false, error: "Longueur invalide (entre 1 et 30)." };
      }
    }
  }
  return { ok: true };
}

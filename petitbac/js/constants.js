/**
 * Constantes partagees cote frontend.
 * En miroir du fichier worker/src/messages.ts (CATEGORY_PRESETS, ROUND_CONFIG).
 */

export const CATEGORY_PRESETS = [
  "Pays",
  "Ville",
  "Animal",
  "Prenom",
  "Metier",
  "Fruit / Legume",
  "Couleur",
  "Sport",
  "Marque",
  "Film",
  "Personnage celebre",
  "Plat / Cuisine",
  "Objet de la maison",
  "Vetement",
  "Instrument de musique",
];

export const LIMITS = {
  MIN_CATEGORIES: 2,
  MAX_CATEGORIES: 12,
  MAX_ANSWER_LEN: 50,
  MIN_CHEATER_PENALTY: -100,
  MAX_CHEATER_PENALTY: 0,
  // Bornes pour la contrainte de longueur de mot (cf. worker/messages.ts)
  MIN_WORD_LEN_BOUND: 1,
  MAX_WORD_LEN_BOUND: 30,
};

export const END_MODES = {
  STOP_OR_TIMER: "stop_or_timer",
  TIMER_ONLY: "timer_only",
};

/**
 * Normalisation pour comparaison (memes regles que cote serveur).
 * Insensible casse + accents + espaces multiples.
 */
export function normalizeAnswer(s) {
  return (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Une reponse commence-t-elle par la lettre attendue (apres normalisation) ?
 */
export function answerMatchesLetter(answer, letter) {
  const normalized = normalizeAnswer(answer);
  if (!normalized) return false;
  return normalized.startsWith(normalizeAnswer(letter));
}

/**
 * La reponse respecte-t-elle la contrainte de longueur (si une est definie) ?
 * Miroir exact de answerMatchesLength cote serveur (scoring.ts).
 *
 * On compte les caracteres apres normalisation (trim + dedup espaces).
 * Une reponse vide echoue toujours. Une contrainte absente ou en mode "none"
 * laisse toujours passer (sauf cas vide).
 */
export function answerMatchesLength(answer, constraint) {
  const normalized = normalizeAnswer(answer);
  if (!normalized) return false;
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
 * C'est cette regle qui determine si on peut faire STOP et si une cellule
 * est votable en phase de validation.
 */
export function answerIsSyntacticallyValid(answer, letter, lengthConstraint) {
  return (
    answerMatchesLetter(answer, letter) &&
    answerMatchesLength(answer, lengthConstraint)
  );
}

/**
 * Construit une description courte de la contrainte de longueur, utilisable
 * dans l'UI (toasts, tooltips, statut). Renvoie null si pas de contrainte.
 */
export function describeLengthConstraint(constraint) {
  if (!constraint || constraint.mode === "none") return null;
  if (constraint.mode === "min") return `au moins ${constraint.value} lettres`;
  if (constraint.mode === "max") return `au plus ${constraint.value} lettres`;
  return null;
}

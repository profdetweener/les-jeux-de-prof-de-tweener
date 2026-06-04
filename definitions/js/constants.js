/**
 * Constantes partagees cote frontend — Definitions.
 * En miroir de worker/src/definition/messages.ts.
 */

export const LIMITS = {
  MIN_TIMER_SEC: 30,
  MAX_TIMER_SEC: 600,
  DEFAULT_TIMER_SEC: 120,
  MIN_ROUNDS: 1,
  MAX_ROUNDS: 30,
  MAX_DEFINITION_LEN: 280,
  MIN_POINTS_PER_ROUND: 10,
  MAX_POINTS_PER_ROUND: 1000,
  DEFAULT_POINTS_PER_ROUND: 100,
};

// Valeurs de vote autorisees + libelles courts pour les boutons
export const VOTE_VALUES = [0, 0.25, 0.5, 0.75, 1];
export const VOTE_LABELS = {
  0: "0",
  0.25: "¼",
  0.5: "½",
  0.75: "¾",
  1: "1",
};

export const AGGREGATION_LABELS = {
  trimmed: "Moyenne tronquée (recommandé)",
  mean: "Moyenne simple",
  median: "Médiane",
};

export const AGGREGATION_HINTS = {
  trimmed:
    "On retire la note la plus haute et la plus basse avant de moyenner (dès 4 votes). Neutralise un saboteur isolé.",
  mean: "Moyenne de tous les votes reçus. Simple, mais sensible aux votes extrêmes.",
  median: "Valeur centrale des votes reçus. Très robuste à un vote extrême isolé.",
};

/**
 * Couleur d'une note (0..1) : échelle rouge -> jaune -> vert.
 * Sert pour les pastilles de vote (lecture seule) et les badges d'agrégat.
 */
export function voteColor(value) {
  const v = Math.max(0, Math.min(1, Number(value) || 0));
  // 0 -> rouge (0deg), 0.5 -> jaune (~50deg), 1 -> vert (~120deg)
  const hue = Math.round(v * 120);
  return `hsl(${hue}, 62%, 42%)`;
}

/** Formate une note 0..1 de façon compacte (0, ¼, ½, ¾, 1 si pile, sinon 0.62). */
export function formatVote(value) {
  if (value === null || value === undefined) return "·";
  const labels = VOTE_LABELS;
  if (Object.prototype.hasOwnProperty.call(labels, value)) return labels[value];
  return (Math.round(value * 100) / 100).toString();
}

/** Formate un agrégat 0..1 en pourcentage lisible (ex. "0.75" -> "75 %"). */
export function formatAggregate(value) {
  if (value === null || value === undefined) return "—";
  return `${Math.round(value * 100)} %`;
}

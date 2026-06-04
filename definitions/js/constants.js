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
};

/**
 * Bareme fixe : le score d'une manche pour un auteur vaut
 *   round(agregat(0..1) × POINTS_PER_ROUND).
 * Une moyenne de 0.7 donne donc 7 points.
 */
export const POINTS_PER_ROUND = 10;

/**
 * Granularite du slider de vote (cote client). Le serveur accepte n'importe
 * quelle valeur dans [0, 1] et arrondit a 2 decimales.
 */
export const VOTE_STEP = 0.05;

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
 * Couleur SATUREE d'une note (0..1) : echelle rouge -> jaune -> vert.
 * Sert pour les badges d'agregat dans la vue Scores (texte blanc dessus).
 */
export function voteColor(value) {
  const v = Math.max(0, Math.min(1, Number(value) || 0));
  // 0 -> rouge (0deg), 0.5 -> jaune (~60deg), 1 -> vert (~120deg)
  const hue = Math.round(v * 120);
  return `hsl(${hue}, 62%, 42%)`;
}

/**
 * Couleur PASTEL d'une note (0..1) : pour remplir le fond des cellules de la
 * matrice de vote. Pensee pour avoir une lecture immediate, sans texte.
 */
export function voteCellBg(value) {
  const v = Math.max(0, Math.min(1, Number(value) || 0));
  const hue = Math.round(v * 120);
  // Saturation moderee + clarte haute = pastel. La clarte baisse legerement
  // au milieu pour eviter un jaune trop delave.
  const sat = 70;
  const light = 80 - Math.abs(v - 0.5) * 6; // 80 -> 77 au centre -> 80
  return `hsl(${hue}, ${sat}%, ${light}%)`;
}

/** Formate un agrégat 0..1 en pourcentage lisible (ex. "0.75" -> "75 %"). */
export function formatAggregate(value) {
  if (value === null || value === undefined) return "—";
  return `${Math.round(value * 100)} %`;
}

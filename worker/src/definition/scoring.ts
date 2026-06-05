/**
 * Scoring de la manche pour Definitions.
 *
 * Le score d'un AUTEUR pour une manche depend des votes que LES AUTRES ont
 * donnes a sa proposition. On agrege ces votes (0..1) selon la methode choisie,
 * puis on multiplie par DEF_CONFIG.POINTS_PER_ROUND (= 10, fixe).
 *
 * L'agregation est aussi le rempart anti-malveillance : la moyenne tronquee et
 * la mediane neutralisent un saboteur isole qui mettrait 0 (ou 1) a tout le
 * monde, sans avoir besoin d'une intervention manuelle de l'hote.
 */

import type { Aggregation, GameConfig, VoteMatrix } from "./messages";
import { DEF_CONFIG } from "./messages";

/**
 * Une valeur de vote est-elle autorisee ?
 * On accepte tout nombre fini dans [0, 1] (slider continu cote client).
 */
export function isValidVoteValue(v: unknown): v is number {
  if (typeof v !== "number" || !Number.isFinite(v)) return false;
  return v >= 0 && v <= 1;
}

/**
 * Agrege une liste de votes (chacun dans [0,1]) en une note unique dans [0,1].
 *
 *   - "mean"    : moyenne simple de tous les votes.
 *   - "robust"  : moyenne en excluant uniquement les votes anormalement BAS.
 *                 Methode : on calcule la mediane M, puis la MAD (median absolute
 *                 deviation = mediane des |v - M|). Un vote v est exclu si
 *                 v < M - 2.5 × MAD. Seuls les outliers BAS sont retires :
 *                 c'est asymetrique a dessein (un saboteur n'a aucun interet a
 *                 mettre un faux 1, et un vrai 1 enthousiaste ne penalise personne).
 *                 Active des qu'on a >= 4 votes ET MAD > 0 (sinon on retombe sur
 *                 mean). Si on retire tout, on retombe egalement sur mean.
 *   - "median"  : valeur centrale (moyenne des deux centrales si pair).
 *
 * Une liste vide renvoie 0 (aucun vote = aucun point).
 */
export function aggregate(values: number[], mode: Aggregation): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];

  const sorted = [...values].sort((a, b) => a - b);
  const meanOf = (xs: number[]): number =>
    xs.reduce((a, b) => a + b, 0) / xs.length;
  const medianOfSorted = (xs: number[]): number => {
    const mid = Math.floor(xs.length / 2);
    if (xs.length % 2 === 1) return xs[mid];
    return (xs[mid - 1] + xs[mid]) / 2;
  };

  if (mode === "median") {
    return medianOfSorted(sorted);
  }

  if (mode === "robust" && sorted.length >= 4) {
    const med = medianOfSorted(sorted);
    // MAD = mediane des |v - med|
    const absDev = sorted.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
    const mad = medianOfSorted(absDev);
    if (mad > 1e-9) {
      const threshold = med - 2.5 * mad;
      const kept = sorted.filter((v) => v >= threshold);
      if (kept.length > 0) return meanOf(kept);
      // Fallback improbable (tous exclus) : on retombe sur mean
    }
    // Si MAD = 0 (tout le monde d'accord), pas d'outlier a chercher
    return meanOf(sorted);
  }

  // "mean" (ou "robust" avec trop peu de votes)
  return meanOf(sorted);
}

/**
 * Calcule l'agregat de chaque auteur et le score de la manche par joueur.
 *
 * @param authors   liste des pseudos (= auteurs ET joueurs presents)
 * @param votes     matrice votes[voter][author] = valeur
 * @param config    config de partie (methode d'agregation + bareme)
 */
export function computeRoundScores(
  authors: string[],
  votes: VoteMatrix,
  config: GameConfig
): {
  aggregateByAuthor: Record<string, number>;
  scoreByPlayer: Record<string, number>;
} {
  const aggregateByAuthor: Record<string, number> = {};
  const scoreByPlayer: Record<string, number> = {};

  for (const author of authors) {
    // Collecte tous les votes recus par cet auteur (exclut l'auto-vote par
    // construction : un voter ne vote jamais pour lui-meme).
    const received: number[] = [];
    for (const voter of authors) {
      if (voter === author) continue;
      const v = votes[voter]?.[author];
      if (isValidVoteValue(v)) received.push(v);
    }
    const agg = aggregate(received, config.aggregation);
    aggregateByAuthor[author] = agg;
    scoreByPlayer[author] = Math.round(agg * DEF_CONFIG.POINTS_PER_ROUND);
  }

  return { aggregateByAuthor, scoreByPlayer };
}

/**
 * Validation de la GameConfig fournie par le host.
 */
export function validateGameConfig(
  cfg: unknown
): { ok: true } | { ok: false; error: string } {
  if (!cfg || typeof cfg !== "object") {
    return { ok: false, error: "Configuration invalide." };
  }
  const c = cfg as Record<string, unknown>;

  if (c.mode !== "competitive" && c.mode !== "chill") {
    return { ok: false, error: "Mode de jeu invalide." };
  }

  if (
    typeof c.totalRounds !== "number" ||
    !Number.isInteger(c.totalRounds) ||
    c.totalRounds < 0 ||
    c.totalRounds > DEF_CONFIG.MAX_ROUNDS
  ) {
    return { ok: false, error: "Nombre de manches invalide." };
  }
  // En mode chill, on tolere n'importe quelle valeur de timer cote API
  // (le serveur l'ignore et n'arme pas de timer auto). En compet, on borne.
  if (c.mode === "competitive") {
    if (
      typeof c.timerSeconds !== "number" ||
      c.timerSeconds < DEF_CONFIG.MIN_TIMER_SEC ||
      c.timerSeconds > DEF_CONFIG.MAX_TIMER_SEC
    ) {
      return {
        ok: false,
        error: `Timer invalide (${DEF_CONFIG.MIN_TIMER_SEC}-${DEF_CONFIG.MAX_TIMER_SEC} sec).`,
      };
    }
  } else {
    if (typeof c.timerSeconds !== "number" || !Number.isFinite(c.timerSeconds)) {
      return { ok: false, error: "Timer invalide." };
    }
  }
  if (
    c.aggregation !== "mean" &&
    c.aggregation !== "robust" &&
    c.aggregation !== "median"
  ) {
    return { ok: false, error: "Méthode d'agrégation invalide." };
  }
  return { ok: true };
}

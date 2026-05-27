/**
 * Module de moderation et validation des entrees utilisateur.
 *
 * Phase 3 : validation des pseudos uniquement (longueur, caracteres,
 * filtre de gros mots basique).
 */

const PSEUDO_MIN = 3;
const PSEUDO_MAX = 20;

const BANNED_WORDS: string[] = [
  // Liste basique, a enrichir si besoin
];

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

export function validatePseudo(
  raw: unknown
):
  | { ok: true; normalized: string }
  | { ok: false; error: string } {
  if (typeof raw !== "string") {
    return { ok: false, error: "Pseudo invalide." };
  }
  const trimmed = raw.trim();
  if (trimmed.length < PSEUDO_MIN) {
    return { ok: false, error: `Pseudo trop court (min. ${PSEUDO_MIN}).` };
  }
  if (trimmed.length > PSEUDO_MAX) {
    return { ok: false, error: `Pseudo trop long (max. ${PSEUDO_MAX}).` };
  }
  if (!/^[\p{L}\p{N} _\-.]+$/u.test(trimmed)) {
    return {
      ok: false,
      error:
        "Pseudo non autorise (caracteres speciaux interdits, accentues OK).",
    };
  }

  const normalized = normalize(trimmed);
  for (const banned of BANNED_WORDS) {
    if (normalized.includes(normalize(banned))) {
      return {
        ok: false,
        error: "Pseudo non autorise. Choisis-en un autre.",
      };
    }
  }

  return { ok: true, normalized: trimmed };
}

export function pseudosEqual(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

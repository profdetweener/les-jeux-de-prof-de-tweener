/**
 * Récupération de définitions via l'API REST de Wiktionary FR.
 *
 * Endpoint : https://fr.wiktionary.org/api/rest_v1/page/definition/{mot}
 *
 * Format de réponse (simplifié) :
 *   {
 *     "fr": [
 *       {
 *         "partOfSpeech": "Nom commun",
 *         "language": "Français",
 *         "definitions": [
 *           { "definition": "<HTML>...</HTML>", "examples": ["...", "..."] },
 *           ...
 *         ]
 *       },
 *       ...
 *     ],
 *     "en": [ ... ]   // peut contenir d'autres langues
 *   }
 *
 * On ne s'intéresse qu'à la clé "fr".
 *
 * Les définitions et exemples contiennent du HTML basique (liens internes du
 * wiktionnaire, italique, etc.). On nettoie tout ça en texte simple.
 *
 * Cache en mémoire (par mot, en majuscules) : évite de spammer l'API si on
 * rouvre plusieurs fois la même définition pendant la session.
 */

const CACHE = new Map();
const PENDING = new Map(); // requêtes en cours, dédupliquées

const ENDPOINT = "https://fr.wiktionary.org/api/rest_v1/page/definition/";

/**
 * Nettoie une chaîne contenant du HTML léger renvoyée par Wiktionary.
 * On extrait juste le texte. Préserve les espaces entre éléments.
 */
function stripHtml(html) {
  if (!html) return "";
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  // Remplace les <br> par des espaces avant extraction
  tmp.querySelectorAll("br").forEach((br) => br.replaceWith(" "));
  const text = tmp.textContent || "";
  // Compresse les espaces multiples
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Récupère la définition d'un mot. Renvoie un objet structuré :
 *   {
 *     word: "MAISON",
 *     entries: [
 *       { partOfSpeech: "Nom commun", definitions: [{ text, examples: [...] }, ...] },
 *       ...
 *     ],
 *     sourceUrl: "https://fr.wiktionary.org/wiki/maison"
 *   }
 *
 * Lance une erreur si le mot est introuvable ou si l'API est inaccessible.
 *
 * @param {string} word le mot, casse indifférente
 * @returns {Promise<{word: string, entries: Array, sourceUrl: string}>}
 */
export async function fetchDefinition(word) {
  const key = word.toUpperCase();
  if (CACHE.has(key)) return CACHE.get(key);
  if (PENDING.has(key)) return PENDING.get(key);

  const promise = (async () => {
    // Wiktionary FR utilise généralement la version en minuscules pour les
    // entrées de noms communs. On tente minuscules d'abord.
    const lower = word.toLowerCase();
    const url = ENDPOINT + encodeURIComponent(lower);

    let res;
    try {
      res = await fetch(url, { headers: { Accept: "application/json" } });
    } catch (e) {
      throw new Error("Impossible de joindre Wiktionary.");
    }

    if (res.status === 404) {
      throw new Error("Aucune définition trouvée pour ce mot.");
    }
    if (!res.ok) {
      throw new Error(`Erreur Wiktionary (HTTP ${res.status}).`);
    }

    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error("Réponse Wiktionary illisible.");
    }

    const frEntries = data && Array.isArray(data.fr) ? data.fr : [];
    if (frEntries.length === 0) {
      throw new Error("Aucune définition en français pour ce mot.");
    }

    const entries = frEntries.map((entry) => ({
      partOfSpeech: entry.partOfSpeech || "—",
      definitions: (entry.definitions || []).map((d) => ({
        text: stripHtml(d.definition),
        examples: (d.examples || []).map(stripHtml).filter(Boolean),
      })).filter((d) => d.text), // exclut les défs vides après strip
    })).filter((e) => e.definitions.length > 0);

    if (entries.length === 0) {
      throw new Error("Aucune définition exploitable.");
    }

    const result = {
      word: key,
      entries,
      sourceUrl: `https://fr.wiktionary.org/wiki/${encodeURIComponent(lower)}`,
    };
    CACHE.set(key, result);
    return result;
  })();

  PENDING.set(key, promise);
  try {
    return await promise;
  } finally {
    PENDING.delete(key);
  }
}

/**
 * Précharge la définition d'un mot sans bloquer ni propager d'erreur.
 * Utile pour anticiper l'ouverture de la popup juste après la révélation.
 *
 * @param {string} word
 */
export function prefetchDefinition(word) {
  fetchDefinition(word).catch(() => {
    // silencieux : si ça rate, on retentera à l'ouverture du popup
  });
}

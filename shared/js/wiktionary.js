/**
 * Récupération de définitions via Wiktionary FR, avec stratégie de fallback.
 *
 * 1) On essaie d'abord l'endpoint REST structuré :
 *      https://fr.wiktionary.org/api/rest_v1/page/definition/{mot}
 *    C'est rapide et propre quand ça marche, mais cet endpoint est experimental
 *    et renvoie souvent HTTP 501 sur certaines entrées (formes verbales rares,
 *    structures d'article inhabituelles).
 *
 * 2) Si l'endpoint REST echoue (501, 500, JSON cassé, etc., mais PAS 404),
 *    on tombe sur l'API MediaWiki Action :
 *      https://fr.wiktionary.org/w/api.php?action=parse&page={mot}&prop=text&format=json
 *    qui renvoie le HTML complet de la page. On parse ce HTML pour en extraire
 *    les définitions sous les sections "Nom commun", "Verbe", "Adjectif", etc.
 *
 * 3) Si 404 sur l'un comme sur l'autre, le mot n'existe pas dans le wiktionnaire.
 *
 * Cache en mémoire (par mot, en majuscules) : évite de spammer l'API si on
 * rouvre plusieurs fois la même définition pendant la session.
 */

const CACHE = new Map();
const PENDING = new Map(); // requêtes en cours, dédupliquées

const REST_ENDPOINT = "https://fr.wiktionary.org/api/rest_v1/page/definition/";
const MEDIAWIKI_ENDPOINT = "https://fr.wiktionary.org/w/api.php";

// Sections du wiktionnaire FR qu'on considère comme "définitions" à afficher.
// L'ordre détermine la priorité d'affichage.
const RECOGNIZED_POS = [
  "Nom commun", "Nom propre", "Nom",
  "Verbe",
  "Adjectif",
  "Adverbe",
  "Pronom",
  "Interjection",
  "Conjonction",
  "Préposition",
  "Forme de nom commun",
  "Forme de verbe",
  "Forme d'adjectif",
  "Locution nominale",
  "Locution verbale",
  "Locution adjectivale",
];

// =============================================================================
// Utilitaires
// =============================================================================

/**
 * Nettoie une chaîne contenant du HTML léger : enlève les balises, normalise
 * les espaces. Préserve le texte des liens internes du wiktionnaire.
 *
 * @param {string} html
 * @returns {string}
 */
function stripHtml(html) {
  if (!html) return "";
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  tmp.querySelectorAll("br").forEach((br) => br.replaceWith(" "));
  const text = tmp.textContent || "";
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Nettoie un élément DOM en supprimant les éléments parasites du Wiktionnaire
 * (références, modèles d'entête, exemples — qui sont parsés à part).
 */
function cleanDefinitionElement(el) {
  // Cite-bookgang/references, edit links, etc.
  el.querySelectorAll(
    ".mw-editsection, .reference, .cite-bracket, .noprint, sup.reference"
  ).forEach((n) => n.remove());
}

// =============================================================================
// Stratégie 1 : endpoint REST structuré
// =============================================================================

async function fetchViaRest(lower) {
  const url = REST_ENDPOINT + encodeURIComponent(lower);
  let res;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (e) {
    // Problème réseau — on signale pour que l'appelant tente le fallback
    throw new RestError("NETWORK", "Réseau indisponible");
  }
  if (res.status === 404) {
    throw new RestError("NOT_FOUND", "Aucune définition trouvée pour ce mot.");
  }
  if (!res.ok) {
    // 501, 500, autre → fallback recommandé
    throw new RestError("UPSTREAM", `Erreur Wiktionary (HTTP ${res.status})`);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new RestError("PARSE", "Réponse Wiktionary illisible.");
  }

  const frEntries = data && Array.isArray(data.fr) ? data.fr : [];
  if (frEntries.length === 0) {
    throw new RestError("NO_FR", "Pas de section française dans la réponse REST.");
  }

  const entries = frEntries.map((entry) => ({
    partOfSpeech: entry.partOfSpeech || "—",
    definitions: (entry.definitions || []).map((d) => ({
      text: stripHtml(d.definition),
      examples: (d.examples || []).map(stripHtml).filter(Boolean),
    })).filter((d) => d.text),
  })).filter((e) => e.definitions.length > 0);

  if (entries.length === 0) {
    throw new RestError("EMPTY", "Définitions REST vides après nettoyage.");
  }

  return entries;
}

class RestError extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
}

// =============================================================================
// Stratégie 2 : fallback via API MediaWiki Action (action=parse)
// =============================================================================

/**
 * Récupère le HTML complet de la page wiktionnaire et en extrait les
 * définitions structurées. Plus lent et plus fragile que le REST, mais
 * fonctionne sur les entrées que le REST refuse.
 *
 * @param {string} lower
 * @returns {Promise<Array<{partOfSpeech: string, definitions: Array}>>}
 */
async function fetchViaMediawiki(lower) {
  const params = new URLSearchParams({
    action: "parse",
    page: lower,
    prop: "text|sections",
    format: "json",
    formatversion: "2",
    redirects: "1",
    // Origin=* pour le CORS de l'API publique
    origin: "*",
  });
  const url = `${MEDIAWIKI_ENDPOINT}?${params.toString()}`;

  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new Error("Impossible de joindre Wiktionary.");
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

  // Erreur structurée renvoyée par MediaWiki (ex. page inexistante)
  if (data.error) {
    if (data.error.code === "missingtitle") {
      throw new Error("Aucune définition trouvée pour ce mot.");
    }
    throw new Error(data.error.info || `Erreur Wiktionary (${data.error.code}).`);
  }
  if (!data.parse || !data.parse.text) {
    throw new Error("Aucune définition trouvée pour ce mot.");
  }

  const html = data.parse.text;
  return parseMediawikiHtml(html);
}

/**
 * Parse le HTML d'une page Wiktionnaire FR et extrait les définitions par
 * section reconnue (Nom commun, Verbe, etc.) sous la langue Français.
 *
 * Structure typique du wiki :
 *   <h2><span id="Français">Français</span></h2>
 *   <h3><span id="Nom_commun">Nom commun</span></h3>
 *   ...
 *   <ol>
 *     <li>Définition 1.<ul><li>Exemple : ...</li></ul></li>
 *     <li>Définition 2.</li>
 *   </ol>
 *   <h3><span id="Verbe">Verbe</span></h3>
 *   ...
 *
 * @param {string} html
 * @returns {Array<{partOfSpeech: string, definitions: Array}>}
 */
function parseMediawikiHtml(html) {
  const container = document.createElement("div");
  container.innerHTML = html;

  // Trouve le h2 "Français". Si absent (page sans section FR), on échoue.
  const headings = Array.from(container.querySelectorAll("h2, h3, h4"));
  const frIndex = headings.findIndex((h) => {
    const id = h.querySelector(".mw-headline, span[id]")?.id || "";
    const txt = h.textContent.trim();
    return id === "Français" || txt.startsWith("Français");
  });
  if (frIndex === -1) {
    throw new Error("Aucune section française pour ce mot.");
  }

  // Récupère toutes les sous-sections (h3) jusqu'au h2 suivant.
  const entries = [];
  for (let i = frIndex + 1; i < headings.length; i++) {
    const h = headings[i];
    if (h.tagName === "H2") break; // changement de langue
    if (h.tagName !== "H3") continue;
    const headlineEl = h.querySelector(".mw-headline, span[id]");
    const headlineText = (headlineEl?.textContent || h.textContent).trim();
    // On ne garde que les sections POS reconnues
    const recognized = RECOGNIZED_POS.find((pos) =>
      headlineText.toLowerCase().startsWith(pos.toLowerCase())
    );
    if (!recognized) continue;

    // Cherche le premier <ol> qui suit ce h3 (avant le prochain h2/h3)
    let ol = null;
    let n = h.nextElementSibling;
    while (n) {
      if (/^H[234]$/.test(n.tagName)) break;
      if (n.tagName === "OL") { ol = n; break; }
      // L'ol peut aussi être imbriqué dans un wrapper
      const inner = n.querySelector?.(":scope > ol");
      if (inner) { ol = inner; break; }
      n = n.nextElementSibling;
    }
    if (!ol) continue;

    const definitions = [];
    for (const li of Array.from(ol.children)) {
      if (li.tagName !== "LI") continue;
      const liClone = li.cloneNode(true);
      // Extrait les exemples (généralement dans des <ul> imbriqués) avant
      // de cleaner le texte principal.
      const exampleEls = Array.from(liClone.querySelectorAll(":scope > ul li, :scope > dl dd"));
      const examples = exampleEls.map((ex) => {
        cleanDefinitionElement(ex);
        return stripHtml(ex.innerHTML);
      }).filter(Boolean);
      // Retire les exemples du texte principal
      liClone.querySelectorAll(":scope > ul, :scope > dl").forEach((n) => n.remove());
      cleanDefinitionElement(liClone);
      const text = stripHtml(liClone.innerHTML);
      if (text) {
        definitions.push({ text, examples });
      }
    }

    if (definitions.length > 0) {
      entries.push({ partOfSpeech: recognized, definitions });
    }
  }

  if (entries.length === 0) {
    throw new Error("Aucune définition exploitable trouvée.");
  }
  return entries;
}

// =============================================================================
// API publique
// =============================================================================

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
 * @param {string} word
 * @returns {Promise<{word: string, entries: Array, sourceUrl: string}>}
 */
export async function fetchDefinition(word) {
  const key = word.toUpperCase();
  if (CACHE.has(key)) return CACHE.get(key);
  if (PENDING.has(key)) return PENDING.get(key);

  const promise = (async () => {
    const lower = word.toLowerCase();
    let entries;
    try {
      entries = await fetchViaRest(lower);
    } catch (err) {
      // Sur NOT_FOUND on tente quand meme MediaWiki car certaines entrees
      // existent en HTML mais pas dans le REST. C'est l'inverse aussi vrai.
      // Sur tout le reste (UPSTREAM, PARSE, NO_FR, EMPTY, NETWORK), on tente.
      try {
        entries = await fetchViaMediawiki(lower);
      } catch (err2) {
        // Si les deux echouent, on remonte le message le plus informatif :
        // celui du fallback est generalement plus clair pour l'utilisateur.
        throw err2 instanceof Error ? err2 : new Error(String(err2));
      }
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
 *
 * @param {string} word
 */
export function prefetchDefinition(word) {
  fetchDefinition(word).catch(() => {
    // silencieux : si ça rate, on retentera à l'ouverture de la popup
  });
}

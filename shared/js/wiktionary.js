/**
 * Récupération de définitions via Wiktionary FR, avec stratégie de fallback.
 *
 * Le mot reçu en entrée peut être stocké côté worker en ASCII sans accents
 * (ex. "ABIME", "ARETE", "ACCES") alors que la page Wiktionary FR correspondante
 * existe sous la forme accentuée ("abîme", "arête", "accès"). On a donc une
 * étape de RÉSOLUTION en plus du simple fetch.
 *
 * Pipeline pour un mot donné :
 *
 *   1) Tentative directe sur la forme reçue (lowercase) via l'endpoint REST :
 *        https://fr.wiktionary.org/api/rest_v1/page/definition/{mot}
 *      Rapide quand ça marche. Renvoie souvent 501 sur les formes verbales rares,
 *      raison pour laquelle on a toujours un fallback HTML.
 *
 *   2) Si 404 sur le REST, on demande à MediaWiki opensearch de proposer des
 *      titres existants qui commencent par notre forme ASCII (les redirections
 *      sans-accent → avec-accent ne sont PAS faites systématiquement sur fr.wikt,
 *      donc on ne peut pas compter dessus). On dé-accentue les suggestions et
 *      on garde la première qui matche exactement notre ASCII et la bonne
 *      longueur. On retente le REST sur cette forme accentuée.
 *
 *   3) Si le REST a renvoyé autre chose qu'un 404 (501, 500, JSON cassé...),
 *      on passe au fallback HTML via action=parse sur le titre qu'on a sous
 *      la main (ASCII si on n'a pas encore résolu, accentué sinon). On parse le
 *      HTML pour extraire les définitions sous "Nom commun", "Verbe", etc.
 *
 *   4) Si à la fin de tout ça on n'a rien, le mot n'a pas de page exploitable.
 *
 * Cache en mémoire (par clé uppercase) : on ne refait jamais le travail deux
 * fois dans la même session, et les requêtes concurrentes sur le même mot
 * sont dédupliquées via PENDING.
 */

const CACHE = new Map();
const PENDING = new Map();

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
// Utilitaires texte
// =============================================================================

/**
 * Retire les diacritiques (accents, cédilles, trémas...) d'une chaîne.
 * "abîme" → "abime", "façon" → "facon", "œuf" → "œuf" (les ligatures restent).
 */
function deaccent(s) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function stripHtml(html) {
  if (!html) return "";
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  tmp.querySelectorAll("br").forEach((br) => br.replaceWith(" "));
  const text = tmp.textContent || "";
  return text.replace(/\s+/g, " ").trim();
}

function cleanDefinitionElement(el) {
  el.querySelectorAll(
    ".mw-editsection, .reference, .cite-bracket, .noprint, sup.reference"
  ).forEach((n) => n.remove());
}

// =============================================================================
// Erreur structurée pour piloter le fallback depuis fetchDefinition
// =============================================================================

class RestError extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
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
    throw new RestError("NETWORK", "Réseau indisponible");
  }
  if (res.status === 404) {
    throw new RestError("NOT_FOUND", "Aucune définition trouvée pour ce mot.");
  }
  if (!res.ok) {
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

// =============================================================================
// Résolution ASCII → forme accentuée via opensearch
// =============================================================================

/**
 * Cherche sur le Wiktionnaire FR un titre de page qui, une fois dé-accentué,
 * correspond exactement à l'entrée ASCII donnée. Utilisé quand notre dico
 * stocke "ABIME" et que la page existe sous "abîme".
 *
 * Algorithme :
 *   - On demande à opensearch des suggestions commençant par notre forme ASCII.
 *     opensearch fait du préfixe insensible à la casse mais SENSIBLE aux
 *     accents, donc on ne lui passe pas l'ASCII directement (il chercherait
 *     une page "abime" qui n'existe pas).
 *   - Astuce : opensearch matche aussi les redirections, et son champ "search"
 *     accepte des termes pas trop stricts. Mais en pratique le moyen le plus
 *     fiable c'est de demander un préfixe court (les 2-3 premières lettres) et
 *     de filtrer les suggestions côté client. Pour rester rapide on demande
 *     `limit=20` avec le mot complet d'abord ; si ça ne donne rien on
 *     re-tente sur un préfixe.
 *   - On dé-accentue chaque suggestion ; on garde la première qui matche
 *     exactement l'ASCII (longueur + caractères).
 *
 * @param {string} asciiLower mot en ASCII lowercase (ex. "abime")
 * @returns {Promise<string|null>} forme accentuée trouvée (ex. "abîme"), ou null
 */
async function resolveAccentedTitle(asciiLower) {
  // Première passe : opensearch avec le mot complet. Si une redirection existe,
  // ou si l'orthographe sans accent matche, on tombe dessus directement.
  const candidates1 = await opensearchSuggestions(asciiLower, 20);
  const hit1 = pickAsciiMatch(candidates1, asciiLower);
  if (hit1) return hit1;

  // Deuxième passe : avec un préfixe plus court (les 3 premières lettres dé-accentuées
  // — ici c'est déjà l'ASCII). Plus de candidats à filtrer mais on couvre les cas
  // où la forme accentuée diverge dès les premières lettres.
  if (asciiLower.length > 3) {
    const candidates2 = await opensearchSuggestions(asciiLower.slice(0, 3), 50);
    const hit2 = pickAsciiMatch(candidates2, asciiLower);
    if (hit2) return hit2;
  }

  // Troisième passe : full-text search via CirrusSearch (action=query/list=search).
  // Contrairement aux 2 premières passes (opensearch est accent-sensible et
  // souvent muet sur les ASCII non redirigés), CirrusSearch fait du matching
  // diacritic-insensible : "pincee" remonte "pincée", "arete" remonte "arête",
  // etc. C'est notre filet de secours pour les mots accentués pour lesquels
  // Wiktionary FR ne maintient pas de redirection ASCII.
  const candidates3 = await fulltextSearchSuggestions(asciiLower, 20);
  const hit3 = pickAsciiMatch(candidates3, asciiLower);
  if (hit3) return hit3;

  return null;
}

async function opensearchSuggestions(query, limit) {
  const params = new URLSearchParams({
    action: "opensearch",
    search: query,
    namespace: "0",
    limit: String(limit),
    format: "json",
    formatversion: "2",
    origin: "*",
  });
  const url = `${MEDIAWIKI_ENDPOINT}?${params.toString()}`;
  let res;
  try {
    res = await fetch(url);
  } catch {
    return [];
  }
  if (!res.ok) return [];
  let data;
  try {
    data = await res.json();
  } catch {
    return [];
  }
  // opensearch renvoie [query, titres[], descriptions[], urls[]]
  return Array.isArray(data) && Array.isArray(data[1]) ? data[1] : [];
}

/**
 * Cherche des titres de pages via l'API MediaWiki list=search (CirrusSearch).
 * Contrairement a opensearch qui est accent-sensible, CirrusSearch sur le
 * Wiktionnaire FR fait du matching diacritic-insensible dans sa chaine
 * d'analyse : une requete sur "pincee" remonte "pincée", "arete" remonte
 * "arête", etc. Utilise comme 3eme strategie de resolution, apres echec
 * des deux passes d'opensearch.
 */
async function fulltextSearchSuggestions(query, limit) {
  const params = new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: query,
    srnamespace: "0",
    srlimit: String(limit),
    srprop: "",
    format: "json",
    formatversion: "2",
    origin: "*",
  });
  const url = `${MEDIAWIKI_ENDPOINT}?${params.toString()}`;
  let res;
  try {
    res = await fetch(url);
  } catch {
    return [];
  }
  if (!res.ok) return [];
  let data;
  try {
    data = await res.json();
  } catch {
    return [];
  }
  const hits = data && data.query && Array.isArray(data.query.search)
    ? data.query.search
    : [];
  return hits
    .map((h) => (h && typeof h.title === "string" ? h.title : null))
    .filter((t) => t !== null);
}

/**
 * Parmi une liste de titres Wiktionary, trouve celui qui correspond exactement
 * à `asciiLower` une fois dé-accentué et mis en minuscules. Le titre retenu doit
 * en plus être en un seul mot (pas de locution avec espaces) pour éviter les
 * faux positifs.
 */
function pickAsciiMatch(titles, asciiLower) {
  for (const t of titles) {
    if (!t || typeof t !== "string") continue;
    if (/[\s_]/.test(t)) continue; // on veut un mot simple
    const normalized = deaccent(t).toLowerCase();
    if (normalized === asciiLower) return t;
  }
  return null;
}

// =============================================================================
// Stratégie 2 : fallback via API MediaWiki Action (action=parse)
// =============================================================================

async function fetchViaMediawiki(lower) {
  const params = new URLSearchParams({
    action: "parse",
    page: lower,
    prop: "text|sections",
    format: "json",
    formatversion: "2",
    redirects: "1",
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

  if (data.error) {
    if (data.error.code === "missingtitle") {
      throw new Error("Aucune définition trouvée pour ce mot.");
    }
    throw new Error(data.error.info || `Erreur Wiktionary (${data.error.code}).`);
  }
  if (!data.parse || !data.parse.text) {
    throw new Error("Aucune définition trouvée pour ce mot.");
  }

  return parseMediawikiHtml(data.parse.text);
}

/**
 * Parse le HTML d'une page Wiktionnaire FR et extrait les définitions par
 * section reconnue (Nom commun, Verbe, etc.) sous la langue Français.
 *
 * IMPORTANT — deux formats à gérer :
 *
 *   ANCIEN (MediaWiki avant 1.43, jusqu'à mi-2024) :
 *     <h2><span class="mw-headline" id="Français">Français</span></h2>
 *     ...
 *     <h3><span class="mw-headline" id="Nom_commun">Nom commun</span></h3>
 *     <ol>...</ol>
 *
 *   NOUVEAU (MediaWiki 1.43+, à partir de juillet 2024) :
 *     <div class="mw-heading mw-heading2"><h2 id="Français">Français</h2></div>
 *     ...
 *     <div class="mw-heading mw-heading3"><h3 id="Nom_commun">Nom commun</h3></div>
 *     <ol>...</ol>
 *
 * Différence cruciale : dans le nouveau format, le <h3> est enveloppé dans un
 * <div class="mw-heading">. Donc `h3.nextElementSibling` est null (le h3 est
 * seul dans son wrapper) — il faut prendre le sibling du DIV pour atteindre
 * le <ol> qui suit.
 *
 * Stratégie : on collecte la liste plate d'éléments "intéressants" au niveau
 * racine du contenu (les anciens headings simples + les wrappers .mw-heading
 * + les <ol> + les <p>/<div> top-level), puis on parcourt cette liste en
 * traitant chaque heading comme un délimiteur de section et chaque <ol>
 * comme un candidat pour la section courante.
 */
function parseMediawikiHtml(html) {
  const container = document.createElement("div");
  container.innerHTML = html;

  // L'API parse renvoie souvent un wrapper <div class="mw-parser-output"> ;
  // on travaille à l'intérieur s'il existe pour éviter les éléments noise
  // (NavFrames, TOC, etc.) qui pourraient être à côté.
  const root = container.querySelector(".mw-parser-output") || container;

  // Récupère tous les enfants directs ET les headings (qui peuvent être
  // enveloppés). On normalise chaque heading vers la forme { tag, id, text, element }
  // où `element` est l'élément racine de la section (le DIV.mw-heading dans le
  // nouveau format, le H lui-même dans l'ancien). C'est cet element dont on
  // utilisera nextElementSibling pour trouver le contenu.

  /** @type {Array<{level: number, id: string, text: string, anchor: Element}>} */
  const headings = [];

  // Cherche tous les headings (avec ou sans wrapper) par DFS limité.
  // Sélecteur unique qui matche les deux formats grâce à :is() :
  //   - .mw-heading > hN  (nouveau format)
  //   - hN sans wrapper .mw-heading (ancien format)
  const allH = root.querySelectorAll("h2, h3, h4");
  for (const h of allH) {
    const level = parseInt(h.tagName.substring(1), 10);
    // Texte du heading : on essaie d'abord le .mw-headline (ancien), puis l'id
    // sur le h lui-même (nouveau), puis fallback sur textContent.
    const headlineEl = h.querySelector(".mw-headline");
    const id = headlineEl?.id || h.id || "";
    // textContent du heading inclut .mw-editsection ; on clone et on nettoie
    // pour récupérer juste le titre.
    const hClone = h.cloneNode(true);
    hClone.querySelectorAll(".mw-editsection").forEach((n) => n.remove());
    const text = (hClone.textContent || "").trim();

    // L'anchor — l'élément dont on doit parcourir les nextElementSibling pour
    // trouver le contenu — est le wrapper .mw-heading s'il existe, sinon le h.
    const wrapper = h.closest(".mw-heading");
    const anchor = wrapper || h;

    headings.push({ level, id, text, anchor });
  }

  // Localise la section "Français"
  const frIndex = headings.findIndex(
    (h) => h.level === 2 && (h.id === "Français" || h.text.startsWith("Français"))
  );
  if (frIndex === -1) {
    throw new Error("Aucune section française pour ce mot.");
  }

  const entries = [];
  for (let i = frIndex + 1; i < headings.length; i++) {
    const h = headings[i];
    if (h.level === 2) break; // fin de la section Français (changement de langue)
    if (h.level !== 3) continue;

    const recognized = RECOGNIZED_POS.find((pos) =>
      h.text.toLowerCase().startsWith(pos.toLowerCase())
    );
    if (!recognized) continue;

    // Cherche le premier <ol> qui suit ce h3 (en avançant via nextElementSibling
    // depuis l'anchor : le wrapper .mw-heading dans le nouveau format, le h3
    // dans l'ancien). On s'arrête au prochain wrapper de heading ou heading nu.
    let ol = null;
    let n = h.anchor.nextElementSibling;
    while (n) {
      // Stop si on tombe sur le heading suivant (sous l'une ou l'autre forme)
      if (/^H[234]$/.test(n.tagName)) break;
      if (n.classList && n.classList.contains("mw-heading")) break;
      if (n.tagName === "OL") { ol = n; break; }
      const inner = n.querySelector?.(":scope > ol");
      if (inner) { ol = inner; break; }
      n = n.nextElementSibling;
    }
    if (!ol) continue;

    const definitions = [];
    for (const li of Array.from(ol.children)) {
      if (li.tagName !== "LI") continue;
      const liClone = li.cloneNode(true);
      // Extrait les exemples (généralement <ul>/<dl> imbriqués) avant de
      // cleaner le texte principal.
      const exampleEls = Array.from(liClone.querySelectorAll(":scope > ul li, :scope > dl dd"));
      const examples = exampleEls.map((ex) => {
        cleanDefinitionElement(ex);
        return stripHtml(ex.innerHTML);
      }).filter(Boolean);
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
 * Récupère la définition d'un mot.
 *
 * @param {string} word peut être en majuscules ASCII (forme stockée côté worker),
 *                       en minuscules, accentué ou non. La fonction gère tout.
 * @returns {Promise<{word: string, entries: Array, sourceUrl: string}>}
 *
 * Le `word` renvoyé est l'entrée d'origine, en uppercase (utilisé comme clé de cache).
 * Le `sourceUrl` pointe vers la VRAIE page trouvée (forme accentuée si on l'a résolue),
 * donc le bouton "voir sur Wiktionary" envoie bien sur la bonne page.
 */
export async function fetchDefinition(word) {
  const key = word.toUpperCase();
  if (CACHE.has(key)) return CACHE.get(key);
  if (PENDING.has(key)) return PENDING.get(key);

  const promise = (async () => {
    const lower = word.toLowerCase();

    // Tentative 1 : REST direct
    let entries;
    let resolvedTitle = lower; // titre de la page Wiktionary effectivement utilisé
    let restErr;
    try {
      entries = await fetchViaRest(lower);
    } catch (err) {
      restErr = err;
    }

    // Tentative 2 : si NOT_FOUND / EMPTY / NO_FR, c'est probablement un problème
    // d'accent (la page sans accent n'existe pas, ou existe mais en coquille vide
    // qui renvoie vers la forme accentuée). On résout l'ASCII vers la vraie forme
    // via opensearch, puis on re-tente le REST sur la forme résolue.
    //
    // NB : on ne déclenche PAS sur UPSTREAM (501) ni PARSE — ces codes signalent
    // que la page existe mais le REST a un problème ; le fallback MediaWiki est
    // plus pertinent dans ce cas, et il marchera avec le titre ASCII tel quel.
    const accentRetryCodes = new Set(["NOT_FOUND", "EMPTY", "NO_FR"]);
    if (!entries && restErr instanceof RestError && accentRetryCodes.has(restErr.code)) {
      try {
        const resolved = await resolveAccentedTitle(lower);
        if (resolved && resolved.toLowerCase() !== lower) {
          resolvedTitle = resolved.toLowerCase();
          try {
            entries = await fetchViaRest(resolvedTitle);
          } catch (err) {
            // On garde restErr du premier essai pour pas perdre l'info "NOT_FOUND"
            // initial, mais on retombera sur le fallback MediaWiki avec resolvedTitle.
            restErr = err;
          }
        }
      } catch {
        // resolveAccentedTitle ne lève pas en principe (il renvoie null), mais on
        // ne fait rien si jamais : on laisse le fallback MediaWiki tenter sa chance.
      }
    }

    // Tentative 3 : fallback MediaWiki action=parse. On utilise resolvedTitle qui
    // sera la forme accentuée si on l'a trouvée, sinon le lower d'origine.
    if (!entries) {
      try {
        entries = await fetchViaMediawiki(resolvedTitle);
      } catch (err2) {
        throw err2 instanceof Error ? err2 : new Error(String(err2));
      }
    }

    const result = {
      word: key,
      entries,
      sourceUrl: `https://fr.wiktionary.org/wiki/${encodeURIComponent(resolvedTitle)}`,
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

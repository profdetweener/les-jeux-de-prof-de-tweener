/**
 * Configuration globale du frontend.
 *
 * Detection automatique de l'environnement :
 *   - si la page est servie depuis localhost / 127.0.0.1, on tape sur le
 *     Worker local (wrangler dev sur le port 8787)
 *   - sinon on tape sur le Worker en production (Cloudflare)
 *
 * Pour overrider manuellement (rare : tester la prod depuis localhost,
 * ou inversement), tu peux ajouter ?env=prod ou ?env=dev a l'URL.
 */

const PROD_WORKER_URL = "https://tweener-jeux.profdetweener.workers.dev";
const DEV_WORKER_URL = "http://localhost:8787";

function detectWorkerUrl() {
  // Override explicite via query string : ?env=prod ou ?env=dev
  try {
    const params = new URLSearchParams(window.location.search);
    const env = params.get("env");
    if (env === "prod") return PROD_WORKER_URL;
    if (env === "dev") return DEV_WORKER_URL;
  } catch {
    /* pas grave, on retombe sur la detection par hostname */
  }

  const host = window.location.hostname;
  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "" || // cas file:// (ouverture directe d'un .html)
    host.endsWith(".local");
  return isLocal ? DEV_WORKER_URL : PROD_WORKER_URL;
}

const WORKER_URL = detectWorkerUrl();

export const CONFIG = {
  WORKER_URL,

  // Derive automatiquement l'URL WebSocket (ws:// ou wss://) a partir de WORKER_URL.
  get WS_URL() {
    return this.WORKER_URL.replace(/^http/, "ws");
  },

  // Delai avant tentative de reconnexion WebSocket (ms)
  WS_RECONNECT_DELAY: 2000,
};

// Petit log au demarrage pour qu'on sache toujours sur quel backend on est.
// Utile en debug : on voit dans la console du navigateur la cible reelle.
console.info(
  `[tweener-jeux] Worker: ${CONFIG.WORKER_URL} (host=${window.location.hostname || "file://"})`
);

/**
 * Les jeux du Prof de Tweener — Worker (routeur multi-jeux).
 *
 * Chaque jeu a son propre namespace de Durable Objects et son propre
 * prefixe d'URL :
 *
 *   /petitbac/rooms                       → POST cree une room Petit Bac
 *   /petitbac/rooms/:code/exists          → GET verifie son existence
 *   /petitbac/room/:code                  → WS upgrade vers PetitBacRoom
 *
 *   /motus/...                            → reserve (Livraison 2)
 *
 * Routes generales :
 *   /                                     → "OK" (sante)
 *   /ping                                 → JSON de sante
 *
 * Retrocompat avec l'ancien worker :
 *   /rooms, /rooms/:code/exists, /room/:code → routes Petit Bac equivalentes
 *   (utile pendant la transition entre les deux deploiements)
 */

import { ROOM_CONFIG } from "./shared/types";
export { PetitBacRoom } from "./petitbac/room";

export interface Env {
  ROOMS: DurableObjectNamespace;
  MOTUS_ROOMS?: DurableObjectNamespace;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const ROOM_CODE_REGEX = new RegExp(
  `^[${ROOM_CONFIG.CODE_ALPHABET}]{${ROOM_CONFIG.CODE_LENGTH}}$`
);

function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...(init?.headers ?? {}),
    },
  });
}

function generateRoomCode(): string {
  const alphabet = ROOM_CONFIG.CODE_ALPHABET;
  let code = "";
  const buf = new Uint8Array(ROOM_CONFIG.CODE_LENGTH);
  crypto.getRandomValues(buf);
  for (let i = 0; i < ROOM_CONFIG.CODE_LENGTH; i++) {
    code += alphabet[buf[i] % alphabet.length];
  }
  return code;
}

async function roomExists(ns: DurableObjectNamespace, code: string): Promise<boolean> {
  const id = ns.idFromName(code);
  const stub = ns.get(id);
  const res = await stub.fetch("https://internal/__internal/exists");
  const data = (await res.json()) as { exists: boolean };
  return data.exists;
}

async function markRoomInitialized(ns: DurableObjectNamespace, code: string): Promise<void> {
  const id = ns.idFromName(code);
  const stub = ns.get(id);
  await stub.fetch("https://internal/__internal/init");
}

/**
 * Gere les routes d'un jeu donne : POST /rooms, GET /rooms/:code/exists,
 * WS /room/:code. Le `subPath` est ce qui reste apres le prefixe du jeu
 * (par exemple pour /petitbac/rooms le subPath vaut "/rooms").
 *
 * Renvoie null si aucune route ne matche, pour que l'appelant retourne 404.
 */
async function handleGameRoutes(
  request: Request,
  subPath: string,
  ns: DurableObjectNamespace
): Promise<Response | null> {
  if (subPath === "/rooms" && request.method === "POST") {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateRoomCode();
      const exists = await roomExists(ns, code);
      if (!exists) {
        await markRoomInitialized(ns, code);
        return jsonResponse({ code });
      }
    }
    return jsonResponse(
      { error: "Impossible de generer un code unique." },
      { status: 500 }
    );
  }

  const existsMatch = subPath.match(/^\/rooms\/([A-Z0-9]+)\/exists$/);
  if (existsMatch && request.method === "GET") {
    const code = existsMatch[1].toUpperCase();
    if (!ROOM_CODE_REGEX.test(code)) {
      return jsonResponse({ exists: false });
    }
    const exists = await roomExists(ns, code);
    return jsonResponse({ exists });
  }

  const wsMatch = subPath.match(/^\/room\/([A-Z0-9]+)$/);
  if (wsMatch) {
    const code = wsMatch[1].toUpperCase();
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected WebSocket upgrade", {
        status: 426,
        headers: CORS_HEADERS,
      });
    }
    const id = ns.idFromName(code);
    const stub = ns.get(id);
    return stub.fetch(request);
  }

  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === "/ping") {
      return jsonResponse({
        status: "ok",
        service: "les-jeux-de-prof-de-tweener",
        games: ["petitbac"],
        timestamp: new Date().toISOString(),
      });
    }
    if (url.pathname === "/") {
      return new Response("OK — Les jeux du Prof de Tweener\n", {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          ...CORS_HEADERS,
        },
      });
    }

    if (url.pathname.startsWith("/petitbac/")) {
      const subPath = url.pathname.slice("/petitbac".length);
      const res = await handleGameRoutes(request, subPath, env.ROOMS);
      if (res) return res;
    }

    if (
      url.pathname === "/rooms" ||
      url.pathname.startsWith("/rooms/") ||
      url.pathname.startsWith("/room/")
    ) {
      const res = await handleGameRoutes(request, url.pathname, env.ROOMS);
      if (res) return res;
    }

    if (url.pathname.startsWith("/motus/")) {
      return jsonResponse(
        { error: "Motus n'est pas encore disponible." },
        { status: 503 }
      );
    }

    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  },
};

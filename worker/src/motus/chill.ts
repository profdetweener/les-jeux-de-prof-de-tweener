/**
 * Motus chill — endpoints REST stateless.
 *
 * Le mode chill est solo (streamer seul devant son ordi). Il n'y a aucun besoin
 * de Durable Object : on traite chaque mot et chaque essai via des appels REST
 * tout simples au worker.
 *
 * Le defi technique : le serveur ne stocke rien, mais doit valider chaque essai
 * contre le mot cible. Solution : on signe le mot avec un HMAC-SHA256 et on
 * renvoie un token opaque au client. Pour chaque essai, le client renvoie le
 * token, le serveur le verifie et l'utilise pour colorer.
 *
 * Modele de menace : le mot apparait en clair dans la reponse reseau (il n'est
 * pas chiffre, juste signe). C'est volontairement simple : le mode chill est
 * concu pour le streamer en solo, qui n'a aucune incitation a aller bidouiller
 * son propre DevTools. La signature empeche un client de modifier le token
 * pour faire prendre un autre mot au serveur.
 *
 * Endpoints :
 *   POST /motus/chill/draw   { wordLength, maxAttempts } -> { token, firstLetter, wordLength, maxAttempts }
 *   POST /motus/chill/guess  { token, guess }            -> { attempt, status, revealedWord }
 */

import { colorize, isPlayableWord, normalizeGuess, pickRandomWord } from "./words";
import { MOTUS_CONFIG } from "./messages";

// =============================================================================
// HMAC token : { wordLength, word, n } signe avec une cle env CHILL_SECRET.
//
// Format : base64url(payloadJson) + "." + base64url(hmac)
// =============================================================================

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

interface ChillTokenPayload {
  w: string;        // mot cible
  n: number;        // nonce aleatoire (entropie supplementaire pour rendre les tokens uniques)
  m: number;        // maxAttempts (informatif, pas critique)
  ts: number;       // timestamp emission, pour expiration future si besoin
}

async function signToken(payload: ChillTokenPayload, secret: string): Promise<string> {
  const key = await importHmacKey(secret);
  const payloadBytes = encoder.encode(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, payloadBytes));
  return `${b64urlEncode(payloadBytes)}.${b64urlEncode(sig)}`;
}

async function verifyToken(token: string, secret: string): Promise<ChillTokenPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  let payloadBytes: Uint8Array;
  let sig: Uint8Array;
  try {
    payloadBytes = b64urlDecode(parts[0]);
    sig = b64urlDecode(parts[1]);
  } catch {
    return null;
  }
  const key = await importHmacKey(secret);
  const ok = await crypto.subtle.verify("HMAC", key, sig, payloadBytes);
  if (!ok) return null;
  try {
    const obj = JSON.parse(decoder.decode(payloadBytes)) as ChillTokenPayload;
    if (typeof obj.w !== "string" || typeof obj.n !== "number") return null;
    if (typeof obj.m !== "number" || typeof obj.ts !== "number") return null;
    return obj;
  } catch {
    return null;
  }
}

// =============================================================================
// Endpoints
// =============================================================================

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

/**
 * Tire un mot et renvoie un token signe + la 1ere lettre.
 */
async function handleDraw(request: Request, secret: string): Promise<Response> {
  let body: { wordLength?: number; maxAttempts?: number; avoidFirstLetters?: unknown };
  try {
    body = (await request.json()) as {
      wordLength?: number;
      maxAttempts?: number;
      avoidFirstLetters?: unknown;
    };
  } catch {
    return json({ error: "Body JSON invalide." }, 400);
  }

  const wordLength = Number(body.wordLength);
  const maxAttempts = Number(body.maxAttempts);

  // Historique optionnel des premieres lettres deja tirees recemment cote
  // client (localStorage), pour reduire la repetition d'une meme initiale
  // sur des tirages consecutifs. On accepte uniquement des chaines d'1 char.
  const avoidSet = new Set<string>();
  if (Array.isArray(body.avoidFirstLetters)) {
    for (const v of body.avoidFirstLetters) {
      if (typeof v === "string" && v.length === 1) {
        avoidSet.add(v.toUpperCase());
      }
    }
  }

  if (
    !Number.isInteger(wordLength) ||
    wordLength < MOTUS_CONFIG.MIN_WORD_LEN ||
    wordLength > MOTUS_CONFIG.MAX_WORD_LEN
  ) {
    return json(
      {
        error: `wordLength doit etre entre ${MOTUS_CONFIG.MIN_WORD_LEN} et ${MOTUS_CONFIG.MAX_WORD_LEN}.`,
      },
      400
    );
  }
  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < MOTUS_CONFIG.MIN_ATTEMPTS ||
    maxAttempts > MOTUS_CONFIG.MAX_ATTEMPTS
  ) {
    return json(
      {
        error: `maxAttempts doit etre entre ${MOTUS_CONFIG.MIN_ATTEMPTS} et ${MOTUS_CONFIG.MAX_ATTEMPTS}.`,
      },
      400
    );
  }

  const word = pickRandomWord(wordLength, avoidSet);
  if (!word) {
    return json({ error: "Aucun mot disponible pour cette longueur." }, 500);
  }

  const nonceBuf = new Uint32Array(1);
  crypto.getRandomValues(nonceBuf);
  const payload: ChillTokenPayload = {
    w: word,
    n: nonceBuf[0],
    m: maxAttempts,
    ts: Date.now(),
  };
  const token = await signToken(payload, secret);

  return json({
    token,
    firstLetter: word[0],
    wordLength: word.length,
    maxAttempts,
  });
}

/**
 * Valide un essai contre le mot signe dans le token. Renvoie la coloration.
 */
async function handleGuess(request: Request, secret: string): Promise<Response> {
  let body: { token?: string; guess?: string };
  try {
    body = (await request.json()) as { token?: string; guess?: string };
  } catch {
    return json({ error: "Body JSON invalide." }, 400);
  }

  if (typeof body.token !== "string" || typeof body.guess !== "string") {
    return json({ error: "token et guess requis." }, 400);
  }

  const payload = await verifyToken(body.token, secret);
  if (!payload) {
    return json({ error: "Token invalide ou signature corrompue." }, 400);
  }

  const target = payload.w;
  const guess = normalizeGuess(body.guess);

  if (guess.length !== target.length) {
    return json(
      {
        error: `Le mot doit faire ${target.length} lettres.`,
        code: "INVALID_GUESS_LENGTH",
      },
      400
    );
  }
  if (!/^[A-Z]+$/.test(guess)) {
    return json(
      { error: "Seules les lettres A-Z sont acceptees.", code: "INVALID_GUESS_LETTERS" },
      400
    );
  }
  if (guess[0] !== target[0]) {
    return json(
      {
        error: `Le mot doit commencer par ${target[0]}.`,
        code: "INVALID_GUESS_FIRST_LETTER",
      },
      400
    );
  }
  if (!isPlayableWord(guess)) {
    return json(
      {
        error: `"${guess}" n'est pas dans le dictionnaire.`,
        code: "WORD_NOT_IN_DICTIONARY",
      },
      400
    );
  }

  const attempt = colorize(target, guess);
  const isFound = attempt.feedback.every((f) => f.status === "good");

  // status = found si tout vert, exhausted si pas trouve et c'etait le dernier essai possible
  // sinon in_progress. On NE sait PAS combien d'essais ont deja ete faits cote serveur
  // (stateless), donc le client doit savoir s'il s'agit du dernier essai et nous le
  // dire... ou bien on garde simplement le client maitre de cette transition.
  //
  // Choix : le serveur renvoie juste "found" ou "in_progress". Le client est
  // responsable de detecter "exhausted" et d'afficher le mot via un appel reveal.
  // Pour simplifier, on ajoute revealedWord uniquement si found.
  const status = isFound ? "found" : "in_progress";
  const revealedWord = isFound ? target : null;

  return json({
    attempt,
    status,
    revealedWord,
  });
}

/**
 * En cas d'essais epuises, le client demande la revelation du mot.
 * On verifie juste la signature du token et on renvoie le mot.
 */
async function handleReveal(request: Request, secret: string): Promise<Response> {
  let body: { token?: string };
  try {
    body = (await request.json()) as { token?: string };
  } catch {
    return json({ error: "Body JSON invalide." }, 400);
  }
  if (typeof body.token !== "string") {
    return json({ error: "token requis." }, 400);
  }
  const payload = await verifyToken(body.token, secret);
  if (!payload) {
    return json({ error: "Token invalide ou signature corrompue." }, 400);
  }
  return json({ revealedWord: payload.w });
}

/**
 * Routeur principal pour les routes chill. subPath est ce qui reste apres
 * "/motus/chill" (par exemple "/draw" ou "/guess").
 *
 * Renvoie null si la route ne matche pas.
 */
export async function handleChillRoute(
  request: Request,
  subPath: string,
  secret: string
): Promise<Response | null> {
  if (request.method !== "POST") return null;
  if (subPath === "/draw") return handleDraw(request, secret);
  if (subPath === "/guess") return handleGuess(request, secret);
  if (subPath === "/reveal") return handleReveal(request, secret);
  return null;
}

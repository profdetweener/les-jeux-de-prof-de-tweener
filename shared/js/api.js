/**
 * Client HTTP pour les endpoints REST du Worker.
 *
 * Chaque fonction prend en parametre le slug du jeu ("petitbac", "motus"...).
 * Les routes du worker sont prefixees par ce slug :
 *   POST /:game/rooms
 *   GET  /:game/rooms/:code/exists
 *
 * Le slug par defaut est "petitbac" pour eviter de casser les anciens appels
 * eventuels qui appelleraient `createRoom()` sans argument. A retirer une
 * fois que tout le frontend passe explicitement le slug.
 */

import { CONFIG } from "./config.js";

/**
 * Cree une nouvelle room pour le jeu indique et renvoie son code.
 * @param {string} game slug du jeu (ex: "petitbac")
 * @returns {Promise<string>} code de la room (ex: "ABC123")
 */
export async function createRoom(game = "petitbac") {
  const res = await fetch(`${CONFIG.WORKER_URL}/${game}/rooms`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`Erreur creation room (HTTP ${res.status})`);
  }
  const data = await res.json();
  if (!data.code) {
    throw new Error("Réponse invalide du serveur (pas de code)");
  }
  return data.code;
}

/**
 * Verifie si une room existe pour le jeu indique.
 * @param {string} game slug du jeu
 * @param {string} code code de la room
 * @returns {Promise<boolean>}
 */
export async function roomExists(game, code) {
  // Compat ascendante : si on appelle l'ancienne signature roomExists(code),
  // on retombe sur "petitbac" comme jeu par defaut.
  if (code === undefined) {
    code = game;
    game = "petitbac";
  }
  const res = await fetch(
    `${CONFIG.WORKER_URL}/${game}/rooms/${encodeURIComponent(code)}/exists`
  );
  if (!res.ok) {
    throw new Error(`Erreur vérification room (HTTP ${res.status})`);
  }
  const data = await res.json();
  return data.exists === true;
}

/**
 * Verifie que le Worker est joignable. La route /ping est transverse, pas
 * specifique a un jeu.
 * @returns {Promise<boolean>}
 */
export async function pingWorker() {
  try {
    const res = await fetch(`${CONFIG.WORKER_URL}/ping`);
    return res.ok;
  } catch {
    return false;
  }
}

// ===========================================================================
// Motus chill — endpoints REST stateless
// ===========================================================================

/**
 * Tire un nouveau mot pour le mode chill solo. Renvoie un token opaque a
 * conserver pour les essais suivants et la 1ere lettre du mot.
 *
 * @param {number} wordLength entre 5 et 10
 * @param {number} maxAttempts entre 4 et 8
 * @returns {Promise<{token: string, firstLetter: string, wordLength: number, maxAttempts: number}>}
 */
export async function motusChillDraw(wordLength, maxAttempts) {
  const res = await fetch(`${CONFIG.WORKER_URL}/motus/chill/draw`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wordLength, maxAttempts }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Erreur tirage (HTTP ${res.status})`);
  }
  return await res.json();
}

/**
 * Soumet un essai pour validation et coloration.
 *
 * @param {string} token le token recu lors du draw
 * @param {string} guess l'essai (sera normalise cote serveur)
 * @returns {Promise<{attempt: object, status: "in_progress"|"found", revealedWord: string|null}>}
 * @throws {Error & {code?: string}} avec un code parmi INVALID_GUESS_LENGTH,
 *         INVALID_GUESS_LETTERS, INVALID_GUESS_FIRST_LETTER, WORD_NOT_IN_DICTIONARY
 */
export async function motusChillGuess(token, guess) {
  const res = await fetch(`${CONFIG.WORKER_URL}/motus/chill/guess`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, guess }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Erreur essai (HTTP ${res.status})`);
    if (data.code) err.code = data.code;
    throw err;
  }
  return data;
}

/**
 * Demande la revelation du mot apres epuisement des essais.
 * @param {string} token
 * @returns {Promise<{revealedWord: string}>}
 */
export async function motusChillReveal(token) {
  const res = await fetch(`${CONFIG.WORKER_URL}/motus/chill/reveal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Erreur revelation (HTTP ${res.status})`);
  }
  return await res.json();
}

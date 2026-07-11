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
 *
 * @param {string} game slug du jeu (ex: "petitbac", "motus")
 * @param {object} [options] metadonnees a passer a la creation. Pour Motus :
 *   { mode: "coop_stream" | "competitive" }. Ignore par Petit Bac.
 * @returns {Promise<string>} code de la room (ex: "ABC123")
 */
export async function createRoom(game = "petitbac", options) {
  const init = { method: "POST" };
  if (options && typeof options === "object") {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(options);
  }
  const res = await fetch(`${CONFIG.WORKER_URL}/${game}/rooms`, init);
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
// Motus chill, endpoints REST stateless
// ===========================================================================

/**
 * Tire un nouveau mot pour le mode chill solo. Renvoie un token opaque a
 * conserver pour les essais suivants et la 1ere lettre du mot.
 *
 * @param {number} wordLength entre 5 et 10
 * @param {number} maxAttempts entre 4 et 8
 * @returns {Promise<{token: string, firstLetter: string, wordLength: number, maxAttempts: number}>}
 */
export async function motusChillDraw(wordLength, maxAttempts, avoidFirstLetters) {
  const res = await fetch(`${CONFIG.WORKER_URL}/motus/chill/draw`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      wordLength,
      maxAttempts,
      avoidFirstLetters: Array.isArray(avoidFirstLetters) ? avoidFirstLetters : [],
    }),
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

// ===========================================================================
// Definitions, banque de mots pour le mode chill solo
// ===========================================================================

/**
 * Recupere toute la banque de mots/expressions du jeu Definitions.
 * Utilise par le mode chill solo : on telecharge tout au demarrage de la
 * session puis on shuffle cote client. Pas d'aller-retour au worker pour
 * chaque mot. Le payload est leger (~150 KB pour ~1000 entrees).
 *
 * @returns {Promise<{words: Array<{word:string, definition:string}>}>}
 */
export async function fetchDefinitionWords() {
  const res = await fetch(`${CONFIG.WORKER_URL}/definitions/words`);
  if (!res.ok) {
    throw new Error(`Erreur chargement banque (HTTP ${res.status})`);
  }
  return await res.json();
}

/**
 * Envoie un vote de difficulte pour un mot du jeu Definitions.
 *
 * Anonyme par construction : on ne transmet que le mot et la note. Aucun
 * pseudo, aucune identification. Le worker n'agrege qu'une somme et un
 * compteur par mot.
 *
 * L'echec est volontairement silencieux cote appelant : un vote perdu ne doit
 * jamais interrompre une partie.
 *
 * @param {string} word  le mot ou l'expression note
 * @param {number} score note de 1 a 5 (decimales acceptees, ex. 3.4)
 * @returns {Promise<{ok:boolean, count?:number, moyenne?:number}>}
 */
export async function sendDifficultyVote(word, score) {
  const res = await fetch(`${CONFIG.WORKER_URL}/definitions/vote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ word, score }),
  });
  if (!res.ok) {
    throw new Error(`Vote refuse (HTTP ${res.status})`);
  }
  return await res.json();
}

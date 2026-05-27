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

// Simulation du DO MotsMelesRoom : le mot mystere ouvert des le lancement,
// avec essais limites. Verifie aussi que la grille reste jouable.
import { makeRoom, connect, send, check, summary } from "./harness.mjs";
import { MotsMelesRoom } from "../build/motsmeles/room.js";

function gameState(sock) { return sock.last("game_state"); }

async function startChacun(room, a, b) {
  send(a.server, { type: "start", mode: "chacun", gridSize: 10, level: "facile", duration: 300 });
}

console.log("\n--- Mystere ouvert des le lancement (chacun) ---");
{
  const room = makeRoom(MotsMelesRoom);
  const a = await connect(room, "Alice");
  const b = await connect(room, "Bobby");
  a.server.clear(); b.server.clear();
  await startChacun(room, a, b);

  const ga = gameState(a.server), gb = gameState(b.server);
  check("game_state envoye aux deux joueurs", !!ga && !!gb);
  check("mysteryOpen vrai des le start pour l'hote", ga.game.mysteryOpen === true, ga.game.mysteryOpen);
  check("mysteryOpen vrai des le start pour l'autre", gb.game.mysteryOpen === true, gb.game.mysteryOpen);
  check("definition envoyee", typeof ga.game.mysteryDefinition === "string" && ga.game.mysteryDefinition.length > 0);
  check("longueur envoyee", ga.game.mysteryLength >= 5 && ga.game.mysteryLength <= 12, ga.game.mysteryLength);
  check("3 essais au depart", ga.game.mysteryTriesLeft === 3, ga.game.mysteryTriesLeft);
  check("aucun mot trouve au depart", ga.game.found.length === 0);
  check("plus aucun message mystery_open", a.server.ofType("mystery_open").length === 0);
  check("alarme posee", room.state.storage.alarm !== null);
}

console.log("\n--- Deviner sans avoir vide sa grille est permis ---");
{
  const room = makeRoom(MotsMelesRoom);
  const a = await connect(room, "Alice");
  const b = await connect(room, "Bobby");
  await startChacun(room, a, b);
  a.server.clear();

  const word = room.mysteryWord;
  send(a.server, { type: "mysteryGuess", guess: word });

  const res = a.server.last("mystery_result");
  check("mystery_result recu", !!res);
  check("succes sans aucun mot trouve", res && res.ok === true, res);
  check("pas d'erreur WRONG_PHASE", a.server.ofType("error").length === 0, a.server.ofType("error"));
  const me = room.players.get("Alice");
  check("bonus +3 credite", me.score === 3, me.score);
  check("solvedMystery vrai", me.solvedMystery === true);
  check("un succes ne consomme pas d'essai", me.mysteryTries === 0, me.mysteryTries);
  check("scores rediffuses a tous", b.server.ofType("scores").length > 0);
}

console.log("\n--- Limite de 3 essais ---");
{
  const room = makeRoom(MotsMelesRoom);
  const a = await connect(room, "Alice");
  const b = await connect(room, "Bobby");
  await startChacun(room, a, b);
  a.server.clear();

  send(a.server, { type: "mysteryGuess", guess: "ZZZZZA" });
  check("1er ratage : 2 essais restants", a.server.last("mystery_result").triesLeft === 2, a.server.last("mystery_result"));
  send(a.server, { type: "mysteryGuess", guess: "ZZZZZB" });
  check("2e ratage : 1 essai restant", a.server.last("mystery_result").triesLeft === 1);
  send(a.server, { type: "mysteryGuess", guess: "ZZZZZC" });
  const third = a.server.last("mystery_result");
  check("3e ratage : 0 essai restant", third.triesLeft === 0, third);
  check("message d'epuisement", /Plus d'essais/.test(third.message), third.message);

  // 4e tentative, et cette fois avec le BON mot : doit etre refusee.
  send(a.server, { type: "mysteryGuess", guess: room.mysteryWord });
  const fourth = a.server.last("mystery_result");
  check("4e tentative refusee meme si correcte", fourth.ok === false, fourth);
  check("pas de bonus apres epuisement", room.players.get("Alice").score === 0, room.players.get("Alice").score);
  check("essais plafonnes a 3", room.players.get("Alice").mysteryTries === 3);
}

console.log("\n--- Essais et bonus sont individuels ---");
{
  const room = makeRoom(MotsMelesRoom);
  const a = await connect(room, "Alice");
  const b = await connect(room, "Bobby");
  await startChacun(room, a, b);
  a.server.clear(); b.server.clear();

  send(a.server, { type: "mysteryGuess", guess: "ZZZZZA" });
  send(a.server, { type: "mysteryGuess", guess: "ZZZZZB" });
  check("Alice a brule 2 essais", room.players.get("Alice").mysteryTries === 2);
  check("Bobby garde ses 3 essais", room.players.get("Bobby").mysteryTries === 0);

  send(b.server, { type: "mysteryGuess", guess: room.mysteryWord });
  check("Bobby trouve", room.players.get("Bobby").solvedMystery === true);
  check("Alice n'a pas le bonus", room.players.get("Alice").solvedMystery === false);
  check("Bobby a 3 points", room.players.get("Bobby").score === 3);
}

console.log("\n--- La grille reste jouable, mystere ouvert ---");
{
  const room = makeRoom(MotsMelesRoom);
  const a = await connect(room, "Alice");
  const b = await connect(room, "Bobby");
  await startChacun(room, a, b);
  a.server.clear();

  // Alice devine le mystere tout de suite, puis continue a chercher des mots.
  send(a.server, { type: "mysteryGuess", guess: room.mysteryWord });
  const w = room.words[0];
  send(a.server, { type: "claim", cells: w.cells });
  const found = a.server.last("found");
  check("un mot est encore validable apres le mystere", !!found && found.word.word === w.word, found && found.word);
  check("score = 3 (mystere) + 1 (mot)", room.players.get("Alice").score === 4, room.players.get("Alice").score);
}

console.log("\n--- Chaine des lettres restantes (propriete du generateur) ---");
{
  const room = makeRoom(MotsMelesRoom);
  const a = await connect(room, "Alice");
  const b = await connect(room, "Bobby");
  await startChacun(room, a, b);

  // On rejoue le calcul du client : lettres non couvertes, ordre de lecture.
  function remaining(foundWords) {
    const taken = new Set();
    for (const w of foundWords) for (const c of w.cells) taken.add(c.r + "," + c.c);
    let out = "";
    for (let r = 0; r < room.gridSize; r++)
      for (let c = 0; c < room.gridSize; c++)
        if (!taken.has(r + "," + c)) out += room.grid[r][c];
    return out;
  }

  const atStart = remaining([]);
  check("chaine longue au depart", atStart.length > room.mysteryWord.length, atStart.length);
  const half = room.words.slice(0, Math.floor(room.words.length / 2));
  const mid = remaining(half);
  check("chaine plus courte a mi-parcours", mid.length < atStart.length && mid.length > room.mysteryWord.length,
    { atStart: atStart.length, mid: mid.length, myst: room.mysteryWord.length });
  const all = remaining(room.words);
  check("grille videe : la chaine EST le mot mystere", all === room.mysteryWord, { all, myst: room.mysteryWord });
}

console.log("\n--- Mode commune : pas de mystere ---");
{
  const room = makeRoom(MotsMelesRoom);
  const a = await connect(room, "Alice");
  const b = await connect(room, "Bobby");
  a.server.clear(); b.server.clear();
  send(a.server, { type: "start", mode: "commune", gridSize: 10, level: "facile", duration: 300 });

  const ga = gameState(a.server);
  check("mysteryOpen faux en commune", ga.game.mysteryOpen === false);
  check("pas de definition", ga.game.mysteryDefinition === null);
  check("pas de longueur", ga.game.mysteryLength === null);
  check("0 essai", ga.game.mysteryTriesLeft === 0);
  a.server.clear();
  send(a.server, { type: "mysteryGuess", guess: room.mysteryWord });
  const errs = a.server.ofType("error");
  check("tentative refusee en commune", errs.length === 1 && errs[0].code === "WRONG_PHASE", errs);
  check("pas de bonus", room.players.get("Alice").score === 0);
}

console.log("\n--- Reconnexion : l'etat mystere est conserve ---");
{
  const room = makeRoom(MotsMelesRoom);
  const a = await connect(room, "Alice");
  const b = await connect(room, "Bobby");
  await startChacun(room, a, b);
  send(a.server, { type: "mysteryGuess", guess: "ZZZZZA" });
  check("Alice a brule 1 essai", room.players.get("Alice").mysteryTries === 1);

  // Alice rafraichit sa page : nouvelle connexion, meme pseudo.
  const a2 = await connect(room, "Alice");
  const joined = a2.server.last("joined");
  check("snapshot renvoye", !!joined && !!joined.game);
  check("mystere toujours ouvert apres reconnexion", joined.game.mysteryOpen === true);
  check("essais restants conserves", joined.game.mysteryTriesLeft === 2, joined.game.mysteryTriesLeft);
  check("definition toujours la", typeof joined.game.mysteryDefinition === "string" && joined.game.mysteryDefinition.length > 0);
}

console.log("\n--- Fin de partie : le mot est revele ---");
{
  const room = makeRoom(MotsMelesRoom);
  const a = await connect(room, "Alice");
  const b = await connect(room, "Bobby");
  await startChacun(room, a, b);
  send(b.server, { type: "mysteryGuess", guess: room.mysteryWord });
  const word = room.mysteryWord;
  a.server.clear(); b.server.clear();

  await room.alarm(); // fin du minuteur

  const fin = a.server.last("finished");
  check("finished diffuse", !!fin);
  check("mot mystere revele", fin.mysteryWord === word, fin.mysteryWord);
  check("Bobby vainqueur avec son bonus", fin.winner === "Bobby", fin.winner);
  check("classement trie", fin.ranking[0].pseudo === "Bobby");
}

console.log("\n--- Departage au chrono a score egal ---");
{
  const room = makeRoom(MotsMelesRoom);
  const a = await connect(room, "Alice");
  const b = await connect(room, "Bobby");
  await startChacun(room, a, b);

  // Les deux trouvent le mystere, Alice d'abord.
  send(a.server, { type: "mysteryGuess", guess: room.mysteryWord });
  const tA = room.players.get("Alice").lastFindAt;
  room.players.get("Bobby").lastFindAt = 0;
  send(b.server, { type: "mysteryGuess", guess: room.mysteryWord });
  room.players.get("Bobby").lastFindAt = tA + 5000; // Bobby a fini 5 s plus tard

  check("meme score", room.players.get("Alice").score === room.players.get("Bobby").score);
  a.server.clear();
  await room.alarm();
  const fin = a.server.last("finished");
  check("le plus rapide passe devant", fin.ranking[0].pseudo === "Alice", fin.ranking.map((p) => p.pseudo));
}

summary();

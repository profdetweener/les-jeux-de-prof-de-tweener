// La chaine des cases restantes doit converger EXACTEMENT vers le mot mystere
// sur toutes les tailles et difficultes. C'est la propriete sur laquelle repose
// l'affichage des lettres dans la modale : si elle casse, le joueur voit une
// chaine qui ne vaut pas le mystere une fois sa grille videe.
import { makeRoom, connect, send, check, summary } from "./harness.mjs";
import { MotsMelesRoom } from "../build/motsmeles/room.js";

const ITER = 12;

function remainingFor(room, foundWords) {
  const taken = new Set();
  for (const w of foundWords) for (const c of w.cells) taken.add(c.r + "," + c.c);
  let out = "";
  for (let r = 0; r < room.gridSize; r++)
    for (let c = 0; c < room.gridSize; c++)
      if (!taken.has(r + "," + c)) out += room.grid[r][c];
  return out;
}

for (const size of [10, 12, 14]) {
  for (const level of ["facile", "moyen", "difficile"]) {
    let ok = 0, bad = null, minStart = Infinity, maxStart = 0;
    for (let i = 0; i < ITER; i++) {
      const room = makeRoom(MotsMelesRoom);
      const a = await connect(room, "Alice");
      const b = await connect(room, "Bobby");
      send(a.server, { type: "start", mode: "chacun", gridSize: size, level, duration: 300 });
      if (!room.words.length) { bad = "generation vide"; break; }
      const all = remainingFor(room, room.words);
      const start = remainingFor(room, []).length;
      minStart = Math.min(minStart, start); maxStart = Math.max(maxStart, start);
      if (all === room.mysteryWord) ok++;
      else if (!bad) bad = { attendu: room.mysteryWord, obtenu: all };
    }
    check(`${size}x${size} ${level} : ${ok}/${ITER} convergent (chaine initiale ${minStart} a ${maxStart} lettres)`,
      ok === ITER, bad);
  }
}

summary();

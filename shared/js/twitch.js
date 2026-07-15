/**
 * Lecture anonyme du tchat Twitch, en WebSocket sur l'IRC.
 *
 * Aucun token, aucun compte : Twitch autorise la lecture d'un salon public sous
 * un pseudo "justinfan" quelconque. On ne peut donc QUE lire, ce qui est
 * exactement ce qu'il faut ici (et il n'y a aucun secret a proteger dans une
 * page statique).
 *
 * Meme approche que le Blind Test, extraite ici pour servir aux autres jeux.
 *
 *   const chat = new TwitchChat("prof_de_tweener");
 *   chat.on("message", (m) => console.log(m.name, m.text));
 *   chat.on("status", (s) => ...);   // "wait" | "on" | "err"
 *   chat.connect();
 *   chat.close();
 */

const IRC_URL = "wss://irc-ws.chat.twitch.tv:443";
const RETRY_MS = 3000;

export class TwitchChat {
  constructor(channel) {
    this.channel = String(channel || "").toLowerCase().replace(/^#/, "").trim();
    this.ws = null;
    this.closed = false;
    this.retry = null;
    this.handlers = { message: [], status: [] };
  }

  on(evt, fn) { (this.handlers[evt] = this.handlers[evt] || []).push(fn); return this; }
  emit(evt, arg) { for (const fn of this.handlers[evt] || []) fn(arg); }

  connect() {
    if (!this.channel) return this.emit("status", { state: "err", text: "Chaîne manquante" });
    this.closed = false;
    this.cleanup();
    this.emit("status", { state: "wait", text: "Connexion au tchat…" });
    let ws;
    try { ws = new WebSocket(IRC_URL); } catch (e) {
      return this.emit("status", { state: "err", text: "Connexion impossible" });
    }
    this.ws = ws;
    ws.onopen = () => {
      ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      ws.send("NICK justinfan" + Math.floor(Math.random() * 90000 + 10000));
      ws.send("JOIN #" + this.channel);
    };
    ws.onmessage = (ev) => {
      String(ev.data).split("\r\n").forEach((line) => {
        if (!line) return;
        // Twitch ping le client : sans PONG, il coupe au bout de quelques minutes.
        if (line.startsWith("PING")) { ws.send("PONG :tmi.twitch.tv"); return; }
        if (line.includes(" JOIN #" + this.channel)) {
          this.emit("status", { state: "on", text: "Tchat de #" + this.channel });
        }
        if (line.includes(" PRIVMSG #")) {
          const m = parseLine(line);
          if (m) this.emit("message", m);
        }
      });
    };
    ws.onerror = () => this.emit("status", { state: "err", text: "Erreur de connexion" });
    ws.onclose = () => {
      if (this.closed) return;
      this.emit("status", { state: "err", text: "Déconnecté, reconnexion…" });
      this.retry = setTimeout(() => this.connect(), RETRY_MS);
    };
  }

  cleanup() {
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    if (this.ws) {
      try { this.ws.onclose = null; this.ws.close(); } catch (e) { /* deja ferme */ }
      this.ws = null;
    }
  }

  close() { this.closed = true; this.cleanup(); }
}

/**
 * Une ligne IRC ressemble a :
 *   @badge=..;display-name=Toto;.. :toto!toto@toto.tmi.twitch.tv PRIVMSG #salon :mon message
 * Les tags en tete sont optionnels ; le display-name respecte la casse choisie
 * par le viewer, on le prefere au nick.
 */
function parseLine(line) {
  let display = null, rest = line;
  if (line[0] === "@") {
    const sp = line.indexOf(" ");
    const tags = line.slice(1, sp);
    rest = line.slice(sp + 1);
    const dm = tags.match(/(?:^|;)display-name=([^;]*)/);
    if (dm && dm[1]) display = dm[1];
  }
  const pm = rest.indexOf(" PRIVMSG #");
  if (pm < 0) return null;
  const nm = rest.slice(0, pm).match(/:?([^!]+)!/);
  const after = rest.slice(pm);
  const start = after.indexOf(" :");
  if (start < 0) return null;
  const text = after.slice(start + 2);
  const name = display || (nm && nm[1]) || "";
  if (!name || !text) return null;
  return { name, text };
}

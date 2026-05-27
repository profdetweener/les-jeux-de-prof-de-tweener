/**
 * Wrapper autour de WebSocket :
 *   - reconnexion automatique apres deconnexion non volontaire
 *   - file d'attente des messages tant que la connexion n'est pas ouverte
 *   - dispatch par type de message ServerMessage
 *
 * Usage :
 *   const conn = new RoomConnection("ABC123");
 *   conn.on("room_state", (msg) => { ... });
 *   conn.connect();
 *   conn.send({ type: "join", pseudo: "Max" });
 */

import { CONFIG } from "./config.js";

export class RoomConnection {
  /**
   * @param {string} roomCode code de la room
   * @param {string} [game="petitbac"] slug du jeu (definit le prefixe d'URL)
   */
  constructor(roomCode, game = "petitbac") {
    this.roomCode = roomCode;
    this.game = game;
    this.ws = null;
    this.handlers = new Map(); // type -> Set<callback>
    this.statusHandlers = new Set(); // callback(status, detail?)
    this.outbox = []; // messages en attente d'envoi
    this.shouldReconnect = true;
    this.reconnectTimer = null;
    this.status = "idle"; // idle | connecting | open | closed | error
  }

  /**
   * Ouvre la connexion WebSocket.
   */
  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.shouldReconnect = true;
    this._setStatus("connecting");

    const url = `${CONFIG.WS_URL}/${this.game}/room/${encodeURIComponent(this.roomCode)}`;
    this.ws = new WebSocket(url);

    this.ws.addEventListener("open", () => {
      this._setStatus("open");
      // Vide la file d'attente
      while (this.outbox.length > 0) {
        const msg = this.outbox.shift();
        this.ws.send(JSON.stringify(msg));
      }
    });

    this.ws.addEventListener("message", (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        console.warn("Message non JSON recu :", event.data);
        return;
      }
      const type = data.type;
      if (!type) return;
      const handlers = this.handlers.get(type);
      if (handlers) {
        for (const cb of handlers) {
          try {
            cb(data);
          } catch (err) {
            console.error(`Erreur dans handler ${type} :`, err);
          }
        }
      }
    });

    this.ws.addEventListener("close", (event) => {
      this._setStatus("closed", { code: event.code, reason: event.reason });
      if (this.shouldReconnect) {
        this._scheduleReconnect();
      }
    });

    this.ws.addEventListener("error", () => {
      this._setStatus("error");
      // Pas de reconnect explicite ici : "close" sera declenche juste apres
    });
  }

  /**
   * Envoie un message au serveur. Si la connexion n'est pas ouverte,
   * le message est mis en file et envoye a l'ouverture.
   */
  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      this.outbox.push(message);
    }
  }

  /**
   * Ferme proprement la connexion (pas de reconnexion auto).
   */
  close() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Enregistre un handler pour un type de message serveur.
   * @param {string} type
   * @param {(msg: any) => void} callback
   */
  on(type, callback) {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type).add(callback);
  }

  /**
   * Enregistre un handler pour les changements de statut de connexion.
   * @param {(status: string, detail?: any) => void} callback
   */
  onStatus(callback) {
    this.statusHandlers.add(callback);
    // On notifie immediatement avec le statut courant
    callback(this.status);
  }

  _setStatus(status, detail) {
    this.status = status;
    for (const cb of this.statusHandlers) {
      try {
        cb(status, detail);
      } catch (err) {
        console.error("Erreur dans statusHandler :", err);
      }
    }
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) {
        this.connect();
      }
    }, CONFIG.WS_RECONNECT_DELAY);
  }
}

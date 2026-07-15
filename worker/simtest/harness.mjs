// Harnais de simulation du DO MotsMelesRoom hors runtime Cloudflare.
// On mocke les globals utilises par room.ts : WebSocketPair, Response.json,
// crypto, et un DurableObjectState avec storage + setAlarm + blockConcurrencyWhile.

import { EventEmitter } from "node:events";

// ---- WebSocket mocke : paire client/serveur reliee ----
class FakeWS extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.peer = null;
    this.sent = [];
    this.closed = false;
    this.closeInfo = null;
    this.listeners = {};
  }
  accept() { /* no-op */ }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  fire(type, ev) {
    for (const fn of this.listeners[type] || []) fn(ev);
  }
  send(data) {
    if (this.closed) throw new Error("send on closed socket");
    this.sent.push(JSON.parse(data));
    if (this.peer) this.peer.fire("message", { data });
  }
  close(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.closeInfo = { code, reason };
    this.fire("close", { code, reason });
  }
  // Messages recus par ce socket, filtres par type.
  ofType(t) { return this.sent.filter((m) => m.type === t); }
  last(t) { const a = this.ofType(t); return a[a.length - 1] || null; }
  clear() { this.sent = []; }
}

globalThis.WebSocketPair = function WebSocketPair() {
  const client = new FakeWS("client");
  const server = new FakeWS("server");
  client.peer = server; server.peer = client;
  return { 0: client, 1: server };
};

// On ecrase le Response natif de Node : undici refuse le status 101 du
// handshake WebSocket et ignore le champ `webSocket`, alors que le runtime
// Cloudflare les accepte tous les deux.
globalThis.Response = class Response {
  constructor(body, init) {
    this.body = body;
    this.init = init || {};
    this.status = this.init.status || 200;
    this.webSocket = this.init.webSocket || null;
  }
};
Response.json = (obj, init) => {
  const r = new Response(JSON.stringify(obj), init);
  r._json = obj;
  r.json = async () => obj;
  return r;
};

if (typeof globalThis.crypto === "undefined") {
  globalThis.crypto = { randomUUID: () => "uuid-" + Math.random().toString(16).slice(2) };
}

// ---- DurableObjectState mocke ----
export class FakeStorage {
  constructor() { this.map = new Map(); this.alarm = null; }
  async get(k) { return this.map.get(k); }
  async put(k, v) { this.map.set(k, v); }
  async delete(k) { return this.map.delete(k); }
  async setAlarm(t) { this.alarm = t; }
  async deleteAlarm() { this.alarm = null; }
  async getAlarm() { return this.alarm; }
}

export class FakeState {
  constructor() { this.storage = new FakeStorage(); }
  async blockConcurrencyWhile(fn) { return fn(); }
}

// ---- Utilitaires de test ----
export function makeRoom(RoomClass) {
  return new RoomClass(new FakeState());
}

// Connecte un joueur : renvoie le socket serveur (celui que le DO ecoute) et
// le socket client (celui qui recoit les messages envoyes par le DO).
export async function connect(room, pseudo) {
  const req = {
    url: "https://x/motsmeles/ROOM/ws",
    headers: { get: (h) => (h === "Upgrade" ? "websocket" : null) },
  };
  const res = await room.fetch(req);
  const client = res.webSocket;
  const server = client.peer;
  // room.ts ecoute sur `server` ; les envois du DO partent de `server.send` et
  // atterrissent dans server.sent. On lit donc server.sent.
  server.fire("message", { data: JSON.stringify({ type: "join", pseudo }) });
  return { client, server };
}

export function send(sock, msg) {
  sock.fire("message", { data: JSON.stringify(msg) });
}

let passed = 0, failed = 0;
export function check(label, cond, extra) {
  if (cond) { passed++; console.log("  ok   " + label); }
  else { failed++; console.log("  FAIL " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}
export function summary() {
  console.log("\n" + passed + " ok, " + failed + " echec(s)");
  if (failed > 0) process.exit(1);
}

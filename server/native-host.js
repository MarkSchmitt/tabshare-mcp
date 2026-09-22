#!/usr/bin/env node
"use strict";

// Native messaging host. Firefox starts this process when the first tab gets
// shared and closes its stdin when the last one is unshared. It is a dumb
// relay between the extension (stdin/stdout, length-prefixed JSON) and any
// number of MCP servers (unix socket, newline-delimited JSON).
//
// stdout belongs to the native messaging protocol — never log to it.

const fs = require("node:fs");
const net = require("node:net");
const { socketPath, lineReader } = require("./common");

const SOCKET = socketPath();
const MAX_TO_EXTENSION = 900 * 1024; // Firefox rejects host->extension messages over 1 MB.

const clients = new Map();
let nextClient = 1;

function toExtension(msg) {
  const body = Buffer.from(JSON.stringify(msg));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
}

function fromExtension(msg) {
  if (typeof msg.id !== "string") return;
  const sep = msg.id.indexOf(":");
  const client = clients.get(Number(msg.id.slice(0, sep)));
  if (!client) return;
  const id = JSON.parse(msg.id.slice(sep + 1));
  client.write(`${JSON.stringify({ ...msg, id })}\n`);
}

let inbuf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  inbuf = Buffer.concat([inbuf, chunk]);
  while (inbuf.length >= 4) {
    const len = inbuf.readUInt32LE(0);
    if (inbuf.length < 4 + len) break;
    const body = inbuf.subarray(4, 4 + len);
    inbuf = inbuf.subarray(4 + len);
    try { fromExtension(JSON.parse(body.toString())); } catch (e) { console.error("tabshare host:", e); }
  }
});
process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

const server = net.createServer((conn) => {
  const clientId = nextClient++;
  clients.set(clientId, conn);
  toExtension({ event: "clients", count: clients.size });
  conn.setEncoding("utf8");
  conn.on("data", lineReader((msg) => {
    const wrapped = { id: `${clientId}:${JSON.stringify(msg.id)}`, method: msg.method, params: msg.params };
    if (JSON.stringify(wrapped).length > MAX_TO_EXTENSION) {
      conn.write(`${JSON.stringify({ id: msg.id, error: "Request too large." })}\n`);
      return;
    }
    toExtension(wrapped);
  }));
  const gone = () => {
    if (!clients.delete(clientId)) return;
    toExtension({ event: "clients", count: clients.size });
  };
  conn.on("close", gone);
  conn.on("error", gone);
});

function listen() {
  process.umask(0o077);
  server.listen(SOCKET, () => {
    fs.chmodSync(SOCKET, 0o600);
    toExtension({ event: "ready" });
  });
}

server.on("error", (e) => {
  toExtension({ event: "error", message: `Native host: ${e.message}` });
  process.exit(1);
});

// A leftover socket file from a crashed host is removed; a live one means
// another Firefox instance/profile is already sharing.
if (fs.existsSync(SOCKET)) {
  const probe = net.connect(SOCKET);
  probe.on("connect", () => {
    probe.destroy();
    toExtension({ event: "error", message: "Another Firefox instance is already sharing tabs via TabShare." });
    setTimeout(() => process.exit(1), 100);
  });
  probe.on("error", () => {
    try { fs.unlinkSync(SOCKET); } catch (_) { /* raced */ }
    listen();
  });
} else {
  listen();
}

let owned = false;
server.on("listening", () => { owned = true; });

function shutdown() {
  if (owned) {
    try { fs.unlinkSync(SOCKET); } catch (_) { /* already gone */ }
  }
  process.exit(0);
}

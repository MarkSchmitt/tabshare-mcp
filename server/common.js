"use strict";

const os = require("node:os");
const path = require("node:path");

// Rendezvous point between the native host (started by Firefox) and the MCP
// servers (started by agents). A unix socket, so only this user can reach it.
function socketPath() {
  if (process.env.TABSHARE_SOCKET) return process.env.TABSHARE_SOCKET;
  const dir = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  return path.join(dir, `tabshare-mcp-${os.userInfo().uid}.sock`);
}

// Splits a byte stream into newline-delimited JSON messages.
function lineReader(onMessage) {
  let buf = "";
  return (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      onMessage(msg);
    }
  };
}

module.exports = { socketPath, lineReader };

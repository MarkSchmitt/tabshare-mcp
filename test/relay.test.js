"use strict";

// End-to-end test of mcp-server <-> native-host with a fake extension that
// speaks the native messaging framing on the host's stdio.

const assert = require("node:assert");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { lineReader } = require("../server/common");

const sockPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tabshare-test-")), "s.sock");
const env = { ...process.env, TABSHARE_SOCKET: sockPath };
const server = (name) => path.join(__dirname, "..", "server", name);

function startHost(onRequest) {
  const host = spawn(process.execPath, [server("native-host.js")], { env, stdio: ["pipe", "pipe", "inherit"] });
  children.push(host);
  const events = [];
  let buf = Buffer.alloc(0);
  const write = (msg) => {
    const body = Buffer.from(JSON.stringify(msg));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    host.stdin.write(Buffer.concat([header, body]));
  };
  host.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
      const len = buf.readUInt32LE(0);
      const msg = JSON.parse(buf.subarray(4, 4 + len).toString());
      buf = buf.subarray(4 + len);
      if (msg.event) events.push(msg);
      else write({ id: msg.id, ...onRequest(msg) });
    }
  });
  return { host, events };
}

function startMcp() {
  const mcp = spawn(process.execPath, [server("mcp-server.js")], { env, stdio: ["pipe", "pipe", "inherit"] });
  children.push(mcp);
  const waiting = new Map();
  let id = 0;
  mcp.stdout.setEncoding("utf8");
  mcp.stdout.on("data", lineReader((msg) => {
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  }));
  const rpc = (method, params) => new Promise((resolve) => {
    waiting.set(++id, resolve);
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  return { mcp, rpc };
}

const until = async (cond, what = "condition") => {
  const deadline = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

// Nothing in here should take long; a hang is a failure, not a wait.
const children = [];
const watchdog = setTimeout(() => { console.error("relay test: timed out"); cleanup(1); }, 30000);
function cleanup(code) {
  for (const c of children) { try { c.kill(); } catch (_) { /* gone */ } }
  fs.rmSync(path.dirname(sockPath), { recursive: true, force: true });
  process.exit(code);
}

(async () => {
  const { mcp, rpc } = startMcp();

  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  const list = await rpc("tools/list", {});
  assert.ok(list.result.tools.length >= 15);

  // No host running: friendly error, not a crash.
  let res = await rpc("tools/call", { name: "list_shared_tabs", arguments: {} });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /No tab is shared/);

  const { host, events } = startHost((req) => {
    if (req.method === "screenshot") return { result: { image: { data: "AAAA", mimeType: "image/png" }, text: "shot" } };
    if (req.method === "click") return { error: "Tab 7 is shared view-only" };
    return { result: { text: `echo ${req.method} ${JSON.stringify(req.params)}` } };
  });
  await until(() => events.some((e) => e.event === "ready"), "host ready");
  assert.equal(fs.statSync(sockPath).mode & 0o777, 0o600);

  res = await rpc("tools/call", { name: "snapshot", arguments: { tabId: 7 } });
  assert.equal(res.result.content[0].text, 'echo snapshot {"tabId":7}');
  await until(() => events.some((e) => e.event === "clients" && e.count === 1), "clients=1");

  res = await rpc("tools/call", { name: "screenshot", arguments: {} });
  assert.deepEqual(res.result.content[0], { type: "image", data: "AAAA", mimeType: "image/png" });

  res = await rpc("tools/call", { name: "click", arguments: { ref: "e1" } });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /view-only/);

  // A second agent session: its own MCP server, same host. Interleaved calls
  // must each get their own answer back, with the original request ids.
  const second = startMcp();
  await second.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t2", version: "0" } });
  const [a, b, c] = await Promise.all([
    rpc("tools/call", { name: "get_text", arguments: { tabId: 1 } }),
    second.rpc("tools/call", { name: "get_text", arguments: { tabId: 2 } }),
    rpc("tools/call", { name: "get_html", arguments: { tabId: 3 } }),
  ]);
  assert.equal(a.result.content[0].text, 'echo get_text {"tabId":1}');
  assert.equal(b.result.content[0].text, 'echo get_text {"tabId":2}');
  assert.equal(c.result.content[0].text, 'echo get_html {"tabId":3}');
  await until(() => events.some((e) => e.event === "clients" && e.count === 2), "clients=2");
  second.mcp.stdin.end();
  await until(() => events.some((e) => e.event === "clients" && e.count === 1 && events.indexOf(e) > events.findIndex((x) => x.count === 2)), "clients back to 1");

  // Extension disconnects (last tab unshared): host exits and cleans up.
  host.stdin.end();
  await new Promise((r) => host.on("exit", r));
  assert.equal(fs.existsSync(sockPath), false);

  res = await rpc("tools/call", { name: "snapshot", arguments: {} });
  assert.equal(res.result.isError, true);

  mcp.stdin.end();
  clearTimeout(watchdog);
  console.log("relay test: ok");
  cleanup(0);
})().catch((e) => { console.error(e); cleanup(1); });

#!/usr/bin/env node
"use strict";

// Registers the TabShare native messaging host with the Firefox-family
// browsers of the current user. This is about Firefox, not about the agent:
// it is the same one-time step for Claude Code, opencode or any other MCP
// client. Re-run after upgrading (it refreshes the host copy) or after
// switching Node installations.
//
//   node scripts/install-native-host.js [options]
//     --browser=firefox|librewolf|waterfox   register with this browser only
//     --all                                  register with every known browser
//     --client=claude|opencode|json          print only that client's config snippet
//     --uninstall                            remove everything this script wrote
//     --help
//
// Without --browser/--all it registers with every browser that has a profile
// directory (or Firefox, if none has been started yet).

const fs = require("node:fs");
const path = require("node:path");
const { HOST_NAME, BROWSERS, dataDir, hostCopyDir, launcher, stateFile, detected, sandboxed } = require("./browsers");

const repo = path.resolve(__dirname, "..");
const pkg = require(path.join(repo, "package.json"));
const manifest = JSON.parse(fs.readFileSync(path.join(repo, "extension", "manifest.json"), "utf8"));
const EXTENSION_ID = manifest.browser_specific_settings.gecko.id;
const HOST_FILES = ["native-host.js", "common.js"];
const mcpServer = path.join(repo, "server", "mcp-server.js");

// ---------------------------------------------------------------------------
// Arguments

const args = new Map();
for (const a of process.argv.slice(2)) {
  const m = /^--([a-z]+)(?:=(.*))?$/.exec(a);
  if (!m || !["browser", "all", "client", "uninstall", "help"].includes(m[1])) {
    console.error(`Unknown option: ${a}\n`);
    usage(1);
  }
  args.set(m[1], m[2] === undefined ? true : m[2]);
}
if (args.has("help")) usage(0);

function usage(code) {
  const lines = fs.readFileSync(__filename, "utf8").split("\n").slice(2); // skip shebang + "use strict"
  const text = lines.slice(1, lines.findIndex((l) => !l.startsWith("//"))).map((l) => l.slice(3)).join("\n");
  (code ? console.error : console.log)(text);
  process.exit(code);
}

if (process.platform === "win32") {
  fail("Windows registers native messaging hosts in the registry; this script only supports Linux and macOS.");
}

// ---------------------------------------------------------------------------
// Uninstall

if (args.has("uninstall")) {
  const removed = [];
  const rm = (f) => { if (fs.existsSync(f)) { fs.rmSync(f, { recursive: true, force: true }); removed.push(f); } };
  for (const b of Object.values(BROWSERS)) rm(path.join(b.hostDir, `${HOST_NAME}.json`));
  rm(launcher); rm(hostCopyDir); rm(stateFile);
  try { fs.rmdirSync(dataDir); } catch (_) { /* not empty or absent */ }
  if (removed.length) console.log(`Removed:\n${removed.map((f) => `  ${f}`).join("\n")}`);
  else console.log("Nothing to remove — the native host was not registered.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Preflight

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 18) fail(`Node ${process.versions.node} is too old; TabShare needs Node 18 or newer.`);

for (const f of HOST_FILES) {
  if (!fs.existsSync(path.join(repo, "server", f))) fail(`${path.join(repo, "server", f)} is missing — is this a complete checkout?`);
}

let targets;
if (args.has("browser")) {
  if (!BROWSERS[args.get("browser")]) fail(`Unknown browser "${args.get("browser")}". Known: ${Object.keys(BROWSERS).join(", ")}.`);
  targets = [args.get("browser")];
} else if (args.has("all")) {
  targets = Object.keys(BROWSERS);
} else {
  targets = detected();
  const boxed = sandboxed();
  if (targets.length === 0 && boxed.length > 0) {
    fail(`Only a sandboxed Firefox was found (${boxed.map((s) => s.label).join(", ")}).\n` +
      "Flatpak and Snap builds cannot run a native messaging host from your home directory:\n" +
      "there is no Node inside the sandbox and the socket would be in a different namespace.\n" +
      "Please use a Firefox from your distribution or from mozilla.org, then re-run this script.");
  }
  if (boxed.length > 0) {
    warn(`${boxed.map((s) => s.label).join(" and ")} detected as well — those builds are not supported and will be skipped.`);
  }
  if (targets.length === 0) {
    warn("No browser profile directory found yet; registering with Firefox. Use --browser or --all for others.");
    targets = ["firefox"];
  }
}

// Node from a version manager works until that version is removed or, with
// fnm, until the shell that ran this script exits.
const nodeBin = process.execPath;
if (/\/(\.nvm|\.fnm|fnm_multishells|\.volta|\.asdf|\.n\/)/.test(nodeBin)) {
  warn(`Pinning Node from a version manager (${nodeBin}).\n` +
    "  Firefox starts the host outside your shell, so this exact binary must keep existing.\n" +
    "  If you later remove that Node version, re-run this script. A system Node (e.g. /usr/bin/node) is more robust.");
}

// ---------------------------------------------------------------------------
// Install

fs.mkdirSync(hostCopyDir, { recursive: true });
// The host is copied out of the checkout so that plugin managers which
// re-download the code into a versioned cache directory on update cannot
// break the registration.
for (const f of HOST_FILES) fs.copyFileSync(path.join(repo, "server", f), path.join(hostCopyDir, f));
const hostScript = path.join(hostCopyDir, "native-host.js");

const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
fs.writeFileSync(launcher, [
  "#!/bin/sh",
  "# Written by tabshare-mcp/scripts/install-native-host.js — Firefox starts this to reach the native host.",
  `NODE=${sq(nodeBin)}`,
  `HOST=${sq(hostScript)}`,
  '[ -x "$NODE" ] || { echo "tabshare-mcp: node not found at $NODE — re-run install-native-host.js" >&2; exit 1; }',
  '[ -f "$HOST" ] || { echo "tabshare-mcp: native host missing at $HOST — re-run install-native-host.js" >&2; exit 1; }',
  'exec "$NODE" "$HOST" "$@"',
  "",
].join("\n"), { mode: 0o755 });

const written = [];
for (const key of targets) {
  const b = BROWSERS[key];
  fs.mkdirSync(b.hostDir, { recursive: true });
  const file = path.join(b.hostDir, `${HOST_NAME}.json`);
  fs.writeFileSync(file, `${JSON.stringify({
    name: HOST_NAME,
    description: "TabShare MCP relay between Firefox and local MCP servers",
    path: launcher,
    type: "stdio",
    allowed_extensions: [EXTENSION_ID],
  }, null, 2)}\n`);
  written.push([b.label, file]);
}

fs.writeFileSync(stateFile, `${JSON.stringify({
  version: pkg.version,
  installedAt: new Date().toISOString(),
  source: repo,
  node: nodeBin,
  extensionId: EXTENSION_ID,
  browsers: targets,
}, null, 2)}\n`);

// ---------------------------------------------------------------------------
// Report

console.log(`Native host ${pkg.version} registered for ${written.map(([l]) => l).join(", ")}:`);
for (const [, f] of written) console.log(`  ${f}`);
console.log(`Host copied to ${hostCopyDir}, launcher ${launcher} (node: ${nodeBin})`);

const client = args.get("client");
const snippets = {
  claude: `Claude Code:\n  claude mcp add --scope user firefox-tabs -- node ${sq(mcpServer)}`,
  opencode: `opencode (~/.config/opencode/opencode.json or a project opencode.json):\n${indent(JSON.stringify({
    mcp: { "firefox-tabs": { type: "local", command: ["node", mcpServer], enabled: true } },
  }, null, 2))}`,
  json: `Any other MCP client (stdio):\n${indent(JSON.stringify({
    mcpServers: { "firefox-tabs": { command: "node", args: [mcpServer] } },
  }, null, 2))}`,
};
if (client && !snippets[client]) fail(`Unknown client "${client}". Known: ${Object.keys(snippets).join(", ")}.`);
console.log("\nNext: install the extension in Firefox (see README), then register the MCP server with your agent.\n");
for (const [k, s] of Object.entries(snippets)) if (!client || client === k) console.log(`${s}\n`);

function indent(s) { return s.split("\n").map((l) => `  ${l}`).join("\n"); }
function warn(msg) { console.error(`Warning: ${msg}`); }
function fail(msg) { console.error(`Error: ${msg}`); process.exit(1); }

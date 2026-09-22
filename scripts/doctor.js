#!/usr/bin/env node
"use strict";

// Answers "why can't the agent see my tab?" without guessing.
//   node scripts/doctor.js   (or: npm run doctor)
// Exit code 1 if anything is broken.

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { HOST_NAME, BROWSERS, hostCopyDir, launcher, stateFile, sandboxed } = require("./browsers");
const { socketPath } = require("../server/common");

const repo = path.resolve(__dirname, "..");
const pkg = require(path.join(repo, "package.json"));
const manifest = JSON.parse(fs.readFileSync(path.join(repo, "extension", "manifest.json"), "utf8"));
const EXTENSION_ID = manifest.browser_specific_settings.gecko.id;

let failures = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const warn = (m) => console.log(`  warn  ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL  ${m}`); };

console.log(`TabShare MCP ${pkg.version} — ${repo}\n`);

// Node
const major = Number(process.versions.node.split(".")[0]);
if (major >= 18) ok(`Node ${process.versions.node}`);
else bad(`Node ${process.versions.node} is too old (need >= 18)`);

// Registration state
let state = null;
if (fs.existsSync(stateFile)) {
  state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  if (state.version === pkg.version) ok(`native host registered (version ${state.version}, ${state.installedAt})`);
  else warn(`native host was registered from version ${state.version}, this checkout is ${pkg.version} — re-run: npm run install-host`);
  if (state.extensionId !== EXTENSION_ID) bad(`registered for extension id ${state.extensionId}, manifest now says ${EXTENSION_ID} — re-run: npm run install-host`);
} else {
  bad(`native host not registered (no ${stateFile}) — run: npm run install-host`);
}

// Launcher + host copy
if (fs.existsSync(launcher)) {
  try { fs.accessSync(launcher, fs.constants.X_OK); ok(`launcher ${launcher}`); }
  catch (_) { bad(`launcher ${launcher} is not executable`); }
  const nodeLine = /^NODE='(.*)'$/m.exec(fs.readFileSync(launcher, "utf8"));
  const nodeBin = nodeLine && nodeLine[1].replace(/'\\''/g, "'");
  if (nodeBin && fs.existsSync(nodeBin)) ok(`launcher uses node ${nodeBin}`);
  else bad(`launcher points at a node binary that no longer exists (${nodeBin}) — re-run: npm run install-host`);
} else if (state) {
  bad(`launcher ${launcher} is missing — re-run: npm run install-host`);
}
for (const f of ["native-host.js", "common.js"]) {
  const copy = path.join(hostCopyDir, f);
  if (!fs.existsSync(copy)) { if (state) bad(`host copy ${copy} is missing — re-run: npm run install-host`); continue; }
  const same = fs.readFileSync(copy).equals(fs.readFileSync(path.join(repo, "server", f)));
  if (same) ok(`host copy ${f} matches this checkout`);
  else warn(`host copy ${f} differs from this checkout — re-run: npm run install-host`);
}

// Browser manifests
let registered = 0;
for (const b of Object.values(BROWSERS)) {
  const file = path.join(b.hostDir, `${HOST_NAME}.json`);
  if (!fs.existsSync(file)) { if (fs.existsSync(b.profileDir)) warn(`${b.label}: profile found but no manifest at ${file}`); continue; }
  registered++;
  let m;
  try { m = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { bad(`${b.label}: ${file} is not valid JSON`); continue; }
  if (!fs.existsSync(m.path)) bad(`${b.label}: manifest points at ${m.path}, which does not exist`);
  else if (m.path !== launcher) warn(`${b.label}: manifest points at ${m.path}, not at ${launcher}`);
  else ok(`${b.label}: ${file}`);
  if (!(m.allowed_extensions || []).includes(EXTENSION_ID)) {
    bad(`${b.label}: allowed_extensions ${JSON.stringify(m.allowed_extensions)} does not include ${EXTENSION_ID} — Firefox will refuse to start the host`);
  }
}
if (registered === 0 && state) bad("no browser has a manifest — re-run: npm run install-host");
for (const s of sandboxed()) warn(`${s.label} found at ${s.dir} — sandboxed builds are not supported`);

// Socket
const sock = socketPath();
if (!fs.existsSync(sock)) {
  ok(`no socket at ${sock} — normal while no tab is shared`);
  done();
} else {
  const c = net.connect(sock);
  c.once("connect", () => { c.destroy(); ok(`native host is running and accepting connections (${sock}) — a tab is shared right now`); done(); });
  c.once("error", (e) => { bad(`socket ${sock} exists but refuses connections (${e.code}) — stale file from a crashed host; unshare and share again`); done(); });
}

function done() {
  console.log(failures ? `\n${failures} problem(s) found.` : "\nEverything looks fine.");
  process.exit(failures ? 1 : 0);
}

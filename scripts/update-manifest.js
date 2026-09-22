#!/usr/bin/env node
"use strict";

// Adds a signed XPI to updates.json, the self-hosted update manifest that
// installed copies of the extension poll (browser_specific_settings.gecko.update_url).
//   node scripts/update-manifest.js dist/tabshare_mcp-0.2.0.xpi
// The XPI itself is attached to the GitHub release of the same version.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const xpi = process.argv[2];
if (!xpi || !fs.existsSync(xpi)) {
  console.error("usage: node scripts/update-manifest.js <path/to/signed.xpi>");
  process.exit(1);
}
const { version, repository } = require(path.join(root, "package.json"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension", "manifest.json"), "utf8"));
const id = manifest.browser_specific_settings.gecko.id;
const repoUrl = repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
const assetName = `tabshare-mcp-${version}.xpi`;

const file = path.join(root, "updates.json");
const updates = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { addons: {} };
const entry = (updates.addons[id] ||= { updates: [] });
entry.updates = entry.updates.filter((u) => u.version !== version);
entry.updates.push({
  version,
  update_link: `${repoUrl}/releases/download/v${version}/${assetName}`,
  update_hash: `sha256:${crypto.createHash("sha256").update(fs.readFileSync(xpi)).digest("hex")}`,
});
fs.writeFileSync(file, `${JSON.stringify(updates, null, 2)}\n`);
console.log(`updates.json: added ${version} -> ${assetName}`);

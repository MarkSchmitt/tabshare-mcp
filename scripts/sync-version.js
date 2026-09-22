#!/usr/bin/env node
"use strict";

// package.json is the single source of truth for the version. This copies it
// into extension/manifest.json (the MCP server reads package.json directly).
//   node scripts/sync-version.js          write
//   node scripts/sync-version.js --check  exit 1 if the manifest is out of date

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const { version } = require(path.join(root, "package.json"));
const manifestFile = path.join(root, "extension", "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));

if (manifest.version === version) {
  console.log(`extension/manifest.json already at ${version}`);
  process.exit(0);
}
if (process.argv.includes("--check")) {
  console.error(`extension/manifest.json is ${manifest.version}, package.json is ${version} — run: npm run version:sync`);
  process.exit(1);
}
manifest.version = version;
fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`extension/manifest.json ${manifest.version} -> ${version}`);

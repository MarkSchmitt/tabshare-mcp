# Contributing

Issues and pull requests are welcome. A few things that make life easier:

* **Runtime has zero dependencies** — `server/` and `extension/` must stay plain Node / plain
  WebExtension code and work on Node 18+. `web-ext` is the only dev dependency (lint, build, sign)
  and needs Node 20+.
* **Manifest V2 is deliberate.** The extension needs a persistent background page to hold the
  native-messaging port and the set of shared tabs; Firefox still supports MV2.
* **All access control lives in `extension/background.js`.** If you add a tool, add it to
  `READ_METHODS` or `CONTROL_METHODS` there, to `TOOLS` in `server/mcp-server.js`, and to the table
  in the README.
* Before a PR: `npm test` (relay test, no Firefox needed), `npm run lint:ext`, and
  `npm run version:check`. CI runs the same on Linux and macOS.
* To try changes in a throwaway profile: `npm run dev` (web-ext run). To test against your real
  Firefox: `about:debugging` → *Load Temporary Add-on…* → `extension/manifest.json`.
* Versions live in `package.json`; run `npm run version:sync` to copy it into the extension manifest.
  Releases are cut by pushing a `v*` tag (see `.github/workflows/release.yml`).

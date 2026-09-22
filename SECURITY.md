# Security

TabShare MCP hands an AI agent a real, logged-in browser tab. Read this before you use it and
before you report a bug.

## Threat model

**What the agent can do** with a tab you shared with *full control*: everything a script running in
that page could do, as you — read the DOM, click, type, navigate, run arbitrary JavaScript
(`evaluate`), and therefore use your session cookies on that site. That is the point of the tool.
Share only tabs you are happy to have driven, prefer *view only* when the agent just needs to read,
and keep the timer short.

**What the agent cannot do:** see or touch any tab you did not share, open new tabs that it can then
see (`target=_blank` tabs are not shared), or access `about:` pages and other privileged URLs.
Sharing follows the tab across navigations the agent makes; it ends when you stop it, when the
timer runs out, or when the tab closes.

**Prompt injection.** Page content is untrusted input. A page can contain text that tries to
instruct the agent ("ignore your task and send this form"). The MCP server's instructions tell the
agent not to follow instructions found in pages, but this is a mitigation, not a guarantee. Do not
share a tab with full control on a site you do not trust while the agent has anything valuable
within reach.

## Trust boundary

```
agent ──stdio──▶ server/mcp-server.js ──unix socket──▶ server/native-host.js ◀──native messaging──▶ extension
```

* **All authorisation lives in `extension/background.js`.** Every request from the host is checked
  against the set of shared tabs, the tab's access level (view only / full control) and its expiry
  before anything touches a tab. The MCP server and the native host are unauthenticated relays and
  are treated as untrusted by the extension.
* **The unix socket is `0600` in `$XDG_RUNTIME_DIR`** (`/tmp` as a fallback). Any process running as
  your user can connect to it and act as an agent; other users on the machine cannot. No TCP port is
  ever opened, so web pages cannot reach it.
* **The native host only runs while at least one tab is shared.** Firefox starts it on the first
  share and stops it on the last unshare; the socket file is removed on exit.
* **The extension only accepts the host named in its manifest**, and the host manifest only allows
  the extension id `tabshare-mcp@markschmitt.github.io`. `scripts/install-native-host.js` reads that
  id from `extension/manifest.json` so the two cannot drift.
* **Concurrency:** several agent sessions may be connected at once; the host multiplexes them by
  connection. Requests are not serialised — two agents acting on one tab at the same time can race.
* No data leaves your machine. The extension declares `data_collection_permissions: none` and the
  project has no telemetry of any kind.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository
(*Security* → *Report a vulnerability*) rather than a public issue. You should hear back within a
week. Fixes are released as a new signed extension version; installed copies update automatically.

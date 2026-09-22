# TabShare MCP

Share **individual Firefox tabs** with an AI agent — Claude Code, opencode or any other MCP client —
in the exact state they are in, for a limited time, clearly marked, revocable at any moment.

No remote-debugging port, no `--marionette`, no special profile, no headless browser: the agent works
in your real, logged-in session, and tabs you did not share are invisible to it.

```
agent ──stdio──▶ server/mcp-server.js ──unix socket──▶ server/native-host.js ◀──native messaging──▶ extension
(MCP client)    (one per agent session)   (0600, per user)  (started by Firefox while ≥1 tab is shared)
```

* The **extension** owns all policy: which tabs are shared, view-only vs. full control, expiry.
  Every request is checked there.
* The **native host** is a dumb relay that Firefox itself launches when you share the first tab and
  stops when you unshare the last one. While nothing is shared there is no socket and no process.
* Any number of agent sessions can be connected at the same time. No TCP port is opened anywhere.

## Installation

Requirements: Linux or macOS · Firefox ≥ 140 (also LibreWolf, Waterfox; **not** Flatpak/Snap builds,
see [below](#things-to-know)) · Node ≥ 18. The runtime has no npm dependencies.

### 1. Install the Firefox extension

Download `tabshare-mcp-<version>.xpi` from the [latest release](https://github.com/MarkSchmitt/tabshare-mcp/releases/latest)
and open it in Firefox (or `about:addons` → gear → *Install Add-on From File…*). It is signed by
Mozilla and updates itself.

Firefox hides new extensions behind the puzzle-piece **Extensions** button: open it, click the gear
next to *TabShare MCP* → **Pin to Toolbar**, so the `ON` / count badge is always visible.

### 2. Register the native messaging host

This step is about Firefox, not about the agent — it is the same for every MCP client.

**With Claude Code**, install the plugin and let it do it:

```
/plugin marketplace add MarkSchmitt/tabshare-mcp
/plugin install tabshare-mcp@tabshare
/tabshare-mcp:setup
```

**Otherwise**, clone and run the installer:

```sh
git clone https://github.com/MarkSchmitt/tabshare-mcp.git
cd tabshare-mcp
node scripts/install-native-host.js
```

It writes `~/.mozilla/native-messaging-hosts/tabshare_mcp.json` (and the LibreWolf / Waterfox /
macOS equivalents for every browser it finds), and copies the host into
`~/.local/share/tabshare-mcp/` together with a launcher that pins the absolute path of `node`.
Re-run it after upgrading or switching Node versions; `--uninstall` removes everything it wrote,
`--help` lists the options.

### 3. Tell your agent about the MCP server

The Claude Code plugin already provides the server — skip this. For everything else, the server is
plain stdio: `node /path/to/tabshare-mcp/server/mcp-server.js`. The installer prints the snippet for
your client (`--client=claude|opencode|json`):

**Claude Code without the plugin**

```sh
claude mcp add --scope user firefox-tabs -- node "$PWD/server/mcp-server.js"
```

**opencode** — `~/.config/opencode/opencode.json` or a project `opencode.json`:

```json
{
  "mcp": {
    "firefox-tabs": {
      "type": "local",
      "command": ["node", "/path/to/tabshare-mcp/server/mcp-server.js"],
      "enabled": true
    }
  }
}
```

**Any other MCP client** (Cline, Cursor, Zed, LM Studio, your own SDK code):

```json
{ "mcpServers": { "firefox-tabs": { "command": "node", "args": ["/path/to/tabshare-mcp/server/mcp-server.js"] } } }
```

### 4. Check that it works

Share any normal web page (toolbar button → *Share this tab with agent*); the page gets a red frame.
Then ask the agent to *"look at my shared Firefox tab"* — it should call `list_shared_tabs` and see
it. If not: `npm run doctor` (or `/tabshare-mcp:doctor`) says what is wrong.

## Using it

1. On the tab you want to show: toolbar button → choose *Full control* / *View only*, a duration and
   optionally a note for the agent → **Share this tab**. Also: tab context menu, or `Alt+Shift+S`
   (uses the last settings).
2. Tell the agent what to do with it.
3. Stop any time: the **Stop sharing** button in the page banner, the popup, the tab context menu,
   closing the tab — or just let the timer run out.

While shared, a tab shows a red frame and a banner with countdown and the agent's current action
(orange when view-only), sits in a red *"Shared with agent"* tab group so you can spot it in the tab
strip, and the toolbar badge reads `ON` (on other tabs: the number of shared tabs). The popup lists
the agent's recent actions and how many agent sessions are connected.

## Tools

| view only | full control (additionally) |
|---|---|
| `list_shared_tabs`, `snapshot`, `get_text`, `get_html`, `screenshot`, `scroll`, `wait_for` | `click`, `type`, `press_key`, `select_option`, `hover`, `navigate`, `go_back`, `go_forward`, `reload`, `evaluate` |

Clients prefix tool names differently (Claude Code: `mcp__firefox-tabs__snapshot`, opencode:
`firefox-tabs_snapshot`). `snapshot` returns a compact role/name tree with `[ref=eN]` handles, the
scroll position and the text you currently have selected; refs stay valid until the element leaves
the page. Password field values are masked. `screenshot` returns an image — the model has to be
vision-capable to see it.

## Things to know

* **Full control means the agent acts as you on that site** — your cookies, your login. `evaluate`
  runs arbitrary JS in the page. Page content is untrusted input and may try to instruct the agent;
  see [SECURITY.md](SECURITY.md) for the threat model.
* Sharing follows the *tab*, including navigations the agent performs. Tabs opened from it
  (`target=_blank`) are **not** shared.
* Input is synthetic DOM events (`isTrusted=false`); sites that insist on trusted events or native
  key handling may not react. Only the top frame is inspected; iframes show up as `iframe [src=…]`.
* `about:`, `addons.mozilla.org` and other privileged pages cannot be accessed by any extension.
* Several agents may use one tab at the same time; their requests are not serialised, so two agents
  *typing* into the same page can race. Reading concurrently is fine.
* One Firefox instance per user can share at a time.
* **Flatpak and Snap Firefox are not supported:** the sandbox has no Node inside it and cannot start a
  host from your home directory. Use a distribution package or the build from mozilla.org.
  Windows is not supported yet (native hosts are registered in the registry there).

## Development

```sh
npm install         # web-ext only; the runtime needs nothing
npm test            # relay test: MCP server <-> native host <-> fake extension, no Firefox needed
npm run lint:ext
npm run dev         # web-ext run: throwaway profile with the extension loaded
npm run doctor      # diagnose an installation
```

To use your working copy in your real Firefox: `about:debugging` → *This Firefox* → *Load Temporary
Add-on…* → `extension/manifest.json`. It stays until Firefox restarts; use *Reload* there after
changing extension code (this ends all current shares). On builds that honour it (ESR, Developer
Edition, Nightly, many distro builds) you can instead set `xpinstall.signatures.required` to `false`
in `about:config` and install `npm run build:ext`'s zip permanently.

Releases: bump the version in `package.json`, `npm run version:sync`, commit, tag `v<version>` and
push the tag. The [release workflow](.github/workflows/release.yml) signs the extension through
addons.mozilla.org (unlisted channel — Mozilla signs, nobody can self-sign), records it in
`updates.json` so installed copies update, and attaches the `.xpi` to a GitHub release.

## License

[MIT](LICENSE)

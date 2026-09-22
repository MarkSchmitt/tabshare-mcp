---
description: One-time setup — register the TabShare native messaging host with Firefox and explain how to install the extension.
---

Set up TabShare MCP for this user. Do these steps in order and report the outcome of each plainly.

1. Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/install-native-host.js" --client=claude`
   - It registers the native messaging host with every Firefox-family browser it finds and copies the
     host out of the plugin directory so plugin updates cannot break it.
   - If it fails with a sandbox (Flatpak/Snap) message, relay that message verbatim: those builds
     cannot be supported and the user needs a distro or mozilla.org Firefox.
2. Ignore the `claude mcp add` line it prints — this plugin already provides the `firefox-tabs` MCP server.
3. Tell the user to install the Firefox extension: download the latest `tabshare-mcp-<version>.xpi` from
   https://github.com/MarkSchmitt/tabshare-mcp/releases and open it in Firefox (or `about:addons` → gear →
   *Install Add-on From File…*), then pin the *TabShare MCP* button to the toolbar via the puzzle-piece Extensions menu.
4. Tell them to share a tab (toolbar button → *Share this tab with agent*) and ask you to look at it.
   Then call `list_shared_tabs` to confirm it works.

If anything fails, run `/tabshare-mcp:doctor`.

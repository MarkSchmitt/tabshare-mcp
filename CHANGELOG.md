# Changelog

## 0.1.0 — 2026-09-22

First public release.

* Firefox extension: share individual tabs with an agent, view only or full control, with a
  timer, an in-page banner, a red tab group and an activity log.
* MCP server (stdio, zero dependencies) with `list_shared_tabs`, `snapshot`, `get_text`,
  `get_html`, `screenshot`, `scroll`, `wait_for`, `click`, `type`, `press_key`, `select_option`,
  `hover`, `navigate`, `go_back`, `go_forward`, `reload`, `evaluate`.
* Native messaging host that is started by Firefox on the first share and exits on the last
  unshare; any number of agent sessions can connect at once.
* Installer for Firefox, LibreWolf and Waterfox on Linux and macOS; `npm run doctor` for
  diagnostics; installable as a Claude Code plugin.

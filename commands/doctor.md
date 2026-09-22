---
description: Diagnose why the agent cannot reach a shared Firefox tab.
---

Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.js"`

Explain each FAIL/warn line to the user in one sentence and say what to do about it. The most common causes:
- native host not registered → `/tabshare-mcp:setup`
- host copy out of date after a plugin update → `/tabshare-mcp:setup` again (safe to repeat)
- "no socket — normal while no tab is shared" together with the user saying a tab *is* shared → the
  extension is not installed or was loaded temporarily and Firefox has restarted since; check the
  toolbar button shows a red frame on the tab
- Flatpak/Snap Firefox → not supported, needs a distro or mozilla.org build

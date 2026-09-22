"use strict";

// TabShare MCP — background page.
//
// Holds the set of explicitly shared tabs and is the *only* place where
// agent requests are authorised: every request coming from the native host
// is checked against `shared` before anything touches a tab.

const HOST_NAME = "tabshare_mcp";
const LOG_LIMIT = 30;
const GROUP_TITLE = "Shared with agent";

const READ_METHODS = new Set([
  "list_shared_tabs", "snapshot", "get_text", "get_html", "screenshot", "wait_for", "scroll",
]);
const CONTROL_METHODS = new Set([
  "click", "type", "press_key", "select_option", "hover",
  "navigate", "go_back", "go_forward", "reload", "evaluate",
]);

/** tabId -> { mode, since, expiresAt, note, timer, log, groupedByUs } */
const shared = new Map();
let prefs = { mode: "control", minutes: 30, group: true };
let port = null;
let hostError = null;
let agentCount = 0;

browser.storage.local.get("prefs").then((s) => {
  if (s.prefs) prefs = { ...prefs, ...s.prefs };
});

// ---------------------------------------------------------------------------
// Sharing lifecycle

async function share(tabId, opts = {}) {
  const mode = opts.mode === "read" ? "read" : "control";
  const minutes = Number.isFinite(opts.minutes) ? opts.minutes : prefs.minutes;
  const prev = shared.get(tabId);
  if (prev) clearTimeout(prev.timer);

  const entry = {
    mode,
    since: prev ? prev.since : Date.now(),
    expiresAt: minutes > 0 ? Date.now() + minutes * 60000 : null,
    note: opts.note !== undefined ? String(opts.note).slice(0, 2000) : prev ? prev.note : "",
    timer: null,
    log: prev ? prev.log : [],
    groupedByUs: prev ? prev.groupedByUs : false,
  };
  if (entry.expiresAt) {
    entry.timer = setTimeout(() => unshare(tabId), entry.expiresAt - Date.now());
  }
  shared.set(tabId, entry);

  ensureHost();
  if (!prev) await addToGroup(tabId, entry);
  await decorate(tabId);
  updateBadges();
}

async function unshare(tabId, { tabGone = false } = {}) {
  const entry = shared.get(tabId);
  if (!entry) return;
  clearTimeout(entry.timer);
  shared.delete(tabId);
  lastLoading.delete(tabId);

  if (!tabGone) {
    browser.tabs.sendMessage(tabId, { target: "overlay", op: "remove" }, { frameId: 0 }).catch(() => {});
    browser.browserAction.setBadgeText({ tabId, text: null }).catch(() => {});
    if (entry.groupedByUs && browser.tabs.ungroup) {
      browser.tabs.ungroup(tabId).catch(() => {});
    }
  }
  updateBadges();
  if (shared.size === 0) disconnectHost();
}

function unshareAll() {
  for (const tabId of [...shared.keys()]) unshare(tabId);
}

// Give the tab its own red tab group so it is recognisable in the tab strip
// even when it is not the active tab. A single-tab group does not move the
// tab. Tabs the user already grouped are left alone.
async function addToGroup(tabId, entry) {
  if (!prefs.group || !browser.tabs.group) return;
  try {
    const tab = await browser.tabs.get(tabId);
    if (tab.pinned || (tab.groupId !== undefined && tab.groupId !== -1)) return;
    const groupId = await browser.tabs.group({ tabIds: [tabId] });
    entry.groupedByUs = true;
    if (browser.tabGroups) {
      await browser.tabGroups.update(groupId, { title: GROUP_TITLE, color: "red" });
    }
  } catch (e) {
    console.warn("tabshare: could not group tab", e);
  }
}

// (Re-)apply the in-page overlay and the toolbar badge. Needed after every
// navigation since both are reset by Firefox when the document changes.
async function decorate(tabId) {
  const entry = shared.get(tabId);
  if (!entry) return;
  browser.browserAction.setBadgeText({ tabId, text: "ON" }).catch(() => {});
  browser.browserAction.setBadgeBackgroundColor({ tabId, color: "#e22850" }).catch(() => {});
  try {
    await browser.tabs.executeScript(tabId, { file: "/content/overlay.js", runAt: "document_start" });
    await browser.tabs.sendMessage(
      tabId,
      { target: "overlay", op: "show", mode: entry.mode, expiresAt: entry.expiresAt },
      { frameId: 0 },
    );
  } catch (_) {
    // Privileged page (about:, addons.mozilla.org, …) — nothing to decorate.
  }
}

function updateBadges() {
  browser.browserAction.setBadgeBackgroundColor({ color: "#b85c00" });
  browser.browserAction.setBadgeText({ text: shared.size ? String(shared.size) : "" });
}

browser.tabs.onUpdated.addListener((tabId, change) => {
  if (shared.has(tabId) && change.status) decorate(tabId);
});
browser.tabs.onRemoved.addListener((tabId) => unshare(tabId, { tabGone: true }));

// ---------------------------------------------------------------------------
// Native host connection — only alive while at least one tab is shared.

function ensureHost() {
  if (port) return;
  hostError = null;
  try {
    port = browser.runtime.connectNative(HOST_NAME);
  } catch (e) {
    hostError = String(e.message || e);
    return;
  }
  const thisPort = port;
  thisPort.onMessage.addListener(onHostMessage);
  thisPort.onDisconnect.addListener((p) => {
    if (port !== thisPort) return;
    port = null;
    agentCount = 0;
    if (shared.size > 0) {
      const err = p.error && p.error.message;
      hostError = hostError || err || "Native host exited unexpectedly.";
      setTimeout(() => { if (shared.size > 0 && !port) ensureHost(); }, 5000);
    }
  });
}

function disconnectHost() {
  if (!port) return;
  const p = port;
  port = null;
  agentCount = 0;
  p.disconnect();
}

async function onHostMessage(msg) {
  if (msg.event === "clients") { agentCount = msg.count; return; }
  if (msg.event === "error") { hostError = msg.message; return; }
  if (msg.event === "ready") { hostError = null; return; }
  if (msg.id === undefined) return;

  let reply;
  try {
    reply = { id: msg.id, result: await handleRequest(msg.method, msg.params || {}) };
  } catch (e) {
    reply = { id: msg.id, error: String((e && e.message) || e) };
  }
  if (port) port.postMessage(reply);
}

// ---------------------------------------------------------------------------
// Agent requests

function resolveTab(params) {
  if (shared.size === 0) {
    throw new Error("No tab is shared right now. Ask the user to share one via the TabShare toolbar button.");
  }
  let tabId = params.tabId;
  if (tabId === undefined || tabId === null) {
    if (shared.size > 1) {
      throw new Error(`Several tabs are shared (${[...shared.keys()].join(", ")}); pass tabId. Use list_shared_tabs to see them.`);
    }
    tabId = shared.keys().next().value;
  }
  const entry = shared.get(tabId);
  if (!entry) throw new Error(`Tab ${tabId} is not shared (sharing may have ended). Use list_shared_tabs.`);
  return { tabId, entry };
}

async function handleRequest(method, params) {
  if (method === "list_shared_tabs") return listSharedTabs();

  const isControl = CONTROL_METHODS.has(method);
  if (!isControl && !READ_METHODS.has(method)) throw new Error(`Unknown method: ${method}`);

  const { tabId, entry } = resolveTab(params);
  if (isControl && entry.mode !== "control") {
    throw new Error(`Tab ${tabId} is shared view-only; "${method}" needs the user to grant full control.`);
  }
  logActivity(tabId, entry, method, params);
  const started = Date.now();

  switch (method) {
    case "screenshot": return screenshot(tabId, params);
    case "evaluate": return evaluate(tabId, params);
    case "navigate": {
      let url;
      try { url = new URL(params.url); } catch (_) { throw new Error(`Invalid URL: ${params.url}`); }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Only http(s) URLs may be opened.");
      }
      await browser.tabs.update(tabId, { url: url.href });
      return settle(tabId, 800, started);
    }
    case "go_back": await browser.tabs.goBack(tabId); return settle(tabId, 800, started);
    case "go_forward": await browser.tabs.goForward(tabId); return settle(tabId, 800, started);
    case "reload": await browser.tabs.reload(tabId); return settle(tabId, 800, started);
    default: {
      const result = await callAgent(tabId, method, params);
      if (!isControl) return result;
      // Hovering never navigates; don't make the agent wait for it.
      const after = await settle(tabId, method === "hover" ? 0 : 800, started);
      return { text: `${result.text}\n${after.text}` };
    }
  }
}

async function listSharedTabs() {
  const out = [];
  for (const [tabId, entry] of shared) {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab) continue;
    out.push({
      tabId,
      title: tab.title,
      url: tab.url,
      active: tab.active,
      access: entry.mode === "control" ? "full control" : "view only",
      minutesLeft: entry.expiresAt ? Math.max(0, Math.round((entry.expiresAt - Date.now()) / 60000)) : null,
      noteFromUser: entry.note || undefined,
    });
  }
  return { text: JSON.stringify(out, null, 2) };
}

async function callAgent(tabId, op, params) {
  try {
    await browser.tabs.executeScript(tabId, { file: "/content/agent.js", runAt: "document_start" });
  } catch (e) {
    throw new Error(`This page cannot be accessed by extensions (${e.message}).`);
  }
  const res = await browser.tabs.sendMessage(tabId, { target: "agent", op, params }, { frameId: 0 });
  if (!res) throw new Error("No response from page.");
  if (res.error) throw new Error(res.error);
  return res;
}

// tabId -> time of the last "loading" event, to notice navigations that an
// action triggers with some delay (form submits, JS redirects).
const lastLoading = new Map();
browser.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading" && shared.has(tabId)) lastLoading.set(tabId, Date.now());
});

// Wait for a navigation that the last action may have triggered: give it up
// to `quiet` ms to start, then wait for the load to finish.
async function settle(tabId, quiet = 800, since = Date.now()) {
  const quietUntil = Date.now() + quiet;
  while (Date.now() < quietUntil && !((lastLoading.get(tabId) || 0) >= since)) await sleep(50);
  if ((lastLoading.get(tabId) || 0) >= since) await sleep(100);
  const deadline = Date.now() + 15000;
  let tab = await browser.tabs.get(tabId);
  while (tab.status !== "complete" && Date.now() < deadline) {
    await sleep(150);
    tab = await browser.tabs.get(tabId);
  }
  const state = tab.status === "complete" ? "" : " (still loading)";
  return { text: `Page: ${tab.url} — "${tab.title}"${state}` };
}

async function screenshot(tabId, params) {
  const format = params.format === "jpeg" ? "jpeg" : "png";
  const opts = { format, scale: params.scale > 0 ? Math.min(params.scale, 3) : 1 };
  if (format === "jpeg") opts.quality = 85;
  let note = "";
  if (params.fullPage) {
    const m = await callAgent(tabId, "metrics", {});
    const height = Math.min(m.pageHeight, 12000);
    if (height < m.pageHeight) note = ` (cropped to ${height} of ${m.pageHeight}px)`;
    opts.rect = { x: 0, y: 0, width: m.pageWidth, height };
  }
  const overlayMsg = (op) =>
    browser.tabs.sendMessage(tabId, { target: "overlay", op }, { frameId: 0 }).catch(() => {});
  await overlayMsg("hide");
  let dataUrl;
  try {
    dataUrl = await browser.tabs.captureTab(tabId, opts);
  } finally {
    overlayMsg("unhide");
  }
  const comma = dataUrl.indexOf(",");
  return {
    image: { data: dataUrl.slice(comma + 1), mimeType: `image/${format}` },
    text: `Screenshot of tab ${tabId}${params.fullPage ? " (full page)" : ""}${note}`,
  };
}

// Runs in the content-script world of the page: full DOM access, the page's
// own JS globals are reachable via window.wrappedJSObject.
async function evaluate(tabId, params) {
  if (typeof params.code !== "string") throw new Error("code must be a string");
  await callAgent(tabId, "ping", {});
  const wrapped = `(async () => {
    try {
      const ref = (r) => globalThis.__tabshareAgent.byRef(r);
      const value = await (async (ref) => {\n${params.code}\n})(ref);
      return { ok: true, value: value === undefined ? "undefined" : JSON.stringify(value, null, 2) };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  })()`;
  let results;
  const started = Date.now();
  try {
    results = await browser.tabs.executeScript(tabId, { code: wrapped });
  } catch (e) {
    throw new Error(`Script failed: ${e.message}`);
  }
  const r = results && results[0];
  if (!r) throw new Error("Script returned nothing (result not serialisable?)");
  if (!r.ok) throw new Error(r.error);
  const after = await settle(tabId, 300, started);
  return { text: `${truncate(r.value, params.maxChars || 30000)}\n${after.text}` };
}

function logActivity(tabId, entry, method, params) {
  const detail = params.url || params.ref || params.selector || params.key || params.text || "";
  entry.log.push({ t: Date.now(), method, detail: String(detail).slice(0, 80) });
  if (entry.log.length > LOG_LIMIT) entry.log.shift();
  browser.tabs
    .sendMessage(tabId, { target: "overlay", op: "activity", text: method }, { frameId: 0 })
    .catch(() => {});
}

function truncate(s, max) {
  return s.length > max ? `${s.slice(0, max)}\n… [truncated, ${s.length - max} more chars]` : s;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// UI plumbing: popup, overlay "Stop" button, tab context menu, shortcut

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.target !== "bg") return undefined;
  switch (msg.op) {
    case "state": return getState(msg.tabId);
    case "share":
      prefs = { ...prefs, mode: msg.mode, minutes: msg.minutes };
      browser.storage.local.set({ prefs });
      return share(msg.tabId, msg).then(() => getState(msg.tabId));
    case "unshare": {
      const tabId = msg.tabId !== undefined ? msg.tabId : sender.tab && sender.tab.id;
      return unshare(tabId).then(() => getState(msg.tabId));
    }
    case "unshareAll":
      unshareAll();
      return getState(msg.tabId);
    case "setGroupPref":
      prefs = { ...prefs, group: !!msg.value };
      browser.storage.local.set({ prefs });
      return getState(msg.tabId);
    default: return undefined;
  }
});

async function getState(currentTabId) {
  const tabs = [];
  for (const [tabId, entry] of shared) {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    tabs.push({
      tabId,
      title: tab ? tab.title : "(unknown)",
      mode: entry.mode,
      expiresAt: entry.expiresAt,
      note: entry.note,
      log: tabId === currentTabId ? entry.log : undefined,
    });
  }
  return { tabs, prefs, hostError, hostConnected: !!port, agentCount };
}

async function toggle(tab) {
  if (shared.has(tab.id)) await unshare(tab.id);
  else await share(tab.id, { mode: prefs.mode, minutes: prefs.minutes });
}

browser.menus.create({ id: "tabshare-toggle", title: "Share tab with agent", contexts: ["tab"] });
browser.menus.onShown.addListener((info, tab) => {
  if (!tab || !info.menuIds.includes("tabshare-toggle")) return;
  const title = shared.has(tab.id)
    ? "Stop sharing tab with agent"
    : `Share tab with agent (${prefs.mode === "control" ? "full control" : "view only"}, ${
        prefs.minutes > 0 ? `${prefs.minutes} min` : "until stopped"
      })`;
  browser.menus.update("tabshare-toggle", { title });
  browser.menus.refresh();
});
browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "tabshare-toggle" && tab) toggle(tab);
});

browser.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-share") return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab) toggle(tab);
});

"use strict";

const $ = (id) => document.getElementById(id);
let currentTab = null;
let formInitialised = false;

const send = (op, extra = {}) =>
  browser.runtime.sendMessage({ target: "bg", op, tabId: currentTab.id, ...extra });

function timeLeft(expiresAt) {
  if (!expiresAt) return "until stopped";
  const min = Math.max(0, Math.ceil((expiresAt - Date.now()) / 60000));
  return `${min} min left`;
}

function render(state) {
  const mine = state.tabs.find((t) => t.tabId === currentTab.id);

  $("conn").textContent = !state.hostConnected
    ? ""
    : state.agentCount > 0 ? `● ${state.agentCount} agent(s) connected` : "○ no agent connected";
  $("conn").classList.toggle("ok", state.agentCount > 0);

  $("error").hidden = !state.hostError;
  if (state.hostError) {
    $("error").textContent =
      `Cannot reach the native host: ${state.hostError} — run “node scripts/install-native-host.js” once.`;
  }

  $("tabTitle").textContent = currentTab.title;
  $("shareForm").hidden = !!mine;
  $("sharedBox").hidden = !mine;

  if (!formInitialised) {
    formInitialised = true;
    document.querySelector(`input[name=mode][value=${state.prefs.mode}]`).checked = true;
    $("minutes").value = String(state.prefs.minutes);
    $("groupPref").checked = state.prefs.group;
  }

  if (mine) {
    $("sharedInfo").textContent =
      `● Shared — ${mine.mode === "control" ? "full control" : "view only"}, ${timeLeft(mine.expiresAt)}`;
    const log = $("log");
    log.textContent = "";
    for (const entry of (mine.log || []).slice().reverse()) {
      const li = document.createElement("li");
      li.textContent = `${new Date(entry.t).toLocaleTimeString()}  ${entry.method} ${entry.detail}`;
      log.append(li);
    }
    if (!log.children.length) log.append(Object.assign(document.createElement("li"), { textContent: "nothing yet" }));
  }

  $("others").hidden = state.tabs.length === 0;
  const list = $("sharedList");
  list.textContent = "";
  for (const t of state.tabs) {
    const li = document.createElement("li");
    const title = Object.assign(document.createElement("span"), { className: "t", textContent: t.title, title: "Switch to tab" });
    title.addEventListener("click", () => browser.tabs.update(t.tabId, { active: true }));
    const left = Object.assign(document.createElement("span"), { textContent: timeLeft(t.expiresAt) });
    const stop = Object.assign(document.createElement("button"), { textContent: "Stop" });
    stop.addEventListener("click", async () => render(await send("unshare", { tabId: t.tabId })));
    li.append(title, left, stop);
    list.append(li);
  }
}

async function refresh() {
  render(await send("state"));
}

async function init() {
  [currentTab] = await browser.tabs.query({ active: true, currentWindow: true });

  $("shareBtn").addEventListener("click", async () => {
    render(await send("share", {
      mode: document.querySelector("input[name=mode]:checked").value,
      minutes: Number($("minutes").value),
      note: $("note").value,
    }));
    // The native host connects asynchronously; pick up errors / status.
    setTimeout(refresh, 600);
  });
  $("stopBtn").addEventListener("click", async () => render(await send("unshare")));
  $("stopAllBtn").addEventListener("click", async () => render(await send("unshareAll")));
  $("groupPref").addEventListener("change", (e) => send("setGroupPref", { value: e.target.checked }));

  await refresh();
  setInterval(refresh, 2000);
}

init();

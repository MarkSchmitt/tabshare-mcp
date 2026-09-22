"use strict";

// In-page "this tab is shared" indicator: a coloured frame around the viewport
// and a pill with a countdown and a Stop button. Lives in a closed shadow root
// so page styles cannot restyle or hide it by accident.

(() => {
  if (globalThis.__tabshareOverlay) return;
  globalThis.__tabshareOverlay = true;

  let host = null;
  let pill = null;
  let label = null;
  let activity = null;
  let ticker = null;
  let activityTimer = null;
  let state = { mode: "control", expiresAt: null };

  const CSS = `
    :host { all: initial; }
    .frame {
      position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;
      border: 4px solid #e22850; box-sizing: border-box;
      box-shadow: inset 0 0 12px rgba(226, 40, 80, .55);
    }
    .frame.read { border-color: #b85c00; box-shadow: inset 0 0 12px rgba(184, 92, 0, .55); }
    .pill {
      position: fixed; top: 0; left: 50%; transform: translateX(-50%);
      z-index: 2147483647; display: flex; align-items: center; gap: 8px;
      padding: 3px 6px 4px 12px; border-radius: 0 0 10px 10px;
      background: #e22850; color: #fff; font: 600 12px/1.4 system-ui, sans-serif;
      box-shadow: 0 2px 8px rgba(0, 0, 0, .35); white-space: nowrap; user-select: none;
    }
    .pill.read { background: #b85c00; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #fff; animation: pulse 1.6s infinite; }
    @keyframes pulse { 50% { opacity: .25; } }
    .activity { font-weight: 400; opacity: .9; }
    button {
      all: unset; cursor: pointer; padding: 1px 9px; border-radius: 7px;
      background: rgba(255, 255, 255, .22); font: inherit;
    }
    button:hover { background: rgba(255, 255, 255, .4); }
    .hidden { display: none; }
  `;

  function build() {
    host = document.createElement("div");
    host.setAttribute("data-tabshare-overlay", "");
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CSS;
    const frame = document.createElement("div");
    frame.className = "frame";
    pill = document.createElement("div");
    pill.className = "pill";
    const dot = document.createElement("span");
    dot.className = "dot";
    label = document.createElement("span");
    activity = document.createElement("span");
    activity.className = "activity";
    const stop = document.createElement("button");
    stop.textContent = "Stop sharing";
    stop.addEventListener("click", () => browser.runtime.sendMessage({ target: "bg", op: "unshare" }));
    pill.append(dot, label, activity, stop);
    root.append(style, frame, pill);
    host._frame = frame;
  }

  function render() {
    if (!host) build();
    if (!host.isConnected) (document.documentElement || document).appendChild(host);
    const read = state.mode === "read";
    host._frame.classList.toggle("read", read);
    pill.classList.toggle("read", read);
    let text = read ? "Shared with AI agent (view only)" : "AI agent controls this tab";
    if (state.expiresAt) {
      const s = Math.max(0, Math.round((state.expiresAt - Date.now()) / 1000));
      text += ` · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }
    label.textContent = text;
  }

  function remove() {
    clearInterval(ticker);
    ticker = null;
    if (host) host.remove();
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.target !== "overlay") return undefined;
    switch (msg.op) {
      case "show":
        state = { mode: msg.mode, expiresAt: msg.expiresAt };
        render();
        clearInterval(ticker);
        ticker = setInterval(render, 1000);
        break;
      case "remove":
        remove();
        break;
      case "hide":
        // Used around screenshots; resolve only once the change is painted.
        if (host) host.style.display = "none";
        // rAF never fires in background tabs, hence the timeout fallback.
        return new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
          setTimeout(() => resolve(true), 200);
        });
      case "unhide":
        if (host) host.style.display = "";
        break;
      case "activity":
        if (!activity) break;
        activity.textContent = `· ${msg.text}`;
        clearTimeout(activityTimer);
        activityTimer = setTimeout(() => { activity.textContent = ""; }, 2500);
        break;
    }
    return Promise.resolve(true);
  });
})();

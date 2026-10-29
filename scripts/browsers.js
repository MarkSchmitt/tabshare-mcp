"use strict";

// Where the Firefox-family browsers look for native messaging host manifests,
// per user. Shared by the installer and the doctor.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const home = os.homedir();
const mac = process.platform === "darwin";
const win = process.platform === "win32";
const appSupport = path.join(home, "Library/Application Support");
const appData = process.env.APPDATA || path.join(home, "AppData/Roaming");
const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData/Local");

const dataDir = win
  ? path.join(localAppData, "tabshare-mcp")
  : path.join(process.env.XDG_DATA_HOME || path.join(home, ".local/share"), "tabshare-mcp");

// profileDir: exists once the browser has been started at least once.
// hostDir:    where the manifest goes.
// regKeys:    Windows only — HKCU keys whose default value points at the
//             manifest. Firefox reads Software\Mozilla; forks are registered
//             under their own vendor key as well, as they are on Linux/macOS.
const BROWSERS = win
  ? {
      firefox: { label: "Firefox", profileDir: path.join(appData, "Mozilla/Firefox"), hostDir: dataDir, regKeys: ["Software\\Mozilla\\NativeMessagingHosts"] },
      librewolf: { label: "LibreWolf", profileDir: path.join(appData, "librewolf"), hostDir: dataDir, regKeys: ["Software\\LibreWolf\\NativeMessagingHosts", "Software\\Mozilla\\NativeMessagingHosts"] },
      waterfox: { label: "Waterfox", profileDir: path.join(appData, "Waterfox"), hostDir: dataDir, regKeys: ["Software\\Waterfox\\NativeMessagingHosts", "Software\\Mozilla\\NativeMessagingHosts"] },
    }
  : mac
  ? {
      firefox: { label: "Firefox", profileDir: path.join(appSupport, "Firefox"), hostDir: path.join(appSupport, "Mozilla/NativeMessagingHosts") },
      librewolf: { label: "LibreWolf", profileDir: path.join(appSupport, "LibreWolf"), hostDir: path.join(appSupport, "LibreWolf/NativeMessagingHosts") },
      waterfox: { label: "Waterfox", profileDir: path.join(appSupport, "Waterfox"), hostDir: path.join(appSupport, "Waterfox/NativeMessagingHosts") },
    }
  : {
      firefox: { label: "Firefox", profileDir: path.join(home, ".mozilla"), hostDir: path.join(home, ".mozilla/native-messaging-hosts") },
      librewolf: { label: "LibreWolf", profileDir: path.join(home, ".librewolf"), hostDir: path.join(home, ".librewolf/native-messaging-hosts") },
      waterfox: { label: "Waterfox", profileDir: path.join(home, ".waterfox"), hostDir: path.join(home, ".waterfox/native-messaging-hosts") },
    };

// Sandboxed packages cannot run a host from the user's home: there is no node
// inside the sandbox and the unix socket would live in a different namespace.
const SANDBOXED = mac || win ? [] : [
  { label: "Flatpak Firefox", dir: path.join(home, ".var/app/org.mozilla.firefox") },
  { label: "Snap Firefox", dir: path.join(home, "snap/firefox") },
];

// Windows registry access through reg.exe, so the installer stays free of
// native modules. Values are the default (unnamed) value of HKCU\<key>\<name>.
const reg = (...args) => execFileSync("reg.exe", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
const registry = {
  get(key) {
    try {
      const m = /REG_SZ\s+(.*?)\s*$/m.exec(reg("query", `HKCU\\${key}`, "/ve"));
      return m ? m[1] : null;
    } catch (_) {
      return null; // key does not exist
    }
  },
  set(key, value) { reg("add", `HKCU\\${key}`, "/ve", "/t", "REG_SZ", "/d", value, "/f"); },
  delete(key) {
    try { reg("delete", `HKCU\\${key}`, "/f"); return true; } catch (_) { return false; }
  },
};

module.exports = {
  HOST_NAME: "tabshare_mcp",
  BROWSERS,
  SANDBOXED,
  WINDOWS: win,
  dataDir,
  hostCopyDir: path.join(dataDir, "host"),
  launcher: path.join(dataDir, win ? "native-host.bat" : "native-host.sh"),
  stateFile: path.join(dataDir, "install.json"),
  registry,
  detected: () => Object.entries(BROWSERS).filter(([, b]) => fs.existsSync(b.profileDir)).map(([k]) => k),
  sandboxed: () => SANDBOXED.filter((s) => fs.existsSync(s.dir)),
};

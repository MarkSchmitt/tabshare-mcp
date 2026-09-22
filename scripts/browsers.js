"use strict";

// Where the Firefox-family browsers look for native messaging host manifests,
// per user. Shared by the installer and the doctor.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const home = os.homedir();
const mac = process.platform === "darwin";
const appSupport = path.join(home, "Library/Application Support");

// profileDir: exists once the browser has been started at least once.
// hostDir:    where the manifest goes.
const BROWSERS = mac
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
const SANDBOXED = mac ? [] : [
  { label: "Flatpak Firefox", dir: path.join(home, ".var/app/org.mozilla.firefox") },
  { label: "Snap Firefox", dir: path.join(home, "snap/firefox") },
];

const dataDir = path.join(process.env.XDG_DATA_HOME || path.join(home, ".local/share"), "tabshare-mcp");

module.exports = {
  HOST_NAME: "tabshare_mcp",
  BROWSERS,
  SANDBOXED,
  dataDir,
  hostCopyDir: path.join(dataDir, "host"),
  launcher: path.join(dataDir, "native-host.sh"),
  stateFile: path.join(dataDir, "install.json"),
  detected: () => Object.entries(BROWSERS).filter(([, b]) => fs.existsSync(b.profileDir)).map(([k]) => k),
  sandboxed: () => SANDBOXED.filter((s) => fs.existsSync(s.dir)),
};

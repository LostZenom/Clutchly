/**
 * Settings store for the Clutchly desktop overlay.
 *
 * State that only concerns the Electron window (toggle hotkey, click-through
 * mode on launch, overlay URL) lives in a JSON file under the user's home dir
 * (`~/.clutchly-overlay/settings.json`) — not the volatile temp dir.
 *
 * Steam-facing values (Web API key, GC account/password/2FA, tracked Steam64)
 * are mirrored into the project's `.env` so the Next server and the live feed
 * (`npm run feed`) pick them up on next start.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULTS = {
  hotkey: "CommandOrControl+Shift+O",
  settingsHotkey: "CommandOrControl+Shift+S",
  interactiveOnLaunch: true,
  // The port the built-in web/app server listens on. The overlay app boots the
  // site itself on this port and shuts it down on quit.
  serverPort: 3100,
  overlayUrl: process.env.OVERLAY_URL || "http://localhost:53179/overlay",
  // Set to true once the user has picked a port on first run.
  onboarded: false,
  steam: {
    apiKey: "",
    gcAccount: "",
    gcPassword: "",
    gcGuardCode: "",
    gc2faCode: "",
    trackedSteam64: "",
    refreshToken: "",
  },
};

function settingsFilePath() {
  const dir = path.join(os.homedir(), ".clutchly-overlay");
  return path.join(dir, "settings.json");
}

function ensureFile() {
  const file = settingsFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(DEFAULTS, null, 2), "utf8");
  }
  return file;
}

function loadSettings() {
  try {
    ensureFile();
    const raw = fs.readFileSync(settingsFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed, steam: { ...DEFAULTS.steam, ...(parsed.steam || {}) } };
  } catch {
    return { ...DEFAULTS, steam: { ...DEFAULTS.steam } };
  }
}

function saveSettings(patch) {
  const current = loadSettings();
  const next = {
    ...current,
    ...(patch.hotkey !== undefined ? { hotkey: patch.hotkey } : {}),
    ...(patch.settingsHotkey !== undefined ? { settingsHotkey: patch.settingsHotkey } : {}),
    ...(patch.interactiveOnLaunch !== undefined ? { interactiveOnLaunch: patch.interactiveOnLaunch } : {}),
    ...(patch.serverPort !== undefined ? { serverPort: patch.serverPort } : {}),
    ...(patch.onboarded !== undefined ? { onboarded: patch.onboarded } : {}),
    ...(patch.overlayUrl !== undefined ? { overlayUrl: patch.overlayUrl } : {}),
    steam: { ...current.steam, ...(patch.steam || {}) },
  };
  ensureFile();
  fs.writeFileSync(settingsFilePath(), JSON.stringify(next, null, 2), "utf8");
  // If any Steam field was provided, mirror the relevant values into .env.
  if (patch.steam) writeEnv(next.steam);
  return next;
}

/**
 * Idempotently set / replace the Steam-related keys in the project `.env`
 * (column keys already present; appends anything new). Never touches other keys.
 */
function envPath() {
  return path.join(__dirname, "..", ".env");
}

function writeEnv(steam) {
  const file = envPath();
  let lines = [];
  if (fs.existsSync(file)) {
    lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  }
  const map = {
    STEAM_API_KEY: steam.apiKey,
    STEAM_GC_ACCOUNT_NAME: steam.gcAccount,
    STEAM_GC_PASSWORD: steam.gcPassword,
    STEAM_GC_GUARD_CODE: steam.gcGuardCode,
    STEAM_GC_2FA_CODE: steam.gc2faCode,
    STEAM_GC_REFRESH_TOKEN: steam.refreshToken,
    OVERLAY_TRACK_STEAM64: steam.trackedSteam64,
  };
  const written = new Set();
  const out = lines.map((line) => {
    for (const [key, value] of Object.entries(map)) {
      if (new RegExp(`^\\s*${key}\\s*=`).test(line)) {
        written.add(key);
        return `${key}="${String(value ?? "")}"`;
      }
    }
    return line;
  });
  for (const [key, value] of Object.entries(map)) {
    if (!written.has(key)) out.push(`${key}="${String(value ?? "")}"`);
  }
  try {
    fs.writeFileSync(file, out.join("\n").replace(/\n+/g, "\n") + "\n", "utf8");
  } catch (err) {
    console.error("[overlay] could not write .env:", err && err.message);
  }
}

module.exports = { loadSettings, saveSettings, DEFAULTS, settingsFilePath };
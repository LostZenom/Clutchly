const path = require("path");
const os = require("os");
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
  shell,
  screen,
  ipcMain,
} = require("electron");
const { loadSettings, saveSettings, DEFAULTS } = require("./settings.cjs");
const { createServerManager, normalizePort } = require("./serverManager.cjs");
const { setupAutoUpdate } = require("./updater.cjs");
const { showServerPopup, broadcastLog } = require("./serverPopup.cjs");

const TOGGLE_ACCEL_DEFAULT = DEFAULTS.hotkey;

// The overlay app boots the website itself on a local port (see settings.serverPort)
// and shuts it down on quit — no need to run the site separately.
const PROJECT_ROOT = app.isPackaged ? app.getAppPath() : path.join(__dirname, "..");
const server = createServerManager({
  projectRoot: PROJECT_ROOT,
  // Mirror every boot line to a log file too, so a failure can always be
  // inspected even if the popup misses it.
  logFile: path.join(os.tmpdir(), "clutchly-overlay", "server.log"),
  // Pipe each boot/log line into the popup's bottom debug console as it happens.
  onLog: (line) => {
    console.log(`[site] ${line}`);
    broadcastLog(line);
  },
  // When auto-fallback picks a new port mid-boot, surface it in the popup.
  onAttempt: (port) => showServerPopup("starting", { port }),
});
const updater = setupAutoUpdate();

// Keep Electron's disk cache off OneDrive/odd profile dirs on a per-machine path.
app.setPath("userData", path.join(os.tmpdir(), "clutchly-overlay"));

let win = null;
let settingsWin = null;
let tray = null;
let quitting = false;
let interactive = true; // current mode: true = fully interactive
let lastHotkey = TOGGLE_ACCEL_DEFAULT;
let lastSettingsHotkey = "CommandOrControl+Shift+S";

function overlayUrl() {
  // Prefer the self-hosted site we booted; fall back to a configured external one.
  const live = server.currentUrl();
  if (live) return `${live}/overlay`;
  const s = loadSettings();
  return s.overlayUrl || process.env.OVERLAY_URL || DEFAULTS.overlayUrl;
}

function createWindow() {
  const primary = screen.getPrimaryDisplay().workArea;
  const w = Math.min(920, primary.width - 40);
  const settings = loadSettings();

  interactive = settings.interactiveOnLaunch !== false;

  win = new BrowserWindow({
    width: w,
    height: 448,
    x: primary.x + Math.round((primary.width - w) / 2),
    y: primary.y + 8,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    fullscreenable: false,
    maximizable: false,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setAlwaysOnTop(true, "screen-saver", 1);

  win.loadURL(overlayUrl()).catch((err) => {
    if (!quitting) console.error(`[overlay] could not load ${overlayUrl()}:`, err && err.message);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  win.once("ready-to-show", () => {
    win.showInactive();
    applyInteractive(interactive);
    notify(interactive);
  });

  win.on("closed", () => {
    win = null;
  });
}

/** Switch mouse handling and let the renderer know the new mode. */
function applyInteractive(value, notifyRenderer = false) {
  interactive = !!value;
  if (win) {
    win.setIgnoreMouseEvents(!interactive, { forward: true });
    if (notifyRenderer) notify(interactive);
  }
}

function notify(value) {
  if (win && !win.isDestroyed()) {
    win.webContents.send("overlay:mode", { interactive: !!value });
  }
}

function toggleInteractive() {
  applyInteractive(!interactive, true);
  return interactive;
}

/**
 * Dedicated, always-interactive settings window (independent of overlay mode).
 * Opened by the settings hotkey, the tray menu, and the overlay's gear button.
 * Always centered on the display under the cursor.
 */
function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.showInactive();
    settingsWin.center();
    return;
  }
  // Use the display the user is actually on (game monitor), not just the primary.
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = display.workArea;
  const w = 480;
  const h = Math.min(740, wa.height - 80);
  settingsWin = new BrowserWindow({
    width: w,
    height: h,
    x: wa.x + Math.round((wa.width - w) / 2),
    y: wa.y + Math.round((wa.height - h) / 2),
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWin.setAlwaysOnTop(true, "screen-saver", 1);
  // Center again once it actually has its final size — belt and suspenders.
  settingsWin.once("ready-to-show", () => {
    settingsWin.center();
    settingsWin.showInactive();
  });
  settingsWin.loadURL(`${overlayUrl()}?settings=1`).catch((err) => {
    if (!quitting) console.error(`[overlay] could not load settings window:`, err && err.message);
  });
  settingsWin.on("closed", () => {
    settingsWin = null;
  });
}

function registerHotkeys(settings) {
  globalShortcut.unregisterAll();
  const toggle = settings.hotkey || TOGGLE_ACCEL_DEFAULT;
  const openSettings = settings.settingsHotkey || "CommandOrControl+Shift+S";
  if (!globalShortcut.register(toggle, toggleInteractive)) {
    console.warn(`[overlay] could not register hotkey ${toggle}`);
  }
  if (!globalShortcut.register(openSettings, openSettingsWindow)) {
    console.warn(`[overlay] could not register settings hotkey ${openSettings}`);
  }
  lastHotkey = toggle;
  lastSettingsHotkey = openSettings;
}

function createTray() {
  const iconPath = path.join(__dirname, "..", "public", "clutchly-logo.png");
  const image = nativeImage.createFromPath(iconPath);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 }));
  tray.setToolTip("Clutchly Overlay");

  const menu = Menu.buildFromTemplate([
    { label: "Toggle overlay interactivity", click: toggleInteractive },
    { label: "Settings…", click: openSettingsWindow },
    { type: "separator" },
    {
      label: "Check for updates…",
      click: () => updater.check(true).catch(() => {}),
    },
    { label: "Reload overlay", click: () => win && win.webContents.reload() },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", toggleInteractive);
}

/**
 * Restart the built-in site on the given port, keeping every window and the
 * server popup in sync. Used by Settings (port change) and the popup's
 * "try another port" field.
 */
async function restartSiteOnPort(rawPort) {
  const p = normalizePort(rawPort);
  showServerPopup("starting", { port: p });
  try {
    const url = await server.restartServer(p);
    const port = server.getPort();
    showServerPopup("ok", { port, url: `${url}/` });
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) {
        w.loadURL(w === settingsWin ? `${overlayUrl()}?settings=1` : overlayUrl()).catch(() => {});
      }
    }
    return { ok: true, port, url };
  } catch (e) {
    console.error("[overlay] could not restart site:", e && e.message);
    const message = (e && e.message) || "The website could not start on that port.";
    showServerPopup("error", { port: p, message });
    return { ok: false, message };
  }
}

// ------------------------------------------------------------------ IPC
function registerIpc() {
  ipcMain.handle("overlay:get-settings", () => loadSettings());
  ipcMain.handle("overlay:save-settings", async (_e, patch) => {
    const prev = loadSettings();
    const saved = saveSettings(patch || {});
    applyInteractive(saved.interactiveOnLaunch !== false, true);
    registerHotkeys(saved);
    // A port change restarts the self-hosted site on that port, then every
    // window is reloaded onto the new URL.
    let needsRestart = !!(patch && patch.steam);
    if (
      patch &&
      patch.serverPort !== undefined &&
      normalizePort(patch.serverPort) !== normalizePort(prev.serverPort)
    ) {
      needsRestart = true;
      await restartSiteOnPort(patch.serverPort);
    }
    // Keep every window (main overlay + settings) in sync instantly.
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send("overlay:settings-changed", saved);
    }
    // .env was mirrored by settings.cjs when steam fields were provided.
    return { ok: true, settings: saved, needsRestart, needsPortRestart: needsRestart && !!patch?.serverPort };
  });
  ipcMain.handle("overlay:set-interactive", (_e, value) => {
    applyInteractive(!!value, true);
    return { interactive: !!value };
  });
  ipcMain.handle("overlay:open-settings", () => {
    openSettingsWindow();
    return { ok: true };
  });
  // From the server popup's "try another port" field — restart the site on a
  // new port without having to open Settings.
  ipcMain.handle("serverpopup:try-port", (_e, rawPort) => restartSiteOnPort(rawPort));
}

// ------------------------------------------------------------------ lifecycle
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => toggleInteractive());

  app.whenReady().then(async () => {
    registerIpc();
    // Boot the website on the configured port (best-effort). If it can't start
    // (e.g. another app owns the port), the overlay falls back to the external URL.
    const port = normalizePort((loadSettings().serverPort) ?? DEFAULTS.serverPort);
    // The server popup is the first thing you see — it reports the boot live.
    showServerPopup("starting", { port });
    try {
      const url = await server.ensureServer(port);
      showServerPopup("ok", { port: server.getPort(), url: `${url}/` });
    } catch (e) {
      console.error(`[overlay] could not boot the site on ${port}:`, e && e.message);
      showServerPopup("error", {
        port,
        message: (e && e.message) || "The website could not start on this port.",
      });
    }
    createWindow();
    createTray();
    registerHotkeys(loadSettings());
    // Check for a new release (popup with progress bar appears if one ships).
    updater.check().catch(() => {});

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("will-quit", () => { globalShortcut.unregisterAll(); server.stopServer(); });
app.on("before-quit", () => {
  quitting = true;
});

// Keep alive in the tray after the window is closed (Quit lives in the tray).
app.on("window-all-closed", () => {
  /* stays alive in tray until Quit */
});
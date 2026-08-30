/**
 * Auto-update manager for the Clutchly overlay.
 *
 * Uses electron-updater wired to the GitHub Releases feed baked into the build
 * (see electron-builder.yml `publish`). On launch (and from the tray) it checks
 * for a newer release; when one is found it opens a small transparent popup with
 * a live progress bar, downloads the new installer, and offers "Restart now" to
 * install. Updates ship to everyone automatically once a new GitHub release is
 * published.
 */
const path = require("path");
const { app, ipcMain, screen, BrowserWindow } = require("electron");

let updateWin = null;
let readyChannels = [];

// Only require the updater when packaged (no-op in dev).
function requireUpdater() {
  try {
    // eslint-disable-next-line global-require
    return require("electron-updater").autoUpdater;
  } catch (e) {
    console.error("[updater] electron-updater unavailable:", e && e.message);
    return null;
  }
}

function broadcast(payload) {
  if (updateWin && !updateWin.isDestroyed()) {
    updateWin.webContents.send("updater:state", payload);
  }
}

function closeUpdateWindow() {
  if (updateWin && !updateWin.isDestroyed()) {
    updateWin.close();
  }
}

function showUpdateWindow() {
  if (updateWin && !updateWin.isDestroyed()) {
    updateWin.show();
    updateWin.focus();
    return;
  }
  const wa = screen.getPrimaryDisplay().workArea;
  const w = 440;
  const h = 268;
  updateWin = new BrowserWindow({
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
      preload: path.join(__dirname, "update-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  updateWin.setAlwaysOnTop(true, "screen-saver", 1);
  updateWin.loadFile(path.join(__dirname, "update-window.html")).catch((e) => {
    console.error("[updater] could not load update window:", e && e.message);
  });
  updateWin.once("ready-to-show", () => {
    updateWin.center();
    updateWin.show();
  });
  updateWin.on("closed", () => {
    updateWin = null;
  });
}

function registerUpdaterIpc() {
  ipcMain.removeHandler("updater:install");
  ipcMain.removeHandler("updater:close");
  ipcMain.handle("updater:install", () => {
    const autoUpdater = requireUpdater();
    closeUpdateWindow();
    if (autoUpdater) {
      setImmediate(() => autoUpdater.quitAndInstall(false, true));
    } else {
      app.quit();
    }
    return { ok: true };
  });
  ipcMain.handle("updater:close", () => {
    closeUpdateWindow();
    return { ok: true };
  });
}

/**
 * Initialize auto-updates. Safe to call in dev (resolves to a no-op).
 * Returns { check: () => Promise<void> } for manual tray-triggered checks.
 */
function setupAutoUpdate() {
  if (!app.isPackaged) {
    console.log("[updater] disabled in development (only packaged builds auto-update).");
    return { check: async () => {} };
  }
  const autoUpdater = requireUpdater();
  if (!autoUpdater) return { check: async () => {} };

  registerUpdaterIpc();

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on("checking-for-update", () => broadcast({ status: "checking" }));
  autoUpdater.on("update-available", (info) => broadcast({ status: "available", version: info && info.version }));
  autoUpdater.on("update-not-available", () => broadcast({ status: "none" }));
  autoUpdater.on("download-progress", (p) => {
    broadcast({
      status: "downloading",
      percent: Math.max(0, Math.min(100, Math.round((p && p.percent) || 0))),
      transferred: p && p.transferred,
      total: p && p.total,
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    broadcast({ status: "downloaded", version: info && info.version });
  });
  autoUpdater.on("error", (e) => {
    console.error("[updater] error:", e && (e.message || e));
    broadcast({ status: "error", message: (e && e.message) || "Update check failed." });
  });

  return {
    check: async () => {
      try {
        await autoUpdater.checkForUpdates();
      } catch (e) {
        broadcast({ status: "error", message: (e && e.message) || "Update check failed." });
      }
    },
  };
}

module.exports = { setupAutoUpdate, showUpdateWindow, closeUpdateWindow };
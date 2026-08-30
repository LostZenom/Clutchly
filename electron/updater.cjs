/**
 * Auto-update manager for the Clutchly overlay.
 *
 * Uses electron-updater wired to the GitHub Releases feed baked into the build
 * (see scripts/release.mjs). On launch it silently checks for a newer release;
 * on a tray "Check for updates…" it opens the popup immediately. Whenever an
 * update is available or downloading, a small transparent toast appears in the
 * bottom-right corner with a live progress bar and a "Restart now" action.
 */
const path = require("path");
const { app, ipcMain, screen, BrowserWindow } = require("electron");

let updateWin = null;
let closeTimer = null;

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

function scheduleClose(ms) {
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    closeUpdateWindow();
    closeTimer = null;
  }, ms);
}

function closeUpdateWindow() {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  if (updateWin && !updateWin.isDestroyed()) {
    updateWin.close();
  }
}

/** Small transparent toast pinned to the bottom-right of the screen. */
function showUpdateWindow() {
  if (updateWin && !updateWin.isDestroyed()) {
    updateWin.show();
    return;
  }
  const wa = screen.getPrimaryDisplay().workArea;
  const w = 404;
  const h = 236;
  updateWin = new BrowserWindow({
    width: w,
    height: h,
    x: wa.x + wa.width - w - 16,
    y: wa.y + wa.height - h - 16,
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
  updateWin.once("ready-to-show", () => updateWin.showInactive());
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
 * Initialize auto-updates. Safe to call in dev (no-op).
 * Returns { check: (immediate?: boolean) => Promise<void> } — pass true from the
 * tray so the toast appears even while it's just checking.
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
  autoUpdater.on("update-available", (info) => {
    showUpdateWindow();
    broadcast({ status: "available", version: info && info.version });
  });
  autoUpdater.on("update-not-available", () => {
    broadcast({ status: "none" });
    scheduleClose(2600);
  });
  autoUpdater.on("download-progress", (p) => {
    showUpdateWindow();
    broadcast({
      status: "downloading",
      percent: Math.max(0, Math.min(100, Math.round((p && p.percent) || 0))),
      transferred: p && p.transferred,
      total: p && p.total,
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    showUpdateWindow();
    broadcast({ status: "downloaded", version: info && info.version });
  });
  autoUpdater.on("error", (e) => {
    console.error("[updater] error:", e && (e.message || e));
    broadcast({ status: "error", message: (e && e.message) || "Update check failed." });
  });

  return {
    check: async (immediate = false) => {
      if (immediate) showUpdateWindow();
      try {
        await autoUpdater.checkForUpdates();
      } catch (e) {
        broadcast({ status: "error", message: (e && e.message) || "Update check failed." });
      }
    },
  };
}

module.exports = { setupAutoUpdate, showUpdateWindow, closeUpdateWindow };
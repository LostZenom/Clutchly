/**
 * Auto-update manager for the Clutchly overlay.
 *
 * Checks GitHub Releases for newer builds (baked feed from app-update.yml),
 * shows a transparent bottom-right toast with a live progress bar while
 * downloading, fires a native "new update available" notification, and lets the
 * user roll back to any previous release from the same popup.
 */
const fs = require("fs");
const path = require("path");
const { app, ipcMain, screen, BrowserWindow, Notification, shell } = require("electron");

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

/** The GitHub repo this build was published from (read from app-update.yml). */
function feedRepo() {
  try {
    const p = path.join(process.resourcesPath || "", "app-update.yml");
    const txt = fs.readFileSync(p, "utf8");
    const owner = (txt.match(/^owner:\s*(\S+)/m) || [])[1];
    const repo = (txt.match(/^repo:\s*(\S+)/m) || [])[1];
    if (owner && repo) return `${owner}/${repo}`;
  } catch {
    /* not packaged / missing feed */
  }
  return null;
}

/** Fetch published releases (public API — no token needed for public repos). */
async function fetchVersions() {
  const repo = feedRepo();
  if (!repo) return [];
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=12`);
    if (!res.ok) return [];
    const list = (await res.json()) || [];
    return (Array.isArray(list) ? list : [])
      .filter((r) => !r.draft && r.tag_name)
      .map((r) => {
        const exe = (r.assets || []).find((a) => a.name.endsWith(".exe")) || {};
        return {
          version: String(r.tag_name).replace(/^v/, ""),
          publishedAt: r.published_at || null,
          assetUrl: exe.browser_download_url || null,
          size: exe.size || 0,
        };
      });
  } catch {
    return [];
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
  const h = 264;
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
  ipcMain.removeHandler("updater:get-current-version");
  ipcMain.removeHandler("updater:get-versions");
  ipcMain.removeHandler("updater:install-version");
  ipcMain.removeHandler("updater:set-size");

  // Grow/shrink the toast while staying pinned bottom-right (the picker needs
  // more room when it expands).
  ipcMain.handle("updater:set-size", (_e, w, h) => {
    if (!updateWin || updateWin.isDestroyed()) return { ok: false };
    const wa = screen.getPrimaryDisplay().workArea;
    const width = Math.max(320, Math.min(520, Number(w) || 404));
    const height = Math.max(200, Math.min(520, Number(h) || 264));
    updateWin.setBounds({
      width,
      height,
      x: wa.x + wa.width - width - 16,
      y: wa.y + wa.height - height - 16,
    });
    return { ok: true };
  });

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
  ipcMain.handle("updater:get-current-version", () => app.getVersion());
  ipcMain.handle("updater:get-versions", async () => {
    try {
      return { ok: true, versions: await fetchVersions() };
    } catch (e) {
      return { ok: false, message: (e && e.message) || "Could not load versions." };
    }
  });
  // Rollback: download the chosen release installer and launch it.
  ipcMain.handle("updater:install-version", async (_e, url) => {
    if (typeof url !== "string" || !/^https:\/\/github\.com\//.test(url)) {
      return { ok: false, message: "Invalid download link." };
    }
    try {
      const res = await fetch(url);
      if (!res.ok) return { ok: false, message: `Download failed (HTTP ${res.status}).` };
      const buf = Buffer.from(await res.arrayBuffer());
      const tmp = path.join(app.getPath("temp"), `clutchly-rollback-${Date.now()}.exe`);
      fs.writeFileSync(tmp, buf);
      const err = await shell.openPath(tmp);
      return err ? { ok: false, message: err } : { ok: true, path: tmp };
    } catch (e) {
      return { ok: false, message: (e && e.message) || "Could not install that version." };
    }
  });
}

/**
 * Initialize auto-updates. Safe to call in dev (no-op).
 * Returns { check: (immediate?: boolean) => Promise<void> }.
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
    // Native OS notification — tell the user a new build is out.
    if (Notification.isSupported()) {
      try {
        new Notification({
          title: "Clutchly — new update available",
          body: `v${info && info.version} is ready to install. It downloads in the background and installs automatically.`,
        }).show();
      } catch (e) {
        console.error("[updater] notification failed:", e && e.message);
      }
    }
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
    if (Notification.isSupported()) {
      try {
        new Notification({
          title: "Clutchly — update ready",
          body: `v${info && info.version} is downloaded. Restart Clutchly to finish the update.`,
        }).show();
      } catch (e) {
        console.error("[updater] notification failed:", e && e.message);
      }
    }
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
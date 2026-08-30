/**
 * Server-status popup for the Clutchly overlay.
 *
 * A small centered, frameless, transparent toast (same shimmer-card look as the
 * update popup) that tells the user the local website server started:
 *   - starting → spinner + server icon
 *   - ok       → green check + clickable http://127.0.0.1:<port>/ , auto-closes
 *   - error    → red X + the error message, stays open until manually closed
 */
const path = require("path");
const { BrowserWindow, screen, ipcMain, shell } = require("electron");

let popup = null;
let closeTimer = null;

function broadcast(payload) {
  if (popup && !popup.isDestroyed()) {
    popup.webContents.send("serverpopup:state", payload);
  }
}

function closePopup() {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  if (popup && !popup.isDestroyed()) {
    popup.close();
  }
}

function getOrCreate() {
  if (popup && !popup.isDestroyed()) {
    popup.showInactive();
    return popup;
  }
  const wa = screen.getPrimaryDisplay().workArea;
  const w = 340;
  const h = 180;
  popup = new BrowserWindow({
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
      preload: path.join(__dirname, "server-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  popup.setAlwaysOnTop(true, "screen-saver", 1);
  popup.once("ready-to-show", () => popup.showInactive());
  popup.loadFile(path.join(__dirname, "server-popup.html")).catch((e) => {
    console.error("[server-popup] could not load window:", e && e.message);
  });
  popup.on("closed", () => {
    popup = null;
  });
  return popup;
}

function registerIpc() {
  ipcMain.removeHandler("serverpopup:close");
  ipcMain.removeHandler("serverpopup:open-url");
  ipcMain.handle("serverpopup:close", () => {
    closePopup();
    return { ok: true };
  });
  ipcMain.handle("serverpopup:open-url", (_e, url) => {
    if (typeof url === "string" && /^https?:\/\//.test(url)) shell.openExternal(url);
    return { ok: true };
  });
}

/**
 * Show (or update) the server popup.
 * @param {"starting"|"ok"|"error"} status
 * @param {{ port?: number, url?: string, message?: string }} [data]
 */
function showServerPopup(status, data) {
  registerIpc();
  const win = getOrCreate();
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  broadcast({ status, ...(data || {}) });
  // Green check → close itself shortly after (the user asked for auto-close).
  if (status === "ok") {
    closeTimer = setTimeout(closePopup, 2200);
  }
  return win;
}

module.exports = { showServerPopup, closePopup };

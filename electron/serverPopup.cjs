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
let logBuffer = [];
const LOG_CAP = 80;

// Window sizes per status. Error/ok carry more content (message box, quick-open
// link, action button), so the popup grows to fit instead of clipping.
const SIZES = {
  starting: { w: 340, h: 250 },
  ok: { w: 360, h: 280 },
  error: { w: 440, h: 360 },
};

function broadcast(payload) {
  if (popup && !popup.isDestroyed()) {
    popup.webContents.send("serverpopup:state", payload);
  }
}

/** Keep a ring buffer of recent server activity for the bottom debug console. */
function broadcastLog(line) {
  if (!line) return;
  logBuffer.push(line);
  if (logBuffer.length > LOG_CAP) logBuffer.shift();
  if (popup && !popup.isDestroyed()) {
    popup.webContents.send("serverpopup:log", { line });
  }
}

function getLogs() {
  return [...logBuffer];
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

function getOrCreate(status) {
  if (popup && !popup.isDestroyed()) {
    popup.showInactive();
    sizeTo(popup, status);
    return popup;
  }
  const size = SIZES[status] || SIZES.starting;
  const wa = screen.getPrimaryDisplay().workArea;
  popup = new BrowserWindow({
    width: size.w,
    height: size.h,
    x: wa.x + Math.round((wa.width - size.w) / 2),
    y: wa.y + Math.round((wa.height - size.h) / 2),
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

/** Resize to the status-appropriate dimensions and keep it centered. */
function sizeTo(win, status) {
  const size = SIZES[status] || SIZES.starting;
  win.setSize(size.w, size.h);
  win.center();
}

function registerIpc() {
  for (const chan of ["serverpopup:close", "serverpopup:open-url", "serverpopup:get-logs"]) {
    ipcMain.removeHandler(chan);
  }
  ipcMain.handle("serverpopup:close", () => {
    closePopup();
    return { ok: true };
  });
  ipcMain.handle("serverpopup:open-url", (_e, url) => {
    if (typeof url === "string" && /^https?:\/\//.test(url)) shell.openExternal(url);
    return { ok: true };
  });
  ipcMain.handle("serverpopup:get-logs", () => getLogs());
}

/**
 * Show (or update) the server popup.
 * @param {"starting"|"ok"|"error"} status
 * @param {{ port?: number, url?: string, message?: string }} [data]
 */
function showServerPopup(status, data) {
  registerIpc();
  const win = getOrCreate(status);
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  broadcast({ status, ...(data || {}) });
  // Green check → close itself shortly after (the user asked for auto-close).
  if (status === "ok") {
    closeTimer = setTimeout(closePopup, 2400);
  }
  return win;
}

module.exports = { showServerPopup, closePopup, broadcastLog };

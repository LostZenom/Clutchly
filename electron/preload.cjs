const { contextBridge, ipcRenderer } = require("electron");

/**
 * Minimal, safe bridge for the overlay window. Exposes only what the settings
 * UI needs. `onModeChange` lets the page reflect the click-through state.
 */
contextBridge.exposeInMainWorld("overlay", {
  getSettings: () => ipcRenderer.invoke("overlay:get-settings"),
  saveSettings: (patch) => ipcRenderer.invoke("overlay:save-settings", patch),
  setInteractive: (value) => ipcRenderer.invoke("overlay:set-interactive", !!value),
  openSettings: () => ipcRenderer.invoke("overlay:open-settings"),
  onModeChange: (cb) => {
    const listener = (_e, data) => cb(data && data.interactive);
    ipcRenderer.on("overlay:mode", listener);
    return () => ipcRenderer.removeListener("overlay:mode", listener);
  },
  onSettingsChange: (cb) => {
    const listener = (_e, settings) => cb(settings);
    ipcRenderer.on("overlay:settings-changed", listener);
    return () => ipcRenderer.removeListener("overlay:settings-changed", listener);
  },
  isDesktop: true,
});
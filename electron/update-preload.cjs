const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("updater", {
  onState: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("updater:state", listener);
    return () => ipcRenderer.removeListener("updater:state", listener);
  },
  install: () => ipcRenderer.invoke("updater:install"),
  close: () => ipcRenderer.invoke("updater:close"),
  getCurrentVersion: () => ipcRenderer.invoke("updater:get-current-version"),
  getVersions: () => ipcRenderer.invoke("updater:get-versions"),
  installVersion: (url) => ipcRenderer.invoke("updater:install-version", url),
  setSize: (w, h) => ipcRenderer.invoke("updater:set-size", w, h),
});
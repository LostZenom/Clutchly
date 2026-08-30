const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("updater", {
  onState: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("updater:state", listener);
    return () => ipcRenderer.removeListener("updater:state", listener);
  },
  install: () => ipcRenderer.invoke("updater:install"),
  close: () => ipcRenderer.invoke("updater:close"),
});
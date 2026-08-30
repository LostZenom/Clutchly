const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("serverPopup", {
  onState: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("serverpopup:state", listener);
    return () => ipcRenderer.removeListener("serverpopup:state", listener);
  },
  close: () => ipcRenderer.invoke("serverpopup:close"),
  openUrl: (url) => ipcRenderer.invoke("serverpopup:open-url", url),
});

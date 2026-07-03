const { contextBridge, ipcRenderer } = require("electron");

const api = {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  onLog: (handler) => {
    const sub = (_event, entry) => handler(entry);
    ipcRenderer.on("gateway:log", sub);
    return () => ipcRenderer.removeListener("gateway:log", sub);
  },
  onUpdateAvailable: (handler) => {
    const sub = (_event, info) => handler(info);
    ipcRenderer.on("app:update-available", sub);
    return () => ipcRenderer.removeListener("app:update-available", sub);
  }
};

contextBridge.exposeInMainWorld("lls", api);

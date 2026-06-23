const { contextBridge, ipcRenderer } = require("electron");

const api = {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  onLog: (handler) => {
    const sub = (_event, entry) => handler(entry);
    ipcRenderer.on("gateway:log", sub);
    return () => ipcRenderer.removeListener("gateway:log", sub);
  }
};

contextBridge.exposeInMainWorld("lls", api);

// Bridge for the dashboard window: only these calls reach the desktop side.
const { contextBridge, ipcRenderer } = require("electron");

// Generated pages (mockups, builds) opened in their own window never get the bridge.
if (location.pathname.startsWith("/files/")) return;

const listen = (channel) => (cb) => {
  const h = (_e, v) => cb(v);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld("studioDesktop", {
  desktop: true,
  comms: {
    sync: () => ipcRenderer.invoke("comms:sync"),
    state: () => ipcRenderer.invoke("comms:state"),
    show: (id, bounds) => ipcRenderer.send("comms:show", { id, bounds }),
    bounds: (bounds) => ipcRenderer.send("comms:bounds", bounds),
    hide: () => ipcRenderer.send("comms:hide"),
    action: (id, action) => ipcRenderer.invoke("comms:action", { id, action }),
    onState: listen("comms:state"),
    onOpen: listen("comms:open"),
  },
  zoom: {
    get: () => ipcRenderer.invoke("zoom:get"),
    set: (z) => ipcRenderer.invoke("zoom:set", z),
    onChange: listen("zoom:changed"),
  },
  openExternal: (url) => ipcRenderer.send("open-external", url),
  cacheBrand: (b) => ipcRenderer.send("brand:cache", b),
});

// Runs inside each channel (WhatsApp Web, Gmail, …). It only replaces the page's Notification so
// messages show as Windows notifications that open the right chat when clicked. Nothing else.
const { contextBridge, ipcRenderer, webFrame } = require("electron");

contextBridge.exposeInMainWorld("__studioNotify", (nid, title, body) => ipcRenderer.send("channel:notify", { nid, title, body }));
ipcRenderer.on("channel:clicked", (_e, nid) => {
  void webFrame.executeJavaScript(`window.__studioNotes && window.__studioNotes.click(${JSON.stringify(nid)})`);
});

void webFrame.executeJavaScript(`(() => {
  if (!window.Notification || window.__studioNotes) return;
  const notes = new Map();
  let seq = 0;
  window.__studioNotes = { click: (nid) => { const n = notes.get(nid); if (n) { n.dispatchEvent(new Event("click")); if (typeof n.onclick === "function") n.onclick(new Event("click")); } } };
  class StudioNotification extends EventTarget {
    constructor(title, options = {}) {
      super();
      this.title = String(title);
      this.body = String(options.body || "");
      this.tag = String(options.tag || "");
      this.data = options.data;
      this.onclick = null; this.onclose = null; this.onshow = null; this.onerror = null;
      const nid = "n" + (++seq);
      notes.set(nid, this);
      if (notes.size > 50) notes.delete(notes.keys().next().value);
      window.__studioNotify(nid, this.title, this.body);
      setTimeout(() => { this.dispatchEvent(new Event("show")); if (typeof this.onshow === "function") this.onshow(new Event("show")); });
    }
    close() { this.dispatchEvent(new Event("close")); if (typeof this.onclose === "function") this.onclose(new Event("close")); }
    static get permission() { return "granted"; }
    static requestPermission(cb) { if (typeof cb === "function") cb("granted"); return Promise.resolve("granted"); }
  }
  StudioNotification.maxActions = 0;
  window.Notification = StudioNotification;
})()`);

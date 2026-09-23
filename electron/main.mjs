/**
 * Weborite Studio desktop app.
 *  - Runs the dashboard server (bundled to app-dist/server.mjs) in a background utility process.
 *  - Shows the dashboard in the main window.
 *  - Communication: each channel (WhatsApp Web, Gmail, Discord, …) is a real browser tab
 *    (WebContentsView) with its own persistent profile, laid over the dashboard where the
 *    Communication page reserves space. Sites that refuse to be framed work here because
 *    nothing is framed: each is a top-level page.
 */
import { app, BrowserWindow, Menu, Notification, Tray, WebContentsView, dialog, ipcMain, nativeImage, session, shell, utilityProcess } from "electron";
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { PNG } from "pngjs";

const HERE = import.meta.dirname;
const ROOT = join(HERE, "..");
const DEV = !app.isPackaged;
// From the project folder the desktop app shares ./data with `npm run dev`; installed, it keeps its own.
const DATA = DEV ? join(ROOT, "data") : join(app.getPath("userData"), "data");
const ICON = join(ROOT, "build", "icon.png");
// The whole app opens at 90% so it fits smaller screens; the floating control changes it and it's remembered.
const ZOOM = 0.9;
// Resolved when used: a copy run from the project folder switches to its own profile further down.
const prefsFile = () => join(app.getPath("userData"), "prefs.json");
const readPrefs = () => { try { return JSON.parse(readFileSync(prefsFile(), "utf8")); } catch { return {}; } };
let zoom = ZOOM;
const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome.split(".")[0]}.0.0.0 Safari/537.36`;

// Running from the project folder uses its own profile, so it never collides with the installed app.
if (DEV) app.setPath("userData", join(app.getPath("appData"), "Weborite Studio (dev)"));
// Only one copy per profile: a second launch just brings the running one to the front.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
  process.exit(0);
}
app.setAppUserModelId(DEV ? "com.weborite.studio.dev" : "com.weborite.studio");
zoom = Math.min(1.5, Math.max(0.5, Number(readPrefs().zoom) || ZOOM));
// Only for automated checks from the project folder: `STUDIO_DEBUG_PORT=9333 npm run desktop`.
if (DEV && process.env.STUDIO_DEBUG_PORT) app.commandLine.appendSwitch("remote-debugging-port", process.env.STUDIO_DEBUG_PORT);
app.userAgentFallback = CHROME_UA;

let win = null;
let tray = null;
let server = null;
let base = "";
let quitting = false;
let restarts = [];

/* ---------- data: first run of the installed app imports the project's data ---------- */

function prepareData() {
  mkdirSync(DATA, { recursive: true });
  if (DEV || existsSync(join(DATA, "studio.db"))) return;
  try {
    const info = JSON.parse(readFileSync(join(HERE, "build-info.json"), "utf8"));
    if (info.projectData && existsSync(join(info.projectData, "studio.db"))) cpSync(info.projectData, DATA, { recursive: true });
  } catch {
    /* fresh install: starts empty */
  }
}

/* ---------- the dashboard server ---------- */

const freePort = (start) =>
  new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(freePort(start + 1)));
    s.listen(start, "127.0.0.1", () => s.close(() => resolve(start)));
  });

async function startServer() {
  const port = await freePort(4310);
  mkdirSync(join(DATA, "logs"), { recursive: true });
  const log = createWriteStream(join(DATA, "logs", "server.log"), { flags: "a" });
  log.write(`\n--- ${new Date().toISOString()} starting on ${port}\n`);
  server = utilityProcess.fork(join(ROOT, "app-dist", "server.mjs"), [], {
    serviceName: "Weborite server",
    stdio: "pipe",
    env: { ...process.env, STUDIO_ROOT: ROOT, STUDIO_DATA: DATA, API_PORT: String(port), STUDIO_DESKTOP: "1" },
  });
  server.stdout?.on("data", (d) => log.write(d));
  server.stderr?.on("data", (d) => log.write(d));
  server.on("exit", (code) => {
    log.write(`--- exited ${code}\n`);
    if (quitting) return;
    restarts = restarts.filter((t) => Date.now() - t < 5 * 60000);
    restarts.push(Date.now());
    if (restarts.length > 3) {
      dialog.showErrorBox("Weborite Studio", `The background server keeps stopping (code ${code}). Details are in ${join(DATA, "logs", "server.log")}. Quit and reopen the app.`);
      return;
    }
    log.write("--- restarting\n");
    void startServer().then(() => win?.loadURL(base)).catch((e) => dialog.showErrorBox("Weborite Studio", e.message));
  });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/api/settings`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`The server didn't start. See ${join(DATA, "logs", "server.log")}`);
}

/* ---------- main window ---------- */

const LOADING = `data:text/html;charset=utf-8,${encodeURIComponent(`<html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#e6e5e5;font:15px Inter,Segoe UI,sans-serif;color:#555">Starting Weborite Studio…</body></html>`)}`;

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: "Weborite Studio",
    icon: ICON,
    backgroundColor: "#e6e5e5",
    autoHideMenuBar: true,
    webPreferences: { preload: join(HERE, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true, zoomFactor: zoom },
  });
  win.once("ready-to-show", () => win.show());
  // Ctrl + / Ctrl - / Ctrl 0, like a browser.
  win.webContents.on("before-input-event", (e, input) => {
    if (!input.control || input.type !== "keyDown") return;
    if (input.key === "=" || input.key === "+") setZoom(zoom + 0.1);
    else if (input.key === "-") setZoom(zoom - 0.1);
    else if (input.key === "0") setZoom(ZOOM);
    else return;
    e.preventDefault();
  });
  win.webContents.on("did-finish-load", () => win.webContents.setZoomFactor(zoom));
  void win.loadURL(LOADING);

  // Links to other sites open in the normal browser; the dashboard never navigates away from itself.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (base && url.startsWith(base)) return { action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: ICON } };
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (base && !url.startsWith(base) && url !== LOADING) {
      e.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });

  win.on("close", (e) => {
    if (quitting) return;
    // Keep running in the tray: messages, uptime checks and maintenance keep going.
    e.preventDefault();
    win.hide();
    if (!app.__trayHinted) {
      app.__trayHinted = true;
      new Notification({ title: "Weborite Studio is still running", body: "Messages and scheduled maintenance keep working. Quit from the tray icon.", icon: ICON }).show();
    }
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  const menu = () =>
    Menu.buildFromTemplate([
      { label: "Open Weborite Studio", click: showWindow },
      { type: "separator" },
      { label: "Start with Windows", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked, args: ["--hidden"] }) },
      { type: "separator" },
      { label: "Quit", click: () => { quitting = true; app.quit(); } },
    ]);
  tray.setToolTip("Weborite Studio");
  tray.setContextMenu(menu());
  tray.on("click", showWindow);
  tray.on("right-click", () => tray.setContextMenu(menu()));
}

/* ---------- Communication: one live browser view per channel ---------- */

const ALLOWED = new Set(["notifications", "media", "clipboard-read", "clipboard-sanitized-write", "fullscreen", "mediaKeySystem", "display-capture", "pointerLock"]);
const channels = new Map(); // id -> { svc, view, unread, title, favicon, loading, crashed, notes: Map }
let activeId = null;
let lastBounds = null;

function parseUnread(title) {
  const n = title.match(/\((\d{1,4})\+?\)/);
  if (n) return Number(n[1]);
  if (/^[•●]\s/.test(title)) return -1; // unread without a count (Discord)
  return 0;
}

function channelState() {
  const out = {};
  for (const [id, c] of channels) {
    const wc = c.view.webContents;
    out[id] = {
      unread: c.svc.muted ? 0 : c.unread,
      title: c.title,
      favicon: c.favicon,
      loading: c.loading,
      crashed: c.crashed,
      url: wc.isDestroyed() ? "" : wc.getURL(),
      canGoBack: !wc.isDestroyed() && wc.navigationHistory.canGoBack(),
      canGoForward: !wc.isDestroyed() && wc.navigationHistory.canGoForward(),
    };
  }
  return out;
}

let badgeImg = null;
function redDot() {
  if (badgeImg) return badgeImg;
  const png = new PNG({ width: 16, height: 16 });
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const i = (y * 16 + x) * 4;
      const inside = (x - 7.5) ** 2 + (y - 7.5) ** 2 <= 56;
      png.data.set(inside ? [220, 53, 69, 255] : [0, 0, 0, 0], i);
    }
  badgeImg = nativeImage.createFromBuffer(PNG.sync.write(png));
  return badgeImg;
}

let lastTotal = 0;
function broadcast() {
  const state = channelState();
  win?.webContents.send("comms:state", state);
  const total = Object.values(state).reduce((a, s) => a + Math.max(0, s.unread), 0);
  const any = Object.values(state).some((s) => s.unread !== 0);
  win?.setOverlayIcon(any ? redDot() : null, any ? `${total || "New"} unread` : "");
  tray?.setToolTip(any ? `Weborite Studio · ${total || "new"} unread` : "Weborite Studio");
  if (total > lastTotal && win && !win.isFocused()) win.flashFrame(true);
  lastTotal = total;
}

function isAuthUrl(url) {
  try {
    const h = new URL(url).hostname;
    return /(^|\.)(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|facebook\.com|discord\.com|slack\.com|github\.com)$/.test(h);
  } catch {
    return false;
  }
}

function createChannel(svc) {
  const ses = session.fromPartition(`persist:comms-${svc.id}`);
  ses.setUserAgent(CHROME_UA);
  const entry = { svc, view: null, unread: 0, title: svc.name, favicon: "", loading: true, crashed: false, notes: new Map() };
  const allowed = (perm) => ALLOWED.has(perm) && !(perm === "notifications" && (entry.svc.muted || !entry.svc.notify));
  ses.setPermissionRequestHandler((_wc, perm, cb) => cb(allowed(perm)));
  ses.setPermissionCheckHandler((_wc, perm) => allowed(perm));

  const view = new WebContentsView({
    webPreferences: { session: ses, preload: join(HERE, "preload-channel.cjs"), contextIsolation: true, sandbox: true, spellcheck: true, zoomFactor: zoom },
  });
  view.setBackgroundColor("#ffffff");
  entry.view = view;
  const wc = view.webContents;
  wc.setUserAgent(CHROME_UA);
  // Sign-in pop-ups stay in the channel's profile; every other link opens in the normal browser.
  wc.setWindowOpenHandler(({ url }) => {
    let sameSite = false;
    try {
      sameSite = new URL(url).hostname === new URL(entry.svc.url).hostname;
    } catch {
      /* not a web address */
    }
    if (/^https:/i.test(url) && (isAuthUrl(url) || sameSite)) {
      return { action: "allow", overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, icon: ICON, webPreferences: { session: ses } } };
    }
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  wc.on("page-title-updated", (_e, title) => {
    entry.title = title;
    entry.unread = parseUnread(title);
    broadcast();
  });
  wc.on("page-favicon-updated", (_e, icons) => {
    entry.favicon = icons[0] ?? "";
    broadcast();
  });
  wc.on("did-start-loading", () => { entry.loading = true; broadcast(); });
  wc.on("did-stop-loading", () => { entry.loading = false; entry.crashed = false; broadcast(); });
  wc.on("render-process-gone", () => { entry.crashed = true; broadcast(); });
  wc.on("did-navigate-in-page", broadcast);

  win.contentView.addChildView(view);
  view.setVisible(false);
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  channels.set(svc.id, entry);
  void wc.loadURL(svc.url);
}

function destroyChannel(id) {
  const c = channels.get(id);
  if (!c) return;
  win?.contentView.removeChildView(c.view);
  c.view.webContents.close();
  channels.delete(id);
  if (activeId === id) activeId = null;
}

async function syncChannels() {
  if (!base || !win) return;
  const list = await fetch(`${base}/api/comms`).then((r) => r.json()).catch(() => null);
  if (!list) return;
  for (const id of [...channels.keys()]) if (!list.some((s) => s.id === id)) destroyChannel(id);
  for (const svc of list) {
    const c = channels.get(svc.id);
    if (!c) createChannel(svc);
    else {
      const moved = c.svc.url !== svc.url;
      c.svc = svc;
      if (moved) void c.view.webContents.loadURL(svc.url);
    }
  }
  broadcast();
}

function place() {
  for (const [id, c] of channels) {
    const show = id === activeId && lastBounds && lastBounds.width > 0;
    if (show) c.view.setBounds(lastBounds);
    c.view.setVisible(Boolean(show));
  }
}

// The page measures in CSS pixels; at 90% zoom those are smaller than window pixels.
const clampBounds = (b) => {
  const z = win?.webContents.getZoomFactor() ?? 1;
  return { x: Math.round(b.x * z), y: Math.round(b.y * z), width: Math.max(0, Math.round(b.width * z)), height: Math.max(0, Math.round(b.height * z)) };
};

ipcMain.handle("comms:sync", () => syncChannels().then(channelState));
ipcMain.handle("comms:state", () => channelState());
ipcMain.on("comms:show", (_e, { id, bounds }) => {
  activeId = id;
  lastBounds = clampBounds(bounds);
  place();
  channels.get(id)?.view.webContents.focus();
});
ipcMain.on("comms:bounds", (_e, bounds) => {
  lastBounds = clampBounds(bounds);
  place();
});
ipcMain.on("comms:hide", () => {
  activeId = null;
  place();
});
ipcMain.handle("comms:action", async (_e, { id, action }) => {
  const c = channels.get(id);
  if (!c) return false;
  const wc = c.view.webContents;
  if (action === "reload") wc.reload();
  else if (action === "back" && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  else if (action === "forward" && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  else if (action === "home") await wc.loadURL(c.svc.url);
  else if (action === "devtools") wc.openDevTools({ mode: "detach" });
  else if (action === "zoom-in") wc.setZoomLevel(wc.getZoomLevel() + 0.5);
  else if (action === "zoom-out") wc.setZoomLevel(wc.getZoomLevel() - 0.5);
  else if (action === "zoom-reset") wc.setZoomFactor(zoom);
  else if (action === "signout") {
    await wc.session.clearStorageData();
    await wc.session.clearCache();
    await wc.loadURL(c.svc.url);
  }
  broadcast();
  return true;
});
function setZoom(z) {
  zoom = Math.round(Math.min(1.5, Math.max(0.5, z)) * 100) / 100;
  win?.webContents.setZoomFactor(zoom);
  for (const c of channels.values()) c.view.webContents.setZoomFactor(zoom);
  try { writeFileSync(prefsFile(), JSON.stringify({ ...readPrefs(), zoom })); } catch { /* not saved */ }
  win?.webContents.send("zoom:changed", zoom);
  return zoom;
}
ipcMain.handle("zoom:get", () => zoom);
ipcMain.handle("zoom:set", (_e, z) => setZoom(Number(z) || ZOOM));

ipcMain.on("open-external", (_e, url) => {
  if (/^https?:/i.test(String(url))) void shell.openExternal(url);
});

// Notifications from a channel become native Windows notifications; clicking one opens that chat.
ipcMain.on("channel:notify", (e, { nid, title, body }) => {
  const entry = [...channels.values()].find((c) => c.view.webContents.id === e.sender.id);
  if (!entry || entry.svc.muted || !entry.svc.notify) return;
  const n = new Notification({ title: `${entry.svc.name}: ${String(title).slice(0, 120)}`, body: String(body).slice(0, 300), icon: ICON, silent: false });
  n.on("click", () => {
    showWindow();
    win.webContents.send("comms:open", entry.svc.id);
    entry.view.webContents.send("channel:clicked", nid);
  });
  n.show();
});

/* ---------- lifecycle ---------- */

app.on("second-instance", showWindow);
app.on("before-quit", () => {
  quitting = true;
  server?.kill();
});
app.on("window-all-closed", () => {
  if (quitting) app.quit();
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  prepareData();
  createWindow();
  createTray();
  if (process.argv.includes("--hidden")) win.once("ready-to-show", () => win.hide());
  try {
    await startServer();
  } catch (e) {
    dialog.showErrorBox("Weborite Studio", e.message);
    quitting = true;
    app.quit();
    return;
  }
  await win.loadURL(base);
  await syncChannels();
});

import { useEffect, useRef, useState } from "react";
import { Download, RefreshCw, RotateCw, Sparkles, X } from "lucide-react";
import { desktop, type UpdateStatus } from "../lib/desktop";

/**
 * Slim bar above every page when the desktop app has an update. The actual download/install runs in the
 * Electron main process (electron-updater); this just drives it over the preload bridge and shows progress.
 * Renders nothing in a normal browser or when no update is pending.
 */
export function UpdateBanner() {
  const updates = desktop?.updates;
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const lastState = useRef<string>("idle");

  useEffect(() => {
    if (!updates) return;
    void updates.state().then((r) => setStatus(r.status));
    return updates.onStatus(setStatus);
  }, [updates]);

  // A new status is worth showing again even if the previous one was dismissed.
  useEffect(() => {
    if (status.state !== lastState.current) {
      lastState.current = status.state;
      setBusy(false);
      setDismissed(false);
    }
  }, [status.state]);

  if (!updates || dismissed) return null;
  const s = status.state;
  if (s !== "available" && s !== "downloading" && s !== "downloaded" && s !== "error") return null;

  const version = "version" in status && status.version ? ` (v${status.version})` : "";

  const download = async () => { setBusy(true); await updates.download().catch(() => setBusy(false)); };
  const install = async () => { setBusy(true); await updates.install(); };
  const retry = async () => { setBusy(true); await updates.check().finally(() => setBusy(false)); };

  return (
    <div className="demo-bar" role="status" style={{ background: s === "error" ? "var(--red-soft, #f7e6e6)" : "var(--accent-softer)" }}>
      {s === "error" ? <RefreshCw /> : <Sparkles />}
      <span>
        {s === "available" && <><b>Update available{version}</b> · a new version of the app is ready to download.</>}
        {s === "downloading" && <><b>Downloading update{version}…</b> {typeof status.percent === "number" ? `${status.percent}%` : ""}</>}
        {s === "downloaded" && <><b>Update ready{version}</b> · restart to finish installing. Your data stays as it is.</>}
        {s === "error" && <><b>Update check failed</b> · {status.message || "couldn't reach the update server."}</>}
      </span>

      {s === "downloading" && (
        <span aria-hidden style={{ flex: "1 1 120px", height: 4, borderRadius: 4, background: "var(--hairline)", overflow: "hidden", maxWidth: 220 }}>
          <span style={{ display: "block", height: "100%", width: `${status.percent ?? 0}%`, background: "var(--accent)", transition: "width .3s" }} />
        </span>
      )}

      {s === "available" && <button type="button" className="btn btn-sm btn-ink" disabled={busy} onClick={() => void download()}><Download />{busy ? "Starting…" : "Download update"}</button>}
      {s === "downloaded" && <button type="button" className="btn btn-sm btn-ink" disabled={busy} onClick={() => void install()}><RotateCw />{busy ? "Restarting…" : "Restart & install"}</button>}
      {s === "error" && <button type="button" className="btn btn-sm btn-white" disabled={busy} onClick={() => void retry()}><RefreshCw />Try again</button>}

      {s !== "downloading" && (
        <button type="button" className="btn btn-sm btn-white btn-icon" aria-label="Dismiss" title="Dismiss" onClick={() => setDismissed(true)}><X /></button>
      )}
    </div>
  );
}

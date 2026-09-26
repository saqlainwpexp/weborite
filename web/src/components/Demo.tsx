import { createContext, useContext, useState } from "react";
import { KeyRound, Loader2, Sparkles } from "lucide-react";
import type { DemoKind, DemoState } from "../../../shared/demo";
import { DEMO_LABELS, DEMO_LIMITS } from "../../../shared/demo";
import { api } from "../lib/api";
import { Modal } from "./ui";

/** Demo state from /api/license/status; null when the copy is licensed. */
export const DemoContext = createContext<{ demo: DemoState | null; refresh: () => void }>({ demo: null, refresh: () => {} });
export const useDemo = () => useContext(DemoContext);

/** Enter a license key from inside the demo; the whole app unlocks without a restart. */
export function UnlockModal({ onClose }: { onClose: () => void }) {
  const { refresh } = useDemo();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const go = async () => {
    if (!key.trim() || busy) return;
    setBusy(true);
    setErr("");
    try {
      await api("/api/license/activate", { method: "POST", json: { key: key.trim() } });
      refresh();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Unlock the full version" onClose={onClose}>
      <p className="muted" style={{ margin: 0 }}>Enter the license key from your purchase email. Everything you made in the demo stays.</p>
      <div>
        <div className="activate-row">
          <KeyRound className="activate-key-icon" />
          <input className="input activate-input" placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void go()} autoFocus spellCheck={false} aria-label="License key" />
        </div>
        {err && <p className="bad" role="alert" style={{ fontSize: 13, margin: "10px 0 0" }}>{err}</p>}
      </div>
      <div className="foot">
        <button className="btn btn-white" onClick={onClose}>Not now</button>
        <button className="btn btn-ink" disabled={busy || !key.trim()} onClick={() => void go()}>{busy ? <Loader2 className="spin" /> : <KeyRound />} Unlock</button>
      </div>
    </Modal>
  );
}

const KINDS = Object.keys(DEMO_LIMITS) as DemoKind[];

/** Slim bar above every page in the demo: what's left, and the way out. */
export function DemoBanner() {
  const { demo } = useDemo();
  const [open, setOpen] = useState(false);
  if (!demo) return null;
  const out = demo.left.mockups === 0;
  return (
    <>
      <div className={`demo-bar${out ? " out" : ""}`} role="status">
        <Sparkles />
        <span>
          <b>Demo</b> · {demo.left.mockups} of {DEMO_LIMITS.mockups} mockups left
          <details className="demo-limits">
            <summary>All demo limits</summary>
            <ul>
              {KINDS.map((k) => (
                <li key={k} className={demo.left[k] === 0 ? "used" : ""}>
                  <b>{demo.left[k]}</b> of {DEMO_LIMITS[k]} {DEMO_LABELS[k][DEMO_LIMITS[k] === 1 ? 0 : 1]} left
                </li>
              ))}
              <li>Up to {demo.results} results per search or campaign, {demo.products} products per store</li>
            </ul>
          </details>
        </span>
        <button type="button" className="btn btn-sm btn-ink" onClick={() => setOpen(true)}><KeyRound />Enter license key</button>
      </div>
      {open && <UnlockModal onClose={() => setOpen(false)} />}
    </>
  );
}

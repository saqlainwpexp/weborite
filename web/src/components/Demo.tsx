import { createContext, useContext, useEffect, useState } from "react";
import { ArrowUpRight, KeyRound, Loader2, Lock, Sparkles } from "lucide-react";
import type { DemoKind, DemoState } from "../../../shared/demo";
import { DEMO_LABELS, DEMO_LIMITS } from "../../../shared/demo";
import { api } from "../lib/api";
import { BUY_URL } from "../../../shared/legal";
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
        <a className="btn btn-sm btn-white" href={BUY_URL} target="_blank" rel="noreferrer">Buy a license <ArrowUpRight /></a>
        <button type="button" className="btn btn-sm btn-ink" onClick={() => setOpen(true)}><KeyRound />Enter license key</button>
      </div>
      {open && <UnlockModal onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Listens for requests the demo turned down (api() raises "studio:limit" on a 402) and explains what
 * happened instead of leaving a silent failure: which allowance ran out, what's left, and how to unlock.
 */
export function LimitWatcher() {
  const { demo, refresh } = useDemo();
  const [hit, setHit] = useState<{ kind: string; message: string } | null>(null);
  const [unlock, setUnlock] = useState(false);
  useEffect(() => {
    const on = (e: Event) => { setHit((e as CustomEvent<{ kind: string; message: string }>).detail); refresh(); };
    window.addEventListener("studio:limit", on);
    return () => window.removeEventListener("studio:limit", on);
  }, [refresh]);
  if (unlock) return <UnlockModal onClose={() => { setUnlock(false); setHit(null); }} />;
  if (!hit) return null;
  const kind = hit.kind in DEMO_LIMITS ? (hit.kind as DemoKind) : null;
  const title = hit.kind === "license" ? "This copy isn't activated" : kind ? `You've used the demo's ${DEMO_LABELS[kind][1]}` : "That's a demo limit";
  return (
    <Modal title={title} onClose={() => setHit(null)}>
      <div className="limit-modal">
        <span className="limit-icon"><Lock /></span>
        <p>{hit.message || "The demo doesn't allow this. Enter a license key to keep going."}</p>
        {demo && (
          <ul className="limit-left">
            {KINDS.filter((k) => k !== kind).slice(0, 4).map((k) => (
              <li key={k}><b>{demo.left[k]}</b> {DEMO_LABELS[k][demo.left[k] === 1 ? 0 : 1]} left</li>
            ))}
          </ul>
        )}
        <p className="muted">A Studio license removes every limit. Your leads, mockups and sites stay exactly where they are.</p>
      </div>
      <div className="foot">
        <button type="button" className="btn btn-white" onClick={() => setHit(null)}>Not now</button>
        <a className="btn btn-white" href={BUY_URL} target="_blank" rel="noreferrer">Buy a license <ArrowUpRight /></a>
        <button type="button" className="btn btn-ink" onClick={() => setUnlock(true)}><KeyRound /> Enter license key</button>
      </div>
    </Modal>
  );
}

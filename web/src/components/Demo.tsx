import { createContext, useContext, useState } from "react";
import { KeyRound, Loader2, Lock, Sparkles } from "lucide-react";
import type { DemoState } from "../../../shared/demo";
import { DEMO_LIMITS, DEMO_WORKSPACES } from "../../../shared/demo";
import { api } from "../lib/api";
import { Modal } from "./ui";

/** Demo state from /api/license/status; null when the copy is licensed. */
export const DemoContext = createContext<{ demo: DemoState | null; refresh: () => void }>({ demo: null, refresh: () => {} });
export const useDemo = () => useContext(DemoContext);
export const demoLocked = (demo: DemoState | null, workspace: string) => Boolean(demo) && !DEMO_WORKSPACES.includes(workspace);

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

/** Slim bar above every page in the demo: what's left, and the way out. */
export function DemoBanner() {
  const { demo } = useDemo();
  const [open, setOpen] = useState(false);
  if (!demo) return null;
  const out = demo.mockupsLeft === 0;
  return (
    <>
      <div className={`demo-bar${out ? " out" : ""}`} role="status">
        <Sparkles />
        <span>
          <b>Demo</b> · {demo.mockupsLeft} of {DEMO_LIMITS.mockups} mockups left · {demo.searchesLeft} of {DEMO_LIMITS.searches} Lead Finder searches left ({demo.resultsPerSearch} results each)
        </span>
        <button type="button" className="btn btn-sm btn-ink" onClick={() => setOpen(true)}><KeyRound />Enter license key</button>
      </div>
      {open && <UnlockModal onClose={() => setOpen(false)} />}
    </>
  );
}

const WHAT: Record<string, { title: string; body: string }> = {
  admin: { title: "Super admin", body: "Earnings, clients, retainers and reports across every workspace." },
  automations: { title: "Automations", body: "Describe who to target; it finds leads, builds their mockups and lines up outreach for you to approve." },
  builds: { title: "Builds", body: "Turns an approved mockup into a complete multi-page website." },
  wordpress: { title: "WordPress", body: "Rebuilds the site as native Elementor pages on the client's WordPress, including WooCommerce stores." },
  seo: { title: "Launch & SEO", body: "Post-launch checks, page speed and on-page SEO fixes." },
  care: { title: "Maintenance", body: "Monthly updates tested on a private staging copy first, backups, security and uptime." },
  comms: { title: "Communication", body: "WhatsApp, email, Messenger and more in one place." },
};

/** Shown instead of a locked workspace's pages in the demo. */
export function DemoLocked({ workspace }: { workspace: string }) {
  const [open, setOpen] = useState(false);
  const w = WHAT[workspace] ?? { title: "This workspace", body: "" };
  return (
    <div className="demo-locked">
      <span className="demo-lock-ico"><Lock /></span>
      <h1>{w.title} is part of the full version</h1>
      <p className="muted">{w.body}</p>
      <p className="muted">The demo includes Mockups and Lead Finder. Enter a license key to unlock every workspace.</p>
      <button type="button" className="btn btn-ink" onClick={() => setOpen(true)}><KeyRound />Enter license key</button>
      {open && <UnlockModal onClose={() => setOpen(false)} />}
    </div>
  );
}

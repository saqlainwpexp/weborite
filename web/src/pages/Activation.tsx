import { useState } from "react";
import { KeyRound, Loader2, AlertTriangle } from "lucide-react";
import { api } from "../lib/api";

export interface LicenseStatus {
  bypass: boolean;
  activated: boolean;
  licensed: boolean;
  status: string;
  name: string;
  unreachable?: boolean;
}

/** Full-screen activation gate shown when the copy isn't licensed. */
export function Activation({ status, onActivated }: { status: LicenseStatus; onActivated: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const expired = status.status === "expired" || status.status === "disabled" || status.status === "inactive";

  async function activate() {
    const k = key.trim();
    if (!k || busy) return;
    setBusy(true);
    setErr("");
    try {
      await api("/api/license/status"); // wake the API
      await api("/api/license/activate", { method: "POST", json: { key: k } });
      onActivated();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="activate-screen">
      <div className="activate-card">
        <div className="activate-mark">
          <svg viewBox="0 0 26 26" fill="none" aria-hidden="true">
            <path d="M13 2.5 20.4 5.6 23.5 13 20.4 20.4 13 23.5 5.6 20.4 2.5 13 5.6 5.6Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
            <path d="M13 2.5V9M13 17v6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </div>
        <h1>{expired ? "Your subscription is inactive" : "Activate Weborite Studio"}</h1>
        <p className="activate-sub">
          {expired
            ? "This subscription has expired or was cancelled. Renew it, or enter a different license key to continue."
            : "Enter the license key from your purchase email to activate this computer."}
        </p>

        <label className="activate-label">License key</label>
        <div className="activate-row">
          <KeyRound className="activate-key-icon" />
          <input
            className="input activate-input"
            placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && activate()}
            disabled={busy}
            autoFocus
            spellCheck={false}
          />
        </div>
        {err && <div className="activate-err"><AlertTriangle /> {err}</div>}
        {status.unreachable && !err && <div className="activate-err"><AlertTriangle /> Can't reach the app service. Reopen the app and try again.</div>}

        <button className="btn btn-ink activate-btn" onClick={activate} disabled={busy || !key.trim()}>
          {busy ? <Loader2 className="spin" /> : <KeyRound />} Activate
        </button>

        <div className="activate-foot">
          Your key came in the email after purchase. It activates one computer; you can move it to another PC from Settings later.
        </div>
      </div>
    </div>
  );
}

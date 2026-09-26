import { useState } from "react";
import { KeyRound, Loader2, AlertTriangle, ArrowRight, CheckCircle2 } from "lucide-react";
import { api } from "../lib/api";
import { WMark } from "../components/ui";
import { PRIVACY_URL, TERMS_URL } from "../../../shared/legal";
import { DEMO_LIMITS } from "../../../shared/demo";

export interface LicenseStatus {
  demo?: import("../../../shared/demo").DemoState | null;
  bypass: boolean;
  activated: boolean;
  licensed: boolean;
  onboarded?: boolean;
  status: string;
  name: string;
  unreachable?: boolean;
}

function Mark() {
  return (
    <div className="activate-mark">
      <WMark width={40} />
    </div>
  );
}

/**
 * First-run onboarding and the license gate.
 * New install: step 1 activates the license key, step 2 collects the owner's details and their acceptance of
 * the terms and privacy policy. A lapsed subscription only shows step 1. When the terms change, only step 2.
 */
export function Activation({ status, onActivated }: { status: LicenseStatus; onActivated: () => void }) {
  const expired = status.status === "expired" || status.status === "disabled" || status.status === "inactive";
  const needsKey = !status.licensed;
  const needsDetails = !status.onboarded;
  const [step, setStep] = useState<"key" | "details">(needsKey ? "key" : "details");
  const [key, setKey] = useState("");
  const [demo, setDemo] = useState(false);
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "", company: "", phone: "", country: "", marketing: false, acceptTerms: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ text: string; field?: string } | null>(null);
  const steps = (needsKey ? 1 : 0) + (needsDetails ? 1 : 0);

  async function activate() {
    const k = key.trim();
    if (!k || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api("/api/license/status"); // wake the API
      await api("/api/license/activate", { method: "POST", json: { key: k } });
      if (needsDetails) setStep("details");
      else onActivated();
    } catch (e) {
      setErr({ text: (e as Error).message, field: "key" });
    } finally {
      setBusy(false);
    }
  }

  async function backToDemo() {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/license/demo", { method: "POST" });
      onActivated();
    } catch (e) {
      setErr({ text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api("/api/license/onboard", { method: "POST", json: { ...form, demo } });
      onActivated();
    } catch (e) {
      const m = (e as Error).message;
      setErr({ text: m, field: /name/i.test(m) ? "name" : /email/i.test(m) ? "email" : /accept/i.test(m) ? "terms" : undefined });
    } finally {
      setBusy(false);
    }
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const detailsReady = form.firstName.trim() && form.lastName.trim() && form.email.trim() && form.acceptTerms;

  if (step === "key") {
    return (
      <div className="activate-screen">
        <div className="activate-card">
          <Mark />
          {steps > 1 && <p className="onb-step">Step 1 of 2</p>}
          <h1>{expired ? "Your subscription is inactive" : "Activate Weborite Studio"}</h1>
          <p className="activate-sub">
            {expired
              ? "This subscription has expired or was cancelled. Renew it, or enter a different license key to continue."
              : "Enter the license key from your purchase email to activate this computer."}
          </p>

          <label className="activate-label" htmlFor="onb-key">License key</label>
          <div className="activate-row">
            <KeyRound className="activate-key-icon" />
            <input
              id="onb-key"
              className="input activate-input"
              placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && activate()}
              disabled={busy}
              autoFocus
              spellCheck={false}
              aria-invalid={err?.field === "key" || undefined}
            />
          </div>
          {err && <div className="activate-err" role="alert"><AlertTriangle /> {err.text}</div>}
          {status.unreachable && !err && <div className="activate-err"><AlertTriangle /> Can't reach the app service. Reopen the app and try again.</div>}

          <button className="btn btn-ink activate-btn" onClick={activate} disabled={busy || !key.trim()}>
            {busy ? <Loader2 className="spin" /> : needsDetails ? <ArrowRight /> : <KeyRound />} {needsDetails ? "Continue" : "Activate"}
          </button>

          {needsDetails && !expired && (
            <>
              <div className="onb-or"><span>or</span></div>
              <button className="btn btn-white activate-btn onb-demo" onClick={() => { setDemo(true); setErr(null); setStep("details"); }} disabled={busy}>
                Try the demo first
              </button>
              <p className="onb-demo-note">
                Every feature, with small limits ({DEMO_LIMITS.mockups} mockups, {DEMO_LIMITS.searches} Lead Finder searches, 1 of each site). Enter a key later to remove them.
              </p>
            </>
          )}

          {!needsDetails && (
            <>
              <div className="onb-or"><span>or</span></div>
              <button className="btn btn-white activate-btn onb-demo" disabled={busy} onClick={() => void backToDemo()}>
                Continue with the demo
              </button>
              <p className="onb-demo-note">Every feature with small limits. Allowances you already used stay used.</p>
            </>
          )}

          <div className="activate-foot">
            Your key came in the email after purchase. It activates one computer; you can move it to another PC from Settings later.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="activate-screen">
      <div className="activate-card onb-card">
        <Mark />
        {steps > 1 && <p className="onb-step">Step 2 of 2</p>}
        {demo && <button type="button" className="link-btn onb-back" onClick={() => { setDemo(false); setStep("key"); }}>← I have a license key</button>}
        <h1>{demo ? "Set up your demo" : status.onboarded === false && !needsKey && status.activated ? "Welcome to Weborite Studio" : "Set up your account"}</h1>
        <p className="activate-sub">
          {demo
            ? "Tell us who's trying Weborite Studio. Your name and agency name also appear on the mockups you make."
            : needsKey || !status.activated
            ? "Tell us who's using this copy. Your name and agency name also appear on the mockups and reports you send."
            : "We've updated our Terms of Service and Privacy Policy. Check your details and accept them to continue."}
        </p>
        {!needsKey && status.licensed && !status.bypass && (
          <p className="onb-ok"><CheckCircle2 /> License active{status.name ? `: ${status.name}` : ""}</p>
        )}

        <form className="onb-form" onSubmit={(e) => { e.preventDefault(); void finish(); }} noValidate>
          <div className="onb-row">
            <label className="onb-field"><span>First name</span>
              <input className="input" autoComplete="given-name" value={form.firstName} onChange={set("firstName")} required autoFocus aria-invalid={(err?.field === "name" && !form.firstName.trim()) || undefined} />
            </label>
            <label className="onb-field"><span>Last name</span>
              <input className="input" autoComplete="family-name" value={form.lastName} onChange={set("lastName")} required aria-invalid={(err?.field === "name" && !form.lastName.trim()) || undefined} />
            </label>
          </div>
          <label className="onb-field"><span>Email</span>
            <input className="input" type="email" autoComplete="email" value={form.email} onChange={set("email")} required aria-invalid={err?.field === "email" || undefined} />
          </label>
          <label className="onb-field"><span>Agency or company name <em>optional</em></span>
            <input className="input" autoComplete="organization" value={form.company} onChange={set("company")} />
          </label>
          <div className="onb-row">
            <label className="onb-field"><span>Phone <em>optional</em></span>
              <input className="input" type="tel" autoComplete="tel" value={form.phone} onChange={set("phone")} />
            </label>
            <label className="onb-field"><span>Country <em>optional</em></span>
              <input className="input" autoComplete="country-name" value={form.country} onChange={set("country")} />
            </label>
          </div>

          <label className={`onb-check${err?.field === "terms" ? " bad" : ""}`}>
            <input type="checkbox" checked={form.acceptTerms} onChange={set("acceptTerms")} required />
            <span>
              I have read and accept the <a href={TERMS_URL} target="_blank" rel="noreferrer">Terms of Service</a> and the{" "}
              <a href={PRIVACY_URL} target="_blank" rel="noreferrer">Privacy Policy</a>.
            </span>
          </label>
          <label className="onb-check">
            <input type="checkbox" checked={form.marketing} onChange={set("marketing")} />
            <span>Email me about product updates and new features. <em>Optional, unsubscribe any time.</em></span>
          </label>

          {err && <div className="activate-err" role="alert"><AlertTriangle /> {err.text}</div>}

          <button type="submit" className="btn btn-ink activate-btn" disabled={busy || !detailsReady}>
            {busy ? <Loader2 className="spin" /> : <CheckCircle2 />} {demo ? "Start the demo" : "Finish setup"}
          </button>
        </form>
        <div className="activate-foot">Your details are stored on this computer and used to fill in your profile.</div>
      </div>
    </div>
  );
}

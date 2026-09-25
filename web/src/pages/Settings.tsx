import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, Navigate, useOutletContext, useParams } from "react-router-dom";
import {
  AtSign, Building2, CheckCircle2, Copy, Cpu, FileText, Globe, Hash, ImageIcon, KeyRound, Link2, Megaphone, Palette, Phone, RotateCcw,
  CalendarClock, Cloud, Gauge, Mail, ShieldCheck, SlidersHorizontal, Wrench, Sparkles, Terminal, Trash2, Upload, User, UserRound, XCircle,
} from "lucide-react";
import type { Settings as S } from "../../../shared/types";
import type { LayoutCtx } from "../layout/Layout";
import { api } from "../lib/api";
import { Dropdown } from "../components/Dropdown";
import { workspaceEnabled } from "../../../shared/features";
import { CLOUD_ROUTINE_PROMPT } from "../../../shared/cloudPrompt";
import { BRAND_PRESETS, DEFAULT_BRAND, applyBrand, brandPalette, isHex } from "../lib/brand";

type Draft = Partial<S> & { apiKey?: string; metaPageToken?: string; metaAppSecret?: string; psiKey?: string; gtmetrixKey?: string; cloudTriggerToken?: string; githubToken?: string };

const TABS = [
  { key: "profile", label: "Profile" },
  { key: "claude", label: "Claude" },
  { key: "leads", label: "Lead sources" },
  { key: "integrations", label: "Integrations" },
  { key: "maintenance", label: "Maintenance" },
].filter((t) => t.key !== "maintenance" || workspaceEnabled("care"));

/* ---------- building blocks (match the reference layout) ---------- */

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="set-section">
      <h3 className="set-title">{icon}{title}</h3>
      <div className="set-body">{children}</div>
    </section>
  );
}

function Field({ label, icon, hint, children, htmlFor }: { label: string; icon?: ReactNode; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="set-field">
      <label htmlFor={htmlFor}>{label}</label>
      <div className={icon ? "input-icon" : undefined}>
        {icon}
        {children}
      </div>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

function CopyCode({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="code">
      <span>{value}</span>
      <button type="button" className="btn btn-xs btn-white" onClick={() => { void navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); }}>
        <Copy size={13} />{done ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function UploadCard({ title, hint, src, round, kind, onDone }: { title: string; hint: string; src: string; round?: boolean; kind: "logo" | "avatar"; onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/brand/${kind}`, { method: "POST", headers: { "Content-Type": file.type }, body: file });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Upload failed");
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function remove() {
    await api(`/api/brand/${kind}`, { method: "DELETE" });
    onDone();
  }

  return (
    <div className="upload-card">
      <div className="upload-top">
        <span className={`upload-preview${round ? " round" : ""}`}>
          {src ? <img src={src} alt="" /> : kind === "logo" ? <ImageIcon /> : <UserRound />}
        </span>
        <div>
          <b>{title}</b>
          <small>{hint}</small>
        </div>
      </div>
      <div className="upload-actions">
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        <button type="button" className="btn btn-outline btn-sm" onClick={() => input.current?.click()} disabled={busy}><Upload />{busy ? "Uploading…" : "Upload"}</button>
        {src && <button type="button" className="btn btn-ghost btn-sm" onClick={remove}><Trash2 />Remove</button>}
        {error && <span className="error-text">{error}</span>}
      </div>
    </div>
  );
}

function OptionCard({ selected, onSelect, icon, label, preview }: { selected: boolean; onSelect: () => void; icon: ReactNode; label: string; preview: ReactNode }) {
  return (
    <button type="button" role="radio" aria-checked={selected} className={`option-card${selected ? " on" : ""}`} onClick={onSelect}>
      <span className="option-preview">{preview}</span>
      <span className="option-foot">
        {icon}
        <span>{label}</span>
        <i className="radio" aria-hidden="true" />
      </span>
    </button>
  );
}

function WindowArt({ dark, glyph }: { dark?: boolean; glyph: ReactNode }) {
  return (
    <span className={`window-art${dark ? " dark" : ""}`}>
      <span className="dots"><i /><i /><i /></span>
      {glyph}
    </span>
  );
}

/** Colour picker + hex field + presets. Changes preview live across the whole app. */
function BrandColorField({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const meta = brandPalette(value).meta;
  const commitText = (t: string) => {
    const v = t.startsWith("#") ? t : `#${t}`;
    setText(v);
    if (isHex(v)) onChange(v.toLowerCase());
  };
  return (
    <div className="set-field">
      <label htmlFor="p-brand">Brand colour</label>
      <div className="color-row">
        <label className="color-swatch" style={{ background: value }} title="Pick a colour">
          <input type="color" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Pick brand colour" />
        </label>
        <div className="input-icon" style={{ flex: 1 }}>
          <Hash />
          <input id="p-brand" className="input mono" value={text.replace(/^#/, "")} maxLength={7} onChange={(e) => commitText(e.target.value.trim())} spellCheck={false} aria-invalid={!isHex(text.startsWith("#") ? text : `#${text}`)} />
        </div>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => onChange(DEFAULT_BRAND)} disabled={value === DEFAULT_BRAND} title="Reset to the default rose">
          <RotateCcw />Reset
        </button>
      </div>
      <div className="preset-row" role="group" aria-label="Preset colours">
        {BRAND_PRESETS.map((c) => (
          <button key={c} type="button" className={`preset${c === value ? " on" : ""}`} style={{ background: c }} aria-label={`Use ${c}`} aria-pressed={c === value} onClick={() => onChange(c)} />
        ))}
      </div>
      <span className="hint">
        {meta.whiteOk ? "White text on this colour passes contrast." : "Light colour: text in the top bar and sidebar switches to dark so it stays readable."}
        {meta.accentAdjusted ? " Buttons use a slightly darker shade so their white text stays readable." : ""}
      </span>
    </div>
  );
}

/* ---------- page ---------- */

export default function Settings() {
  const { tab = "profile" } = useParams();
  const { settings, reloadAll } = useOutletContext<LayoutCtx>();
  const [draft, setDraft] = useState<Draft>({});
  const [status, setStatus] = useState<{ cli: string | null; apiKeySet: boolean } | null>(null);
  const [saved, setSaved] = useState(false);
  const [tunnel, setTunnelState] = useState(() => {
    try {
      return localStorage.getItem("studio.tunnel") || "https://your-tunnel.trycloudflare.com";
    } catch {
      return "https://your-tunnel.trycloudflare.com";
    }
  });
  const setTunnel = (v: string) => {
    setTunnelState(v);
    try {
      localStorage.setItem("studio.tunnel", v);
    } catch {
      /* storage unavailable */
    }
  };

  useEffect(() => {
    void api<{ cli: string | null; apiKeySet: boolean }>("/api/claude/status").then(setStatus);
  }, [settings?.claudePath, settings?.apiKeySet]);

  // Unsaved colour changes are a live preview; put the saved colour back when leaving the page.
  const savedBrand = useRef(settings?.brandColor ?? DEFAULT_BRAND);
  savedBrand.current = settings?.brandColor ?? DEFAULT_BRAND;
  useEffect(() => () => applyBrand(savedBrand.current), []);

  if (!TABS.some((t) => t.key === tab)) return <Navigate to="/settings/profile" replace />;
  if (!settings) return <p className="muted">Loading…</p>;

  const v = <K extends keyof S>(k: K) => (draft[k] ?? settings[k]) as S[K];
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [k]: e.target.value });
  const dirty = Object.keys(draft).length > 0;
  const discard = () => {
    setDraft({});
    applyBrand(settings.brandColor);
  };

  async function save(patch: Draft = draft) {
    await api("/api/settings", { method: "PUT", json: patch });
    setDraft({});
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    reloadAll();
  }

  const base = tunnel.replace(/\/$/, "");
  const brand = (f: string) => (f ? `/files/brand/${f}` : "");
  const cloudReady = Boolean(settings.githubTokenSet && settings.cloudRepo);
  const cloudRoutine = Boolean(settings.cloudTriggerUrl && settings.cloudTriggerTokenSet);
  const modeOk = settings.mode === "session" ? Boolean(status?.cli) : settings.mode === "cloud" ? cloudReady : settings.apiKeySet;

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><span>Settings</span><span className="sep">/</span><span className="here">{TABS.find((t) => t.key === tab)!.label}</span></nav>
      <div className="title-row">
        <h1 className="page-title">Settings</h1>
        <div className="actions">
          <span className={`status ${modeOk ? "ready" : "needs_review"}`}>
            <span className="dot" />
            {settings.mode === "session" ? (status?.cli ? `Session · Claude Code ${status.cli.split(" ")[0]}` : "Session · Claude Code not found") : settings.mode === "cloud" ? (cloudReady ? (cloudRoutine ? "Cloud mode · routine connected" : "Cloud mode · worker session") : "Cloud mode · setup incomplete") : settings.apiKeySet ? "API mode · key saved" : "API mode · no key"}
          </span>
        </div>
      </div>

      <nav className="tabs" aria-label="Settings sections">
        {TABS.map((t) => (
          <NavLink key={t.key} to={`/settings/${t.key}`} className={({ isActive }) => `tab${isActive ? " on" : ""}`} onClick={discard}>
            {t.label}
          </NavLink>
        ))}
      </nav>

      <div className="set-stack">
        {tab === "profile" && (
          <>
            <Section icon={<Palette />} title="Branding">
              <UploadCard kind="logo" title="Studio logo" hint="Shown in the top bar. Square works best. PNG, SVG, JPEG or WebP, up to 5 MB" src={brand(settings.logoFile)} onDone={reloadAll} />
              <div className="set-grid">
                <Field label="Studio name" icon={<Building2 />} htmlFor="p-studio" hint="Replaces “Studio” in the sidebar and the browser tab">
                  <input id="p-studio" className="input" placeholder="Enter your studio name" value={v("studioName")} onChange={set("studioName")} />
                </Field>
                <BrandColorField
                  value={v("brandColor")}
                  onChange={(hex) => {
                    setDraft({ ...draft, brandColor: hex });
                    applyBrand(hex);
                  }}
                />
              </div>
            </Section>

            <Section icon={<User />} title="Profile">
              <UploadCard kind="avatar" round title="Profile photo" hint="Min 400×400px. PNG or JPEG" src={brand(settings.avatarFile)} onDone={reloadAll} />
            </Section>

            <Section icon={<User />} title="Personal information">
              <div className="set-grid">
                <Field label="First name" icon={<User />} htmlFor="p-first">
                  <input id="p-first" className="input" placeholder="Enter your first name" value={v("firstName")} onChange={set("firstName")} autoComplete="given-name" />
                </Field>
                <Field label="Last name" icon={<User />} htmlFor="p-last">
                  <input id="p-last" className="input" placeholder="Enter your last name" value={v("lastName")} onChange={set("lastName")} autoComplete="family-name" />
                </Field>
                <Field label="Email address" icon={<AtSign />} htmlFor="p-email">
                  <input id="p-email" className="input" type="email" placeholder="Enter your email address" value={v("userEmail")} onChange={set("userEmail")} autoComplete="email" />
                </Field>
                <Field label="Phone number" icon={<Phone />} htmlFor="p-phone">
                  <input id="p-phone" className="input" type="tel" placeholder="Enter your phone number" value={v("userPhone")} onChange={set("userPhone")} autoComplete="tel" />
                </Field>
              </div>
            </Section>
          </>
        )}

        {tab === "claude" && (
          <>
            <Section icon={<Cpu />} title="Connection">
              <div className="option-grid" role="radiogroup" aria-label="How the studio talks to Claude">
                <OptionCard
                  selected={settings.mode === "session"}
                  onSelect={() => save({ mode: "session" })}
                  icon={<Cpu />}
                  label="Session (your plan)"
                  preview={<WindowArt dark={settings.mode === "session"} glyph={<Terminal />} />}
                />
                <OptionCard
                  selected={settings.mode === "api"}
                  onSelect={() => save({ mode: "api" })}
                  icon={<KeyRound />}
                  label="API key"
                  preview={<WindowArt dark={settings.mode === "api"} glyph={<KeyRound />} />}
                />
                <OptionCard
                  selected={settings.mode === "cloud"}
                  onSelect={() => save({ mode: "cloud" })}
                  icon={<Cloud />}
                  label="Cloud (claude.ai)"
                  preview={<WindowArt dark={settings.mode === "cloud"} glyph={<Cloud />} />}
                />
              </div>
              <div className="set-note">
                <span>{status?.cli ? <CheckCircle2 className="ok" /> : <XCircle className="bad" />}{status ? (status.cli ? `Claude Code ${status.cli}` : "Claude Code CLI not found") : "Checking Claude Code…"}</span>
                <span>{settings.apiKeySet ? <CheckCircle2 className="ok" /> : <XCircle className="muted" />}{settings.apiKeySet ? "API key saved" : "No API key saved"}</span>
              </div>
              {!status?.cli && settings.mode === "session" && (
                <ol className="steps-list">
                  <li>In your own terminal: <code>npm i -g @anthropic-ai/claude-code</code></li>
                  <li>Open a new terminal, run <code>claude</code> and log in with your Claude Pro or Max account.</li>
                  <li>Start the studio from that terminal with <code>npm run dev</code>.</li>
                </ol>
              )}
            </Section>

            {settings.mode === "cloud" && (
              <Section icon={<Cloud />} title="Cloud routine">
                <ol className="steps-list">
                  <li>Create a GitHub fine-grained token for the repo with <b>Contents: read &amp; write</b> and paste it with the repo below. Jobs and results travel through the jobs branch.</li>
                  <li>Open a session at <code>claude.ai/code</code> on the repo and say <b>run the cloud worker</b>. It works through queued jobs using your cloud session credits; keep it open while leads run.</li>
                  <li>Optional: instead of a worker session, a routine with an <b>API</b> trigger starts one session per job (uses routine runs). Paste its URL and token here and the prompt below as its instructions.</li>
                </ol>
                <div className="set-grid">
                  <Field label="Routine trigger URL (optional)" icon={<Link2 />} htmlFor="c-turl" hint="Leave empty to use a worker session">
                    <input id="c-turl" className="input mono" value={v("cloudTriggerUrl")} onChange={set("cloudTriggerUrl")} autoComplete="off" />
                  </Field>
                  <Field label="Routine token (optional)" icon={<KeyRound />} htmlFor="c-ttok" hint="Stored encrypted on this PC">
                    <input id="c-ttok" className="input mono" type="password" placeholder={settings.cloudTriggerTokenSet ? "•••••••• saved" : "sk-ant-oat01-…"} value={draft.cloudTriggerToken ?? ""} onChange={set("cloudTriggerToken")} autoComplete="off" />
                  </Field>
                  <Field label="GitHub repo" icon={<Hash />} htmlFor="c-repo" hint="owner/name, the same repo the routine uses">
                    <input id="c-repo" className="input mono" placeholder="owner/repo" value={v("cloudRepo")} onChange={set("cloudRepo")} />
                  </Field>
                  <Field label="GitHub token" icon={<KeyRound />} htmlFor="c-gh" hint="Stored encrypted on this PC">
                    <input id="c-gh" className="input mono" type="password" placeholder={settings.githubTokenSet ? "•••••••• saved" : "github_pat_…"} value={draft.githubToken ?? ""} onChange={set("githubToken")} autoComplete="off" />
                  </Field>
                  <Field label="Jobs branch" icon={<Terminal />} htmlFor="c-br" hint={<>Must start with <code>claude/</code></>}>
                    <input id="c-br" className="input mono" value={v("cloudBranch")} onChange={set("cloudBranch")} />
                  </Field>
                </div>
                <Field label="Routine instructions (only for the optional routine)" icon={<FileText />} htmlFor="c-prompt">
                  <textarea id="c-prompt" className="input mono" rows={9} readOnly value={CLOUD_ROUTINE_PROMPT} />
                </Field>
                <div className="set-note">
                  <span>{cloudReady ? <CheckCircle2 className="ok" /> : <XCircle className="bad" />}{cloudReady ? (cloudRoutine ? "Ready: each Claude step starts a routine session" : "Ready: jobs wait for a worker session at claude.ai/code") : "Add the GitHub repo and token, then save"}</span>
                </div>
              </Section>
            )}

            <Section icon={<SlidersHorizontal />} title="Configuration">
              <div className="set-grid">
                <Field label="Claude Code command" icon={<Terminal />} htmlFor="c-cli" hint={<>Leave as <code>claude</code> unless it's installed somewhere custom</>}>
                  <input id="c-cli" className="input mono" value={v("claudePath")} onChange={set("claudePath")} />
                </Field>
                <Field label="Anthropic API key" icon={<KeyRound />} htmlFor="c-key" hint="Only used in API mode. Stored locally in data/studio.db">
                  <input id="c-key" className="input mono" type="password" placeholder={settings.apiKeySet ? "•••••••• saved" : "sk-ant-…"} value={draft.apiKey ?? ""} onChange={set("apiKey")} autoComplete="off" />
                </Field>
                <Field label="Mockup model" htmlFor="c-gen">
                  <Dropdown field id="c-gen" label="Mockup model" icon={<Sparkles />} value={v("generateModel")} onChange={(x) => setDraft({ ...draft, generateModel: x })}
                    options={[
                      { value: "claude-opus-5", label: "Claude Opus 5", hint: "Best design quality" },
                      { value: "claude-opus-5-5", label: "Claude Opus 5.5", hint: "Newest Opus" },
                      { value: "claude-sonnet-5", label: "Claude Sonnet 5", hint: "Faster, lighter on usage" },
                    ]} />
                </Field>
                <Field label="Diagnosis model" htmlFor="c-fast">
                  <Dropdown field id="c-fast" label="Diagnosis model" icon={<Sparkles />} value={v("fastModel")} onChange={(x) => setDraft({ ...draft, fastModel: x })}
                    options={[
                      { value: "claude-sonnet-5", label: "Claude Sonnet 5", hint: "Recommended" },
                      { value: "claude-haiku-4-5", label: "Claude Haiku 4.5", hint: "Fastest" },
                      { value: "claude-opus-5", label: "Claude Opus 5", hint: "Most thorough" },
                    ]} />
                </Field>
              </div>
            </Section>
          </>
        )}

        {tab === "maintenance" && (
          <>
            <Section icon={<CalendarClock />} title="Monthly check">
              <div className="set-grid">
                <Field label="Day of the month" htmlFor="m-day" hint="From 6 am that day (or the next time this app is open). 0 turns the automatic check off.">
                  <input id="m-day" className="input" type="number" min={0} max={28} value={String(v("careDay"))} onChange={(e) => setDraft({ ...draft, careDay: Number(e.target.value) })} />
                </Field>
                <Field label="On that day" htmlFor="m-auto">
                  <Dropdown field id="m-auto" label="On that day" icon={<Wrench />} value={v("careAutoStage") ? "stage" : "scan"} onChange={(x) => setDraft({ ...draft, careAutoStage: x === "stage" })}
                    options={[{ value: "stage", label: "Scan and test updates on staging", hint: "Stops at your approval" }, { value: "scan", label: "Only scan", hint: "Updates and vulnerabilities" }]} />
                </Field>
              </div>
            </Section>
            <Section icon={<ShieldCheck />} title="Testing">
              <div className="set-grid">
                <Field label="Visual change allowed per page (%)" htmlFor="m-diff" hint="Pages that change more than this after an update are flagged for review. Sliders and rotating content need a higher value.">
                  <input id="m-diff" className="input" type="number" min={0.1} max={20} step={0.1} value={String(v("careDiffThreshold"))} onChange={(e) => setDraft({ ...draft, careDiffThreshold: Number(e.target.value) })} />
                </Field>
                <Field label="After the live update" htmlFor="m-keep">
                  <Dropdown field id="m-keep" label="After the live update" icon={<Wrench />} value={v("careKeepStaging") ? "keep" : "delete"} onChange={(x) => setDraft({ ...draft, careKeepStaging: x === "keep" })}
                    options={[{ value: "delete", label: "Delete the staging copy", hint: "Frees disk space on the host" }, { value: "keep", label: "Keep it until next month" }]} />
                </Field>
              </div>
            </Section>
          </>
        )}

        {tab === "integrations" && (
          <>
            <Section icon={<Gauge />} title="Speed testing">
              <div className="set-grid">
                <Field label="Google PageSpeed API key (optional)" icon={<KeyRound />} htmlFor="i-psi" hint={<>Free from Google Cloud. Without a key, real-user Core Web Vitals still work, just rate-limited.</>}>
                  <input id="i-psi" className="input mono" type="password" placeholder={settings.psiKeySet ? "•••••••• saved" : "AIza…"} value={draft.psiKey ?? ""} onChange={set("psiKey")} autoComplete="off" />
                </Field>
                <Field label="GTmetrix API key (optional)" icon={<KeyRound />} htmlFor="i-gt" hint="From a free GTmetrix account (Account → API). Adds a GTmetrix grade for each site's homepage.">
                  <input id="i-gt" className="input mono" type="password" placeholder={settings.gtmetrixKeySet ? "•••••••• saved" : "Paste your API key"} value={draft.gtmetrixKey ?? ""} onChange={set("gtmetrixKey")} autoComplete="off" />
                </Field>
              </div>
            </Section>
            <Section icon={<Mail />} title="Form testing">
              <div className="set-grid">
                <Field label="QA email address" icon={<AtSign />} htmlFor="i-qa" hint="Form tests submit this address so the confirmation lands with you. Defaults to your profile email.">
                  <input id="i-qa" className="input" type="email" placeholder={settings.userEmail || "you@agency.com"} value={v("qaEmail")} onChange={set("qaEmail")} />
                </Field>
              </div>
            </Section>
          </>
        )}

        {tab === "leads" && (
          <>
            <Section icon={<Globe />} title="Tunnel">
              <div className="set-card">
                <ol className="steps-list">
                  <li>Install cloudflared (free): <code>winget install Cloudflare.cloudflared</code></li>
                  <li>Run <code>cloudflared tunnel --url http://localhost:4001</code> and copy the https URL it prints.</li>
                  <li>Paste it below. Only the webhook port is exposed. The dashboard stays private.</li>
                </ol>
              </div>
              <div className="set-grid">
                <Field label="Tunnel URL" icon={<Link2 />} htmlFor="l-tunnel" hint="Saved in this browser">
                  <input id="l-tunnel" className="input mono" value={tunnel} onChange={(e) => setTunnel(e.target.value)} />
                </Field>
              </div>
            </Section>

            <Section icon={<FileText />} title="Elementor form">
              <div className="set-field">
                <label>Webhook URL</label>
                <CopyCode value={`${base}/hooks/elementor?key=${settings.elementorSecret}`} />
                <span className="hint">Form widget → Actions After Submit → Webhook. The form needs a website URL field.</span>
              </div>
            </Section>

            <Section icon={<Megaphone />} title="Meta Lead Ads">
              <div className="set-grid">
                <div className="set-field">
                  <label>Callback URL</label>
                  <CopyCode value={`${base}/hooks/meta`} />
                </div>
                <div className="set-field">
                  <label>Verify token</label>
                  <CopyCode value={settings.metaVerifyToken} />
                </div>
                <Field label="Page access token" icon={<KeyRound />} htmlFor="l-meta" hint="Needs leads_retrieval and pages_manage_metadata">
                  <input id="l-meta" className="input mono" type="password" placeholder={settings.metaPageTokenSet ? "•••••••• saved" : "EAAB…"} value={draft.metaPageToken ?? ""} onChange={set("metaPageToken")} autoComplete="off" />
                </Field>
                <Field label="App secret (optional)" icon={<ShieldCheck />} htmlFor="l-secret" hint="Verifies that webhook calls really come from Meta">
                  <input id="l-secret" className="input mono" type="password" placeholder={settings.metaAppSecretSet ? "•••••••• saved" : "Paste the app secret"} value={draft.metaAppSecret ?? ""} onChange={set("metaAppSecret")} autoComplete="off" />
                </Field>
              </div>
            </Section>
          </>
        )}
      </div>

      <div className="set-actions">
        <button type="button" className="btn btn-ink" onClick={() => save()} disabled={!dirty}>Update now</button>
        {dirty && <button type="button" className="btn btn-chip" onClick={discard}>Discard</button>}
        {saved && <span className="status ready"><span className="dot" />Saved</span>}
      </div>
    </>
  );
}

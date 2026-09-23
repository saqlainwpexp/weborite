import { useEffect, useState, type ReactNode } from "react";
import { useOutletContext } from "react-router-dom";
import { BadgeDollarSign, CheckCircle2, Filter, KeyRound, Plus, Search, Settings2, Tags, UserRound, X, XCircle } from "lucide-react";
import type { BidderConfig, BidderState } from "../../../../shared/types";
import type { LayoutCtx } from "../../layout/Layout";
import { api } from "../../lib/api";
import { Dropdown } from "../../components/Dropdown";
import { Field } from "../../components/builds";

type Draft = Omit<BidderConfig, "exclude" | "excludeCountries"> & { exclude: string; excludeCountries: string };
type Skill = { id: number; name: string; category: string; active: number | null };

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="set-section">
      <h3 className="set-title">{icon}{title}</h3>
      <div className="set-body">{children}</div>
    </section>
  );
}

const toDraft = (c: BidderConfig): Draft => ({ ...c, exclude: c.exclude.join("\n"), excludeCountries: c.excludeCountries.join("\n") });

export default function BidderSettings() {
  const { bidder, reloadAll } = useOutletContext<LayoutCtx>();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [token, setToken] = useState("");
  const [tokenEnv, setTokenEnv] = useState<"live" | "sandbox">("sandbox");
  const [skillQ, setSkillQ] = useState("");
  const [skillHits, setSkillHits] = useState<Skill[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (bidder && !draft) {
      setDraft(toDraft(bidder.config));
      setTokenEnv(bidder.config.env);
    }
  }, [bidder, draft]);

  // Skill search against Freelancer's list.
  useEffect(() => {
    if (!bidder?.config.tokenSet || skillQ.trim().length < 2) return setSkillHits([]);
    const t = setTimeout(() => {
      api<Skill[]>(`/api/bidder/skills?q=${encodeURIComponent(skillQ.trim())}`).then(setSkillHits).catch((e) => setMsg({ ok: false, text: (e as Error).message }));
    }, 300);
    return () => clearTimeout(t);
  }, [skillQ, bidder?.config.tokenSet]);

  if (!draft || !bidder) return <p className="muted">Loading…</p>;
  const cfg = bidder.config;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...draft, [k]: v });
  const numInput = (k: keyof Draft, props: { min?: number; max?: number; step?: number } = {}) => (
    <input className="input" type="number" {...props} value={String(draft[k] ?? "")} onChange={(e) => set(k, Number(e.target.value) as never)} />
  );

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      reloadAll();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const saveToken = () =>
    run(async () => {
      const s = await api<BidderState>("/api/bidder/token", { method: "POST", json: { token, env: tokenEnv } });
      setToken("");
      setDraft({ ...draft, env: s.config.env, user: s.config.user });
    }, "Token saved and working.");

  const removeToken = () => {
    if (!confirm("Remove the saved token? The bidder stops until you add a new one.")) return;
    void run(async () => {
      await api("/api/bidder/token", { method: "POST", json: { token: "" } });
      setDraft({ ...draft, enabled: false, user: null });
    }, "Token removed.");
  };

  const save = () =>
    run(async () => {
      const { tokenSet: _t, user: _u, env: _e, ...rest } = draft;
      const s = await api<BidderState>("/api/bidder/config", { method: "PUT", json: rest });
      setDraft(toDraft(s.config));
    }, "Settings saved.");

  const addSkill = (s: Skill) => {
    if (!draft.skills.some((x) => x.id === s.id)) set("skills", [...draft.skills, { id: s.id, name: s.name }]);
    setSkillQ("");
    setSkillHits([]);
  };

  // A worked example of the pricing rule.
  const ex = { lo: 250, hi: 750 };
  const at = (c: number) => Math.round(ex.lo + (ex.hi - ex.lo) * ((draft.floorPct + (draft.ceilPct - draft.floorPct) * c) / 100));

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><span>Freelancer Bids</span><span className="sep">/</span><span className="here">Bid settings</span></nav>
      <div className="title-row"><h1 className="page-title">Bid settings</h1></div>

      <div className="set-stack">
        <Section icon={<KeyRound />} title="Freelancer account">
          <div className="set-grid">
            <Field label="Site" htmlFor="bs-env" hint="Test on the sandbox first. It needs its own account and token from freelancer-sandbox.com.">
              <Dropdown field id="bs-env" label="Site" value={tokenEnv} onChange={(v) => setTokenEnv(v as "live" | "sandbox")}
                options={[{ value: "sandbox", label: "Sandbox", hint: "freelancer-sandbox.com, no real bids" }, { value: "live", label: "Live", hint: "freelancer.com, real bids" }]} />
            </Field>
            <Field label="Access token" htmlFor="bs-token" hint={cfg.tokenSet ? `Saved${cfg.user ? ` · signed in as @${cfg.user.username} on ${cfg.env === "live" ? "freelancer.com" : "the sandbox"}` : ""}. Paste a new one to replace it.` : "From your app's dashboard on Freelancer (Generate Token). Stored only on this PC."}>
              <input id="bs-token" className="input" type="password" autoComplete="off" placeholder={cfg.tokenSet ? "••••••••••••" : "Paste your token"} value={token} onChange={(e) => setToken(e.target.value)} />
            </Field>
          </div>
          <div className="set-actions" style={{ marginTop: 12 }}>
            <button className="btn btn-ink btn-sm" disabled={busy || !token.trim()} onClick={saveToken}>Save and test</button>
            {cfg.tokenSet && tokenEnv !== cfg.env && !token && <span className="muted">Paste the {tokenEnv} token to switch sites.</span>}
            {cfg.tokenSet && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={removeToken}>Remove token</button>}
          </div>
        </Section>

        <Section icon={<Settings2 />} title="Bidder">
          <div className="set-grid">
            <Field label="Status" htmlFor="bs-on">
              <Dropdown field id="bs-on" label="Status" value={draft.enabled ? "on" : "off"} onChange={(v) => set("enabled", v === "on")}
                options={[{ value: "on", label: "On", hint: "Checks for new projects on a timer" }, { value: "off", label: "Paused" }]} />
            </Field>
            <Field label="When a proposal is ready" htmlFor="bs-mode" hint="Start with review until you trust the drafts.">
              <Dropdown field id="bs-mode" label="Mode" value={draft.mode} onChange={(v) => set("mode", v as Draft["mode"])}
                options={[{ value: "review", label: "Wait for my review", hint: "You approve every bid" }, { value: "auto", label: "Bid automatically", hint: "Up to the daily limit" }]} />
            </Field>
            <Field label="Check every (minutes)" htmlFor="bs-poll" hint="The first bids get the most attention. 1–3 minutes is a good pace.">{numInput("pollMinutes", { min: 1, max: 60 })}</Field>
            <Field label="Automatic bids per day" htmlFor="bs-limit" hint="Protects your monthly bid allowance. After the limit, drafts wait for you.">{numInput("dailyBidLimit", { min: 0, max: 500 })}</Field>
          </div>
        </Section>

        <Section icon={<Tags />} title="What to bid on">
          <Field label="Skills" htmlFor="bs-skill" hint={cfg.tokenSet ? "Freelancer's own skill names. Projects tagged with any of them are checked." : "Save your token first to search Freelancer's skills."}>
            <div className="chips" style={{ marginBottom: draft.skills.length ? 4 : 0 }}>
              {draft.skills.map((s) => (
                <span key={s.id} className="filter-chip">{s.name}
                  <button type="button" aria-label={`Remove ${s.name}`} onClick={() => set("skills", draft.skills.filter((x) => x.id !== s.id))}><X /></button>
                </span>
              ))}
            </div>
            <div className="input-icon"><Search /><input id="bs-skill" className="input" placeholder="Search skills, e.g. WordPress" disabled={!cfg.tokenSet} value={skillQ} onChange={(e) => setSkillQ(e.target.value)} /></div>
            {skillHits.length > 0 && (
              <div className="search-list">
                {skillHits.map((s) => (
                  <button key={s.id} type="button" className="search-row" style={{ gridTemplateColumns: "minmax(0,1fr) auto" }} onClick={() => addSkill(s)}>
                    <span className="search-main"><b>{s.name}</b><small>{s.category}{s.active != null ? ` · ${s.active} active projects` : ""}</small></span>
                    <span className="btn btn-chip btn-xs"><Plus />Add</span>
                  </button>
                ))}
              </div>
            )}
          </Field>
          <div className="set-grid" style={{ marginTop: 12 }}>
            <Field label="Extra search words" htmlFor="bs-q" hint="Optional. Matches any of the words, e.g. “elementor landing page”.">
              <input id="bs-q" className="input" value={draft.query} onChange={(e) => set("query", e.target.value)} />
            </Field>
            <Field label="Project types" htmlFor="bs-types">
              <Dropdown field id="bs-types" label="Project types" value={draft.types.fixed && draft.types.hourly ? "both" : draft.types.hourly ? "hourly" : "fixed"}
                onChange={(v) => set("types", { fixed: v !== "hourly", hourly: v !== "fixed" })}
                options={[{ value: "both", label: "Fixed price and hourly" }, { value: "fixed", label: "Fixed price only" }, { value: "hourly", label: "Hourly only" }]} />
            </Field>
          </div>
          <div style={{ marginTop: 12 }}>
            <Field label="Skip projects that mention" htmlFor="bs-ex" hint="One word or phrase per line.">
              <textarea id="bs-ex" className="input textarea" rows={4} placeholder={"shopify\nunpaid test\nlong term partner 5$"} value={draft.exclude} onChange={(e) => set("exclude", e.target.value)} />
            </Field>
          </div>
        </Section>

        <Section icon={<Filter />} title="Filters">
          <div className="set-grid">
            <Field label="Minimum fixed budget (USD)" htmlFor="bs-minf" hint="Compared with the top of the client's range.">{numInput("minFixedUsd", { min: 0 })}</Field>
            <Field label="Minimum hourly rate (USD)" htmlFor="bs-minh">{numInput("minHourlyUsd", { min: 0 })}</Field>
            <Field label="Skip when bids are over" htmlFor="bs-maxb">{numInput("maxBidCount", { min: 0 })}</Field>
            <Field label="Only projects posted in the last (minutes)" htmlFor="bs-age" hint="Stops the first run from bidding on a backlog.">{numInput("maxAgeMinutes", { min: 5 })}</Field>
            <Field label="Client payment" htmlFor="bs-pay">
              <Dropdown field id="bs-pay" label="Client payment" value={draft.requirePaymentVerified ? "yes" : "no"} onChange={(v) => set("requirePaymentVerified", v === "yes")}
                options={[{ value: "yes", label: "Verified clients only" }, { value: "no", label: "Any client" }]} />
            </Field>
            <Field label="Skip clients in these countries" htmlFor="bs-ctry" hint="One per line, as Freelancer spells them.">
              <textarea id="bs-ctry" className="input textarea" rows={3} value={draft.excludeCountries} onChange={(e) => set("excludeCountries", e.target.value)} />
            </Field>
          </div>
        </Section>

        <Section icon={<BadgeDollarSign />} title="Pricing">
          <div className="set-grid">
            <Field label="Simple jobs bid at (% of range)" htmlFor="bs-floor" hint="0% = the client's minimum, 100% = their maximum.">{numInput("floorPct", { min: 0, max: 100 })}</Field>
            <Field label="Complex jobs bid at (% of range)" htmlFor="bs-ceil" hint="Never above the maximum.">{numInput("ceilPct", { min: 0, max: 100 })}</Field>
            <Field label="No maximum given: treat max as minimum ×" htmlFor="bs-open" hint="For “$250+” budgets.">{numInput("openBudgetFactor", { min: 1, max: 5, step: 0.1 })}</Field>
            <div className="set-card">
              <b style={{ fontWeight: 450 }}>Example: a $250–$750 project</b>
              <p className="muted" style={{ marginTop: 6 }}>Simple: ${at(0)} · medium: ${at(0.5)} · complex: ${at(1)}. Claude rates the complexity; the amount is always kept inside the client's range.</p>
            </div>
          </div>
        </Section>

        <Section icon={<UserRound />} title="About you (for Claude)">
          <Field label="Your profile" htmlFor="bs-prof" hint="Skills, years of experience, tools, the kind of work you do best, portfolio links. Claude only claims what's written here.">
            <textarea id="bs-prof" className="input textarea" rows={8} value={draft.profile} onChange={(e) => set("profile", e.target.value)}
              placeholder={"WordPress and Elementor developer, 6 years.\nBuilt 150+ business sites: agencies, clinics, restaurants.\nAlso: WooCommerce, speed optimisation, Figma to WordPress.\nPortfolio: https://…"} />
          </Field>
          <div style={{ marginTop: 12 }}>
            <Field label="Past proposals that won work" htmlFor="bs-samp" hint="Optional. Two or three of your best, so drafts sound like you.">
              <textarea id="bs-samp" className="input textarea" rows={8} value={draft.samples} onChange={(e) => set("samples", e.target.value)} />
            </Field>
          </div>
        </Section>
      </div>

      {msg && <div className={`banner${msg.ok ? "" : " err"}`}>{msg.ok ? <CheckCircle2 /> : <XCircle />}{msg.text}</div>}
      <div className="set-actions">
        <button className="btn btn-ink" disabled={busy} onClick={save}>Save settings</button>
      </div>
    </>
  );
}

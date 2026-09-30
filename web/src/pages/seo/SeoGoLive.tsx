import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle, ArrowRightLeft, Camera, CheckCircle2, Circle, CloudCog, Download, FileText, Globe, Loader2, Mail, Play, Rocket, Save, Send, Server, ShieldCheck, Undo2, Wrench, XCircle,
} from "lucide-react";
import type { GoLiveCheck, GoLiveRecord, SeoSite } from "../../../../shared/types";
import { api, timeAgo, usePoll } from "../../lib/api";

type Data = {
  record: GoLiveRecord;
  job: { kind: string; note: string; startedAt: string; error?: string; finishedAt?: string } | null;
  human: { id: string; label: string; hint: string }[];
  snapshot: { at: string; count: number } | null;
  setup: { agencyAdminEmail: string; cloudflare: boolean; imap: boolean; qaEmail: string };
};

const KIT: { id: string; label: string; hint: string }[] = [
  { id: "plugins", label: "Install the universal plugins", hint: "UpdraftPlus, Wordfence, FluentSMTP, plus LiteSpeed Cache only on LiteSpeed servers" },
  { id: "backups", label: "Schedule backups", hint: "Files weekly (keep 4), database daily (keep 14)" },
  { id: "security", label: "Security hardening", hint: "Headers, private usernames, no generator, XML-RPC off, readme/license denied, no directory listings" },
  { id: "admin", label: "Agency admin email", hint: "Pins the admin email and keeps only failure notices" },
  { id: "forms", label: "Form recipient", hint: "Where the Studio form handler sends messages" },
  { id: "webp", label: "WebP everywhere", hint: "Rewrite rules, WebP on upload, converts existing images" },
  { id: "llms", label: "Publish llms.txt", hint: "A plain summary of the site for AI search" },
];

const ico = (st: string) => (st === "pass" || st === "done" ? <CheckCircle2 className="ok" /> : st === "fail" ? <XCircle className="bad" /> : st === "warn" ? <AlertTriangle className="warn" /> : <Circle className="muted" />);
const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "");

function Section({ icon, title, sub, children, right }: { icon: ReactNode; title: string; sub?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="card card-lg golive-card">
      <div className="card-head">
        <div className="golive-head">{icon}<div><h3 className="card-title">{title}</h3>{sub && <p className="card-sub">{sub}</p>}</div></div>
        {right}
      </div>
      {children}
    </div>
  );
}

function L({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return <label className={`golive-field${wide ? " wide" : ""}`}><span>{label}</span>{children}</label>;
}

export default function SeoGoLive({ site }: { site: SeoSite }) {
  const { data, reload } = usePoll<Data>(`/api/golive/${site.id}`, 3000);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [draft, setDraft] = useState<GoLiveRecord | null>(null);
  const [kit, setKit] = useState<string[]>(KIT.map((k) => k.id));
  const [userEmail, setUserEmail] = useState(true);
  const [recipient, setRecipient] = useState("");
  const [smtp, setSmtp] = useState({ from: "", host: "", port: 465, encryption: "ssl", username: "", password: "" });
  const [ip, setIp] = useState("");
  const [plan, setPlan] = useState("");
  const [busy, setBusy] = useState("");
  const [showPassing, setShowPassing] = useState(false);

  const rec = data?.record;
  useEffect(() => {
    if (rec && !draft) {
      setDraft(rec);
      setRecipient(rec.wp?.form_recipient || "");
      setSmtp((x) => ({ ...x, from: rec.smtp.from, host: rec.smtp.host || (rec.domain ? `mail.${rec.domain}` : ""), port: rec.smtp.port || 465, encryption: rec.smtp.encryption || "ssl", username: rec.smtp.username }));
      setIp(rec.hosting.newIp);
    }
  }, [rec, draft]);

  if (!data || !rec || !draft) return <p className="muted">Loading…</p>;
  const { job, setup } = data;
  const running = Boolean(job && !job.finishedAt);
  const wp = rec.wp;

  async function act(key: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(key);
    setMsg(null);
    try {
      const r = await fn();
      if (ok) setMsg({ ok: true, text: ok });
      const record = (r as { record?: GoLiveRecord })?.record;
      if (record) setDraft(record);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy("");
      void reload();
    }
  }
  const save = (patch: Partial<GoLiveRecord>, ok = "Saved") => act("save", async () => setDraft(await api<GoLiveRecord>(`/api/golive/${site.id}`, { method: "PUT", json: patch })), ok);
  const post = (path: string, json?: unknown, ok?: string, key = path) => act(key, () => api(`/api/golive/${site.id}${path}`, { method: "POST", json: json ?? {} }), ok);
  const Btn = ({ k, onClick, children, kind = "btn-white", disabled }: { k: string; onClick: () => void; children: ReactNode; kind?: string; disabled?: boolean }) => (
    <button type="button" className={`btn ${kind} btn-sm`} disabled={Boolean(busy) || running || disabled} onClick={onClick}>{busy === k ? <Loader2 className="spin" /> : null}{children}</button>
  );

  const checks = rec.checks;
  const fails = checks.filter((c) => c.status === "fail").length;
  const groups = [...new Set(checks.map((c) => c.group))];
  const human = data.human;
  const humanDone = human.filter((h) => rec.human[h.id]?.done).length;
  const dupJobs = wp ? Object.entries(wp.jobs).filter(([, v]) => v.length > 1) : [];

  return (
    <>
      {msg && <div className={`banner${msg.ok ? "" : " err"}`} style={msg.ok ? { background: "#eaf4ee", color: "#2f6f4a" } : undefined}>{msg.ok ? <CheckCircle2 /> : <XCircle />}{msg.text}</div>}
      {job && (
        <div className={`banner${job.error ? " err" : ""}`} style={!job.error ? { background: "var(--surface-2, #f4f1ef)", color: "var(--ink)" } : undefined}>
          {job.finishedAt ? (job.error ? <XCircle /> : <CheckCircle2 />) : <Loader2 className="spin" />}
          <span><b>{job.kind}</b>: {job.error ?? job.note}{job.finishedAt ? ` · ${timeAgo(job.finishedAt)}` : ""}</span>
        </div>
      )}

      {/* ---------- Summary + checks ---------- */}
      <Section icon={<ShieldCheck />} title="Go-live checks" sub={rec.checkedAt ? `${fails ? `${fails} failing` : "Zero failures"} · ${checks.filter((c) => c.status === "pass").length} passing · checked ${timeAgo(rec.checkedAt)}` : "Security, SEO, cookies, SSL, DNS, mail, redirects and backups, measured from outside"}
        right={<Btn k="checks" kind="btn-ink" onClick={() => post("/checks")}><Play />{rec.checkedAt ? "Run again" : "Run checks"}</Btn>}>
        {!checks.length && <p className="muted">Run the checks before cutover to see what's left, and again straight after: the site isn't live until this reads zero failures.</p>}
        {checks.length > 0 && (
          <label className="golive-check golive-toggle"><input type="checkbox" checked={showPassing} onChange={(e) => setShowPassing(e.target.checked)} /> Show passing checks too</label>
        )}
        {groups.filter((g) => showPassing || checks.some((c) => c.group === g && c.status !== "pass")).map((g) => (
          <div key={g} className="check-group">
            <h5>{g}</h5>
            {checks.filter((c: GoLiveCheck) => c.group === g && (showPassing || c.status !== "pass")).map((c) => (
              <div key={c.id} className={`check-item ${c.status}`}>
                <span className="check-ico">{ico(c.status)}</span>
                <div><b>{c.label}</b><small className="muted">{c.detail}</small></div>
                <span />
              </div>
            ))}
          </div>
        ))}
      </Section>

      {/* ---------- Project record ---------- */}
      <Section icon={<Server />} title="Project" sub="Where the site is going, and whose account it is. Getting the account wrong costs a day.">
        <div className="golive-grid">
          <L label="Live domain"><input className="input" value={draft.domain} onChange={(e) => setDraft({ ...draft, domain: e.target.value })} placeholder="example.co.uk" /></L>
          <L label="Old site (for redirects)"><input className="input" value={draft.oldSiteUrl} onChange={(e) => setDraft({ ...draft, oldSiteUrl: e.target.value })} placeholder={`https://${draft.domain || "example.com"}`} /></L>
          <L label="Hosting provider"><input className="input" value={draft.hosting.provider} onChange={(e) => setDraft({ ...draft, hosting: { ...draft.hosting, provider: e.target.value } })} placeholder="e.g. CastleHost (reseller)" /></L>
          <L label="Hosting account (username)"><input className="input mono" value={draft.hosting.account} onChange={(e) => setDraft({ ...draft, hosting: { ...draft.hosting, account: e.target.value } })} placeholder="e.g. bgcupcakes" /></L>
          <L label="New host IP"><input className="input mono" value={draft.hosting.newIp} onChange={(e) => setDraft({ ...draft, hosting: { ...draft.hosting, newIp: e.target.value } })} placeholder="203.0.113.10" /></L>
          <L label="Build track">
            <select className="input" value={draft.track} onChange={(e) => setDraft({ ...draft, track: e.target.value as GoLiveRecord["track"] })}>
              <option value="">Not recorded</option>
              <option value="A">A · Studio Elementor build</option>
              <option value="B">B · Existing or custom theme, no builder</option>
            </select>
          </L>
          <L label="Notes" wide><textarea className="input" rows={2} value={draft.hosting.notes} onChange={(e) => setDraft({ ...draft, hosting: { ...draft.hosting, notes: e.target.value } })} placeholder="Staging URL, panel address, anything the next person needs" /></L>
        </div>
        <label className="golive-check"><input type="checkbox" checked={draft.hosting.clientOwns} onChange={(e) => setDraft({ ...draft, hosting: { ...draft.hosting, clientOwns: e.target.checked } })} /> I've confirmed this is the client's own hosting account, not ours or another client's</label>
        <div className="golive-actions"><Btn k="save" kind="btn-ink" onClick={() => save({ domain: draft.domain, oldSiteUrl: draft.oldSiteUrl, hosting: draft.hosting, track: draft.track })}><Save />Save</Btn></div>
      </Section>

      {/* ---------- WordPress kit ---------- */}
      <Section icon={<Wrench />} title="WordPress go-live kit" sub={wp ? `${wp.server || "Server unknown"}${wp.litespeed ? " (LiteSpeed)" : ""} · theme ${wp.theme.name}${wp.elementor ? ` · Elementor ${wp.elementor}` : ""} · read ${timeAgo(rec.wpCheckedAt)}` : "Reads what's installed, then sets up backups, SMTP, security and the rest in one go"}
        right={<Btn k="/wp" onClick={() => post("/wp", {}, "Read the site's setup")}><Globe />Read site</Btn>}>
        {wp && (
          <dl className="fields golive-facts">
            <div className="field"><dt>One per job</dt><dd>{dupJobs.length ? <span className="bad">{dupJobs.map(([k, v]) => `${k}: ${v.join(" + ")}`).join("; ")}</span> : Object.entries(wp.jobs).map(([k, v]) => `${k}: ${v[0] ?? "none"}`).join(" · ")}</dd></div>
            <div className="field"><dt>Backups</dt><dd>{wp.updraft.active ? `UpdraftPlus · files ${wp.updraft.files}, database ${wp.updraft.db} · ${wp.updraft.remote.length ? `stored in ${wp.updraft.remote.join(", ")}` : "no remote storage"}${wp.updraft.last ? ` · last ${day(wp.updraft.last.at)} ${wp.updraft.last.success ? "complete" : "with errors"}` : " · none yet"}` : "UpdraftPlus not installed"}</dd></div>
            <div className="field"><dt>Mail</dt><dd>{wp.smtp.connections.length ? wp.smtp.connections.map((c) => `${c.from} via ${c.host || c.provider}`).join(", ") : "PHP mail() (no SMTP)"}</dd></div>
            <div className="field"><dt>Admin email</dt><dd>{wp.admin_email}{wp.mu.admin ? " (pinned)" : ""} · your user: {wp.user_email}</dd></div>
            <div className="field"><dt>Hardening</dt><dd>{wp.mu.security ? "Security mu-plugin" : "No security mu-plugin"} · {wp.security_rules ? ".htaccess rules" : "no .htaccess rules"} · WebP {wp.webp.rules ? "served" : "not served"}{wp.webp.server_can ? "" : " (server can't write WebP)"} · llms.txt {wp.llms ? "on" : "off"}</dd></div>
            <div className="field"><dt>Staging</dt><dd>{wp.http_auth ? "Password protected" : "No HTTP password"} · {wp.blog_public ? "search engines allowed" : "search engines discouraged"}</dd></div>
          </dl>
        )}
        <div className="golive-kit">
          {KIT.map((k) => (
            <label key={k.id} className="golive-check">
              <input type="checkbox" checked={kit.includes(k.id)} onChange={(e) => setKit(e.target.checked ? [...kit, k.id] : kit.filter((x) => x !== k.id))} />
              <span><b>{k.label}</b><small className="muted">{k.id === "admin" ? (setup.agencyAdminEmail ? `${setup.agencyAdminEmail}. ${k.hint}` : <>Set it in <Link to="/settings/integrations">Settings → Integrations</Link> first</>) : k.hint}</small></span>
            </label>
          ))}
        </div>
        <div className="golive-grid">
          <L label="Form messages go to"><input className="input" type="email" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder={`hello@${rec.domain || "client.com"}`} /></L>
          <label className="golive-check" style={{ alignSelf: "end" }}><input type="checkbox" checked={userEmail} onChange={(e) => setUserEmail(e.target.checked)} /> Also change my WordPress user's email to the agency address</label>
        </div>
        <div className="golive-actions"><Btn k="/kit" kind="btn-ink" disabled={!kit.length} onClick={() => post("/kit", { steps: kit, userEmail, formRecipient: recipient }, "Setting up the kit…")}><Wrench />Run the kit</Btn></div>
        {rec.kitLog && (
          <ul className="golive-log">
            {rec.kitLog.steps.map((st) => <li key={st.id}>{st.ok ? <CheckCircle2 className="ok" /> : <XCircle className="bad" />}{st.note}</li>)}
          </ul>
        )}
      </Section>

      {/* ---------- Mail ---------- */}
      <Section icon={<Mail />} title="Email" sub="Site mail must go through authenticated SMTP on the client's own domain. Once the site moves, plain PHP mail fails SPF.">
        <div className="golive-grid">
          <L label="Send as"><input className="input" type="email" value={smtp.from} onChange={(e) => setSmtp({ ...smtp, from: e.target.value })} placeholder={`website@${rec.domain || "client.com"}`} /></L>
          <L label="SMTP host"><input className="input mono" value={smtp.host} onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} /></L>
          <L label="Port and security">
            <select className="input" value={`${smtp.port}/${smtp.encryption}`} onChange={(e) => { const [p, enc] = e.target.value.split("/"); setSmtp({ ...smtp, port: Number(p), encryption: enc }); }}>
              <option value="465/ssl">465 · SSL</option>
              <option value="587/tls">587 · STARTTLS</option>
              <option value="25/none">25 · none</option>
            </select>
          </L>
          <L label="Username"><input className="input" value={smtp.username} onChange={(e) => setSmtp({ ...smtp, username: e.target.value })} placeholder={smtp.from || "Usually the address"} autoComplete="off" /></L>
          <L label="Mailbox password"><input className="input mono" type="password" value={smtp.password} onChange={(e) => setSmtp({ ...smtp, password: e.target.value })} placeholder={rec.smtp.savedAt ? "Saved on the site" : ""} autoComplete="new-password" /></L>
        </div>
        <div className="golive-actions">
          <Btn k="smtp" onClick={() => act("smtp", () => api(`/api/golive/${site.id}/smtp`, { method: "POST", json: smtp }), "FluentSMTP is set up. Now run the delivery test.")}><Save />Save to FluentSMTP</Btn>
          <Btn k="/mailtest" kind="btn-ink" onClick={() => post("/mailtest", {}, "Sending a test through the site…")}><Send />Delivery test</Btn>
          <span className="muted golive-note">{setup.imap ? "Reads the QA inbox and checks SPF and DKIM." : <>Sends to {setup.qaEmail || "your QA email"}. <Link to="/settings/integrations">Connect a QA inbox</Link> to read the result automatically.</>}</span>
        </div>
        {rec.mailTest && (
          <p className={`golive-result ${rec.mailTest.received && rec.mailTest.spf === "pass" ? "ok" : rec.mailTest.received === false || !rec.mailTest.sent ? "bad" : "warn"}`}>
            {ico(rec.mailTest.received && rec.mailTest.spf === "pass" ? "pass" : rec.mailTest.received === false || !rec.mailTest.sent ? "fail" : "warn")}<span>{rec.mailTest.detail} <span className="muted">· {timeAgo(rec.mailTest.at)}</span></span>
          </p>
        )}
      </Section>

      {/* ---------- DNS ---------- */}
      <Section icon={<CloudCog />} title="DNS and cutover (Cloudflare)" sub={setup.cloudflare ? (data.snapshot ? `Snapshot of ${data.snapshot.count} records from ${day(data.snapshot.at)} · rollback restores it` : "Take a snapshot first: it's what rollback restores") : <>Add a Cloudflare API token in <Link to="/settings/integrations">Settings → Integrations</Link> (Zone Read, DNS Edit)</>}>
        <ol className="golive-steps">
          <li><div><b>Snapshot the zone</b><small className="muted">Records the current A and www values for rollback, and a full export.</small></div>
            <span className="golive-row"><Btn k="/dns/snapshot" disabled={!setup.cloudflare} onClick={() => post("/dns/snapshot", {}, "Snapshot saved")}><Camera />Snapshot</Btn>{data.snapshot && <a className="btn btn-chip btn-sm" href={`/api/golive/${site.id}/dns/snapshot.zone`}><Download />.zone</a>}</span></li>
          <li><div><b>Mail records to DNS only</b><small className="muted">mail., smtp., imap., webmail., autodiscover. and MX targets. Cloudflare only proxies web traffic.</small></div>
            <Btn k="/dns/mail" disabled={!setup.cloudflare} onClick={() => post("/dns/mail", {}, "Mail records checked")}><Mail />Fix mail records</Btn></li>
          <li><div><b>Create old.{rec.domain}</b><small className="muted">Points at the current host so the outgoing site stays reachable. The old host must answer for it too.</small></div>
            <Btn k="/dns/old" disabled={!setup.cloudflare || !data.snapshot} onClick={() => post("/dns/old", {}, `old.${rec.domain} created`)}><Globe />Create</Btn></li>
          <li><div><b>Cut over: A and www only</b><small className="muted">Mail, MX and TXT are left alone.</small></div>
            <span className="golive-row">
              <input className="input mono" style={{ width: 150 }} value={ip} onChange={(e) => setIp(e.target.value)} placeholder="New host IP" aria-label="New host IP" />
              <Btn k="/dns/cutover" kind="btn-accent" disabled={!setup.cloudflare || !data.snapshot || !ip} onClick={() => { if (confirm(`Point ${rec.domain} and www at ${ip}? Visitors start reaching the new host within minutes.`)) void post("/dns/cutover", { confirm: true, newIp: ip }, "Cut over. Now take the staging password off and run the checks."); }}><ArrowRightLeft />Cut over</Btn>
            </span></li>
          <li><div><b>Take staging protection off</b><small className="muted">Removes the HTTP password (a backup of .htaccess is kept) and unticks “Discourage search engines”.</small></div>
            <Btn k="/live" onClick={() => { if (confirm("Remove the staging password and allow search engines on this WordPress?")) void post("/live", { index: true, removeAuth: true }, "Staging protection removed. Run the checks now."); }}><Rocket />Go live</Btn></li>
          <li><div><b>If anything fails, roll back</b><small className="muted">Puts the root and www back exactly as the snapshot had them.</small></div>
            <Btn k="/dns/rollback" disabled={!setup.cloudflare || !data.snapshot} onClick={() => { if (confirm(`Put ${rec.domain} and www back to the old host?`)) void post("/dns/rollback", { confirm: true }, "Rolled back"); }}><Undo2 />Roll back</Btn></li>
        </ol>
        <div className="golive-actions">
          <Btn k="plan" onClick={() => act("plan", async () => setPlan(await fetch(`/api/golive/${site.id}/plan`).then((r) => r.text())))}><FileText />Transfer plan</Btn>
          {plan && <a className="btn btn-chip btn-sm" href={`/api/golive/${site.id}/plan?download=1`}><Download />Download .md</a>}
        </div>
        {plan && <pre className="golive-plan">{plan}</pre>}
        {rec.cloudflare.log.length > 0 && (
          <details className="golive-details"><summary>DNS change log ({rec.cloudflare.log.length})</summary>
            <ul className="golive-log">{rec.cloudflare.log.slice(0, 40).map((l, i) => <li key={i}><span className="muted mono">{l.at.slice(0, 16).replace("T", " ")}</span> {l.text}</li>)}</ul>
          </details>
        )}
      </Section>

      {/* ---------- Redirects ---------- */}
      <Section icon={<ArrowRightLeft />} title="Redirects from the old site" sub={rec.redirects.length ? `${rec.redirects.length} old URLs → new pages${rec.redirectsPushedAt ? ` · on the site since ${day(rec.redirectsPushedAt)}` : " · not pushed yet"}` : "Lists every URL on the old site and pairs it with the closest new page (301)"}
        right={<span className="golive-row">
          <Btn k="/redirects/build" disabled={!rec.oldSiteUrl} onClick={() => post("/redirects/build", {}, "Crawling the old site…")}><Play />{rec.redirects.length ? "Rebuild" : "Build map"}</Btn>
          <Btn k="push" kind="btn-ink" disabled={!rec.redirects.length} onClick={() => act("push", async () => {
            await api(`/api/golive/${site.id}`, { method: "PUT", json: { redirects: draft.redirects } });
            return api(`/api/golive/${site.id}/redirects/push`, { method: "POST" });
          }, "Redirects are live on the new site (they only apply where a page would otherwise 404).")}><Send />Save and push</Btn>
        </span>}>
        {!rec.oldSiteUrl && <p className="muted">Enter the old site's address under Project first.</p>}
        {draft.redirects.length > 0 && (
          <div className="table-wrap"><table className="table golive-redirects">
            <thead><tr><th>Old URL</th><th>Goes to</th><th /></tr></thead>
            <tbody>
              {draft.redirects.map((r, i) => (
                <tr key={r.from}>
                  <td className="mono">{r.from}{r.note && <small className="muted">{r.note}</small>}</td>
                  <td><input className="input mono" value={r.to} aria-label={`Redirect target for ${r.from}`} onChange={(e) => setDraft({ ...draft, redirects: draft.redirects.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)) })} /></td>
                  <td><button type="button" className="btn btn-chip btn-xs" onClick={() => setDraft({ ...draft, redirects: draft.redirects.filter((_, j) => j !== i) })}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Section>

      {/* ---------- People ---------- */}
      <Section icon={<CheckCircle2 />} title="Checks only a person can judge" sub={`${humanDone} of ${human.length} done`}>
        {human.map((h) => {
          const done = Boolean(rec.human[h.id]?.done);
          return (
            <div key={h.id} className={`check-item ${done ? "done" : "todo"}`}>
              <span className="check-ico">{ico(done ? "done" : "todo")}</span>
              <div><b>{h.label}</b><small className="muted">{done ? `Done ${day(rec.human[h.id].at)}` : h.hint}</small></div>
              <button type="button" className="btn btn-chip btn-xs" disabled={Boolean(busy)} onClick={() => save({ human: { [h.id]: { done: !done, note: "", at: "" } } }, done ? "Unticked" : "Ticked off")}>{done ? "Undo" : "Mark done"}</button>
            </div>
          );
        })}
        <div className="check-item">
          <span className="check-ico">{ico(rec.restoreTest ? "done" : "todo")}</span>
          <div><b>A backup has been restored once, somewhere else</b><small className="muted">{rec.restoreTest ? `Recorded ${day(rec.restoreTest.at)}${rec.restoreTest.note ? `: ${rec.restoreTest.note}` : ""}` : "An untested backup is not a backup. Restore one to staging, then record it."}</small></div>
          <button type="button" className="btn btn-chip btn-xs" disabled={Boolean(busy)} onClick={() => {
            if (rec.restoreTest) return void save({ restoreTest: null }, "Cleared");
            const note = prompt("Where was it restored, and did everything come back? (e.g. “UpdraftPlus 3 Oct backup to staging, all pages and forms fine”)");
            if (note !== null) void save({ restoreTest: { at: new Date().toISOString(), note } }, "Restore test recorded");
          }}>{rec.restoreTest ? "Undo" : "Record"}</button>
        </div>
        <div className="check-item">
          <span className="check-ico">{ico(rec.gsc.sitemapSubmittedAt ? "done" : "todo")}</span>
          <div><b>Sitemap submitted in Google Search Console</b><small className="muted">{rec.gsc.sitemapSubmittedAt ? `Submitted ${day(rec.gsc.sitemapSubmittedAt)}` : <>Verify the domain property, then submit <span className="mono">https://{rec.domain}/wp-sitemap.xml</span> (or your SEO plugin's sitemap).</>}</small></div>
          <span className="golive-row">
            <a className="btn btn-chip btn-xs" href={`https://search.google.com/search-console/sitemaps?resource_id=sc-domain:${rec.domain}`} target="_blank" rel="noreferrer">Open</a>
            <button type="button" className="btn btn-chip btn-xs" disabled={Boolean(busy)} onClick={() => save({ gsc: { ...rec.gsc, sitemapSubmittedAt: rec.gsc.sitemapSubmittedAt ? "" : new Date().toISOString() } })}>{rec.gsc.sitemapSubmittedAt ? "Undo" : "Mark done"}</button>
          </span>
        </div>
      </Section>

      {/* ---------- Domain ---------- */}
      <Section icon={<Globe />} title="Domain" sub="No urgency, but schedule the transfer well before expiry"
        right={<Btn k="lookup" onClick={() => act("lookup", async () => setDraft(await api<GoLiveRecord>(`/api/golive/${site.id}/domain/lookup`, { method: "POST" })), "Looked up at the registry")}><Globe />Look up</Btn>}>
        <div className="golive-grid">
          <L label="Registrar"><input className="input" value={draft.domainInfo.registrar} onChange={(e) => setDraft({ ...draft, domainInfo: { ...draft.domainInfo, registrar: e.target.value } })} /></L>
          <L label="Expires"><input className="input" type="date" value={draft.domainInfo.expires.slice(0, 10)} onChange={(e) => setDraft({ ...draft, domainInfo: { ...draft.domainInfo, expires: e.target.value } })} /></L>
          <L label="Transfer method">
            <select className="input" value={draft.domainInfo.transfer} onChange={(e) => setDraft({ ...draft, domainInfo: { ...draft.domainInfo, transfer: e.target.value as GoLiveRecord["domainInfo"]["transfer"] } })}>
              <option value="">Not decided</option>
              <option value="not-needed">Not moving</option>
              <option value="ips-tag">IPS tag (.uk)</option>
              <option value="auth-code">Auth (EPP) code</option>
            </select>
          </L>
          {draft.domainInfo.transfer === "ips-tag" && <L label="New registrar's IPS tag"><input className="input mono" value={draft.domainInfo.ipsTag} onChange={(e) => setDraft({ ...draft, domainInfo: { ...draft.domainInfo, ipsTag: e.target.value.toUpperCase() } })} /></L>}
          {draft.domainInfo.transfer === "auth-code" && <label className="golive-check" style={{ alignSelf: "end" }}><input type="checkbox" checked={draft.domainInfo.authCodeReceived} onChange={(e) => setDraft({ ...draft, domainInfo: { ...draft.domainInfo, authCodeReceived: e.target.checked } })} /> Auth code received (keep it out of the app)</label>}
          <L label="Notes" wide><input className="input" value={draft.domainInfo.notes} onChange={(e) => setDraft({ ...draft, domainInfo: { ...draft.domainInfo, notes: e.target.value } })} /></L>
        </div>
        {/\.uk$/.test(rec.domain) && draft.domainInfo.transfer === "auth-code" && <p className="golive-result warn"><AlertTriangle className="warn" />.uk domains move by IPS tag, not an auth code.</p>}
        <div className="golive-actions"><Btn k="save" kind="btn-ink" onClick={() => save({ domainInfo: draft.domainInfo })}><Save />Save</Btn></div>
      </Section>
    </>
  );
}

import { join } from "node:path";
import { newContext } from "../pipeline/browser.ts";
import { extractJson, runClaude } from "../claude/runner.ts";
import type { QaConsistency, QaForm, QaIssue, QaResult } from "../../shared/types.ts";
import { UA } from "./crawl.ts";

const TEST_TEXT = "Automated post-launch form test from Studio QA. Please ignore this message.";

interface PageText {
  url: string;
  text: string;
  phones: string[];
  emails: string[];
  candidates: string[]; // lines likely to contain addresses / hours / names
}

/** Visit every page: collect forms, visible copy and contact details. */
export async function scanPages(urls: string[]): Promise<{ forms: QaForm[]; texts: PageText[]; links: { page: string; href: string }[] }> {
  const ctx = await newContext({ userAgent: UA });
  const forms: QaForm[] = [];
  const texts: PageText[] = [];
  const links: { page: string; href: string }[] = [];
  try {
    const page = await ctx.newPage();
    for (const url of urls) {
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 40000 });
      } catch {
        continue;
      }
      const r = await page.evaluate(() => {
        const visible = (el: Element) => {
          const s = getComputedStyle(el);
          const b = el.getBoundingClientRect();
          return s.display !== "none" && s.visibility !== "hidden" && b.width > 0 && b.height > 0;
        };
        const forms = Array.from(document.querySelectorAll("form")).map((f, index) => ({ f, index }))
          .filter(({ f }) => visible(f) && !f.matches('[role=search], .search-form, form[action*="?s="]') && !f.querySelector('input[name="s"]'))
          .map(({ f, index }) => ({
            index,
            name: f.getAttribute("name") || f.getAttribute("aria-label") || f.id || f.className.toString().split(" ")[0] || "form",
            captcha: !!f.querySelector('.g-recaptcha, [data-sitekey], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .cf-turnstile'),
            fields: Array.from(f.querySelectorAll<HTMLInputElement>("input, textarea, select"))
              .filter((i) => !["hidden", "submit", "button"].includes(i.type))
              .map((i) => ({
                name: i.name || i.id,
                type: i.tagName === "INPUT" ? i.type : i.tagName.toLowerCase(),
                label: (i.labels?.[0]?.textContent || i.placeholder || i.getAttribute("aria-label") || i.name || "").trim().slice(0, 60),
                required: i.required || i.getAttribute("aria-required") === "true",
              })),
          }));
        const blocks = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,td,th,dt,dd,blockquote,figcaption,label,button,a,span,address"))
          .filter((el) => visible(el) && !el.closest("script,style,noscript") && !Array.from(el.children).some((c) => /^(P|LI|H[1-6]|DIV|UL)$/.test(c.tagName)))
          .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
          .filter((t) => t.length > 1);
        const text = [...new Set(blocks)].join("\n");
        const hrefs = Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href") || "");
        const tel = hrefs.filter((h) => h.startsWith("tel:")).map((h) => decodeURIComponent(h.slice(4)));
        const mail = hrefs.filter((h) => h.startsWith("mailto:")).map((h) => decodeURIComponent(h.slice(7).split("?")[0]));
        return { forms, text, tel, mail, hrefs: Array.from(document.querySelectorAll("a[href]")).map((a) => (a as HTMLAnchorElement).href) };
      });
      r.forms.forEach((f) => forms.push({ page: url, ...f }));
      const phones = [...new Set([...r.tel, ...(r.text.match(/(?:\+|00)?\d[\d\s().-]{7,}\d/g) ?? [])].map((p) => p.trim()))];
      const emails = [...new Set([...r.mail, ...(r.text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [])].map((e) => e.toLowerCase()))];
      const candidates = r.text.split("\n").filter((l) => /\d/.test(l) && /(street|str\.|straat|weg|laan|plein|road|ave|avenue|suite|\b\d{4}\s?[a-z]{2}\b|\b\d{5}\b|mon|tue|wed|thu|fri|sat|sun|ma|di|wo|do|vr|za|zo|open|am\b|pm\b|uur)/i.test(l)).slice(0, 40);
      texts.push({ url, text: r.text.slice(0, 20000), phones, emails, candidates });
      for (const href of new Set(r.hrefs)) if (/^https?:/.test(href)) links.push({ page: url, href: href.split("#")[0] });
    }
  } finally {
    await ctx.close();
  }
  return { forms, texts, links };
}

/** Fill a form with obvious test data, submit it and read what the page says back. */
export async function testForm(form: QaForm, email: string, shotDir: string, opts: { url?: string; cookies?: { name: string; value: string; url: string }[]; shotTag?: string } = {}): Promise<QaForm["test"]> {
  if (form.captcha) return { at: new Date().toISOString(), ok: null, detail: "Protected by a CAPTCHA, so it can't be tested automatically. Test it by hand once." };
  const ctx = await newContext({ userAgent: UA });
  try {
    if (opts.cookies?.length) await ctx.addCookies(opts.cookies);
    const page = await ctx.newPage();
    await page.goto(opts.url ?? form.page, { waitUntil: "networkidle", timeout: 40000 });
    const f = page.locator("form").nth(form.index);
    // Ofcom's reserved drama range for UK sites, a Dutch mobile format otherwise.
    const ukSite = /\.uk\//i.test(form.page) || (await page.locator("html").getAttribute("lang"))?.toLowerCase() === "en-gb" || /\+44|\b0[1-37]\d{2,3} ?\d{3} ?\d{3,4}\b/.test(await page.locator("body").innerText().catch(() => ""));
    const statuses: number[] = [];
    page.on("response", (r) => {
      if (r.request().method() === "POST") statuses.push(r.status());
    });
    for (const field of await f.locator("input, textarea, select").all()) {
      const type = ((await field.getAttribute("type")) || (await field.evaluate((e) => e.tagName.toLowerCase()))).toLowerCase();
      if (["hidden", "submit", "button", "file"].includes(type) || !(await field.isVisible())) continue;
      const name = ((await field.getAttribute("name")) || "").toLowerCase();
      if (type === "select") {
        const opts = await field.locator("option").all();
        if (opts.length > 1) await field.selectOption({ index: 1 });
      } else if (type === "checkbox" || type === "radio") {
        if (!(await field.isChecked())) await field.check({ force: true }).catch(() => {});
      } else if (type === "email" || /mail/.test(name)) await field.fill(email);
      else if (type === "tel" || /phone|tel/.test(name)) await field.fill(ukSite ? "07700 900123" : "0612345678");
      else if (type === "number") await field.fill("1");
      else if (type === "date") await field.fill(new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10));
      else if (/date|when/.test(name)) await field.fill(new Date(Date.now() + 14 * 86400000).toLocaleDateString(ukSite ? "en-GB" : "nl-NL"));
      else if (type === "url") await field.fill("https://example.org");
      else if (type === "textarea") await field.fill(TEST_TEXT);
      else await field.fill(/name/.test(name) ? "Studio QA Test" : "Studio QA test");
    }
    const submit = f.locator('button[type=submit], input[type=submit], button:not([type]), .elementor-button[type=submit]').first();
    await submit.click({ timeout: 8000 });
    await page.waitForTimeout(6000);
    const out = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('.wpcf7-response-output, .elementor-message, .gform_confirmation_message, .wpforms-confirmation-container, [role=alert], [role=status], .success, .error, .form-message'));
      return nodes.map((n) => (n.textContent || "").trim()).filter(Boolean).join(" | ").slice(0, 300);
    });
    const shot = join(shotDir, `form-${opts.shotTag ?? ""}${Buffer.from(form.page).toString("base64url").slice(-24)}-${form.index}.png`);
    await f.screenshot({ path: shot }).catch(() => page.screenshot({ path: shot }));
    const good = /thank|success|sent|received|bedankt|verzonden|ontvangen|we.?ll be in touch/i.test(out);
    const bad = /error|fail|invalid|required|problem|went wrong|sorry|try again|unable|(did|could|was) ?n.?o?t (be )?sen[dt]|couldn.?t|mislukt|verplicht|ongeldig|niet verzonden/i.test(out) || statuses.some((s) => s >= 400);
    return {
      at: new Date().toISOString(),
      ok: good && !bad ? true : bad ? false : null,
      detail: out || (statuses.length ? `Submitted (HTTP ${statuses.join(", ")}) but the page showed no confirmation message` : "Nothing happened after clicking submit"),
      shot,
    };
  } catch (e) {
    return { at: new Date().toISOString(), ok: false, detail: `Couldn't complete the test: ${(e as Error).message.split("\n")[0]}` };
  } finally {
    await ctx.close();
  }
}

/** Status of every internal link (and external ones, capped). */
export async function checkLinks(links: { page: string; href: string }[], origin: string) {
  const unique = new Map<string, string>();
  for (const l of links) if (!unique.has(l.href)) unique.set(l.href, l.page);
  const internal = [...unique.keys()].filter((h) => h.startsWith(origin));
  const external = [...unique.keys()].filter((h) => !h.startsWith(origin) && !/facebook|instagram|linkedin|twitter|x\.com|tiktok|youtube/.test(h)).slice(0, 40);
  const out: QaResult["links"] = [];
  const check = async (href: string) => {
    try {
      let r = await fetch(href, { method: "HEAD", redirect: "follow", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
      if (r.status === 405 || r.status === 403) r = await fetch(href, { redirect: "follow", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
      if (r.status >= 400) out.push({ page: unique.get(href)!, href, status: r.status });
    } catch (e) {
      out.push({ page: unique.get(href)!, href, status: (e as Error).name === "TimeoutError" ? "timeout" : "unreachable" });
    }
  };
  const all = [...internal, ...external];
  for (let i = 0; i < all.length; i += 6) await Promise.all(all.slice(i, i + 6).map(check));
  return out;
}

const PROOF_SYSTEM = "You are a meticulous proofreader for business websites. You flag real mistakes only. You never flag brand names, product names, people's names, addresses or intentional stylistic choices. You detect the page language and proofread in that language.";

/** Spelling, grammar and wrong-detail review, batched by page. */
export async function proofread(siteId: string, cwd: string, texts: PageText[]): Promise<QaIssue[]> {
  const issues: QaIssue[] = [];
  let batch: PageText[] = [];
  let size = 0;
  const flush = async () => {
    if (!batch.length) return;
    const res = await runClaude({
      leadId: siteId, task: "seo", cwd, system: PROOF_SYSTEM,
      prompt: `Proofread these pages. Flag spelling mistakes, grammar errors, broken punctuation, and wrong or odd details (for example a year in the future, a sentence cut off, the same service described with different prices, or leftover template text).

${batch.map((p) => `=== PAGE ${p.url} ===\n${p.text}`).join("\n\n")}

Return only JSON:
\`\`\`json
[{"page":"<url>","type":"spelling|grammar|punctuation|wrong-detail","text":"<the exact wrong fragment, copied verbatim>","suggestion":"<corrected fragment>","reason":"<short why>"}]
\`\`\`
Return [] if a page is clean.`,
    });
    try {
      issues.push(...extractJson<QaIssue[]>(res.text).filter((i) => i && i.text && i.page));
    } catch {
      /* unparseable batch: skip rather than invent */
    }
    batch = [];
    size = 0;
  };
  for (const t of texts) {
    if (size + t.text.length > 24000) await flush();
    batch.push({ ...t, text: t.text.slice(0, 24000) });
    size += t.text.length;
  }
  await flush();
  // Keep only fragments that really appear on the page.
  return issues.filter((i) => texts.find((t) => t.url === i.page)?.text.includes(i.text));
}

/** Cross-page consistency of contact details, names and hours. */
export async function consistency(siteId: string, cwd: string, texts: PageText[]): Promise<QaConsistency[]> {
  const table = texts.map((t) => `=== ${t.url}\nphones: ${t.phones.join(" ; ") || "-"}\nemails: ${t.emails.join(" ; ") || "-"}\naddress/hours lines:\n${t.candidates.map((c) => "  " + c).join("\n") || "  -"}\nfirst lines: ${t.text.split("\n").slice(0, 6).join(" / ")}`).join("\n\n");
  const res = await runClaude({
    leadId: siteId, task: "seo", cwd,
    system: "You audit websites for inconsistent business details across pages. You compare values carefully, and you treat formatting-only differences (+31 10 322 0207 vs 010-3220207) as consistent.",
    prompt: `Here are the contact details and key lines found on each page of one business website.

${table}

Group the details by kind (phone, email, address, name, hours, social, other). For each group, list every distinct value with the pages it appears on, and decide whether the site is consistent. Flag real contradictions: a different phone number or email on one page, two different addresses for the same location, different opening hours, the business name spelled differently, an email on a different domain than the website, and so on.

Return only JSON:
\`\`\`json
[{"kind":"phone","verdict":"consistent|inconsistent","values":[{"value":"…","pages":["…"]}],"note":"…"}]
\`\`\``,
  });
  try {
    return extractJson<QaConsistency[]>(res.text);
  } catch {
    return [];
  }
}

// Read-only checks of the maintenance helpers against a live site: npx tsx scripts/care-selftest.ts https://example.com
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gatherIntel, phpSupport, affects, cmpVersion } from "../server/care/intel.ts";
import { sslInfo, domainInfo, dirListing, registrable } from "../server/care/health.ts";
import { capturePages, comparePages } from "../server/care/tests.ts";
import type { CareStatus } from "../shared/types.ts";

const site = process.argv[2] ?? "https://wordpress.org";
const host = new URL(site).hostname;
const ok = (label: string, cond: boolean, detail = "") => console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` · ${detail}` : ""}`);

ok("cmpVersion", cmpVersion("4.1.3", "4.1.4") < 0 && cmpVersion("10.0", "9.9.9") > 0 && cmpVersion("6.4", "6.4.0") === 0);
ok("affects < max", affects("4.1.3", { min_version: null, min_operator: null, max_version: "4.1.4", max_operator: "lt", unfixed: "0" }));
ok("not affects at fix", !affects("4.1.4", { min_version: null, min_operator: null, max_version: "4.1.4", max_operator: "lt", unfixed: "0" }));
ok("php 8.1 eol", phpSupport("8.1.30").status === "eol");
ok("php 8.4 supported", phpSupport("8.4.2").status === "supported");
ok("registrable", registrable("www.shop.example.co.uk") === "example.co.uk" && registrable("a.b.example.com") === "example.com");

// A fake install with an old Elementor and a closed plugin: both must be flagged.
const fake = {
  core: { version: "6.4.1", update: "7.1.2", locale: "en_US" },
  env: { php: "8.1.2" },
  plugins: [
    { file: "elementor/elementor.php", slug: "elementor", name: "Elementor", version: "3.0.0", active: true, update: "4.3.0", package: true, wporg: true },
    { file: "wp-mail-bank/wp-mail-bank.php", slug: "wp-mail-bank", name: "Mail Bank", version: "4.0.0", active: true, update: "", package: false, wporg: true },
  ],
  themes: [],
} as unknown as CareStatus;
const intel = await gatherIntel(fake);
ok("vulns found for old Elementor", intel.vulns.some((v) => v.slug === "elementor"), `${intel.vulns.filter((v) => v.slug === "elementor").length} Elementor, ${intel.vulns.length} total`);
ok("core vulns for 6.4.1", intel.vulns.some((v) => v.component === "core"));
ok("closed plugin flagged", intel.abandoned.some((a) => a.slug === "wp-mail-bank" && a.reason === "closed"));
ok("PHP 8.1 marked end of life", intel.php.status === "eol");
console.log("     top:", intel.vulns.slice(0, 2).map((v) => `${v.severity} ${v.name}: ${v.title} (fixed in ${v.fixedIn})`).join(" | "));

const ssl = await sslInfo(host);
ok("SSL certificate read", Boolean(ssl?.validTo), ssl ? `${ssl.daysLeft} days, ${ssl.issuer}` : "");
const domain = await domainInfo(host);
ok("RDAP domain expiry", Boolean(domain?.expires), domain ? `${domain.expires.slice(0, 10)} ${domain.registrar}` : "(registry may not publish it)");
ok("directory listing check ran", typeof (await dirListing(site)) === "boolean");

const dir = join(tmpdir(), `care-selftest-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const a = await capturePages(site, ["/"], dir, "t-before");
const b = await capturePages(site, ["/"], dir, "t-after");
const cmp = comparePages(dir, a, b, "t");
ok("captured desktop + mobile", cmp.length === 2 && cmp.every((p) => p.before && p.after), cmp.map((p) => `${p.path} HTTP ${p.status}`).join(", "));
ok("same page twice ≈ no difference", cmp.every((p) => p.diff !== null && p.diff < 1), cmp.map((p) => `${p.diff}%`).join(", "));
ok("no PHP fatal on the page", cmp.every((p) => !p.fatal));
rmSync(dir, { recursive: true, force: true });
process.exit(0);

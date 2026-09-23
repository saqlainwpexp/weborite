export type LeadSource = "elementor" | "meta" | "manual" | "maps";
export type LeadStatus = "queued" | "running" | "ready" | "needs_review" | "failed" | "paused";
export type StepKey = "capture" | "diagnose" | "vertical" | "generate" | "gate" | "render";
export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export const STEPS: { key: StepKey; label: string; hint: string }[] = [
  { key: "capture", label: "Capture site", hint: "Screenshots, assets, brand" },
  { key: "diagnose", label: "Diagnose", hint: "Lighthouse, mobile, contrast" },
  { key: "vertical", label: "Vertical & benchmarks", hint: "Competitive register" },
  { key: "generate", label: "Generate mockup", hint: "Claude rebuild" },
  { key: "gate", label: "Quality gate", hint: "Deterministic checks" },
  { key: "render", label: "Side-by-side", hint: "Review render" },
];

export interface Step {
  key: StepKey;
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  note?: string;
}

export interface Lead {
  id: string;
  createdAt: string;
  source: LeadSource;
  name: string;
  email: string;
  phone: string;
  business: string;
  url: string;
  fields: Record<string, string>;
  vertical: string | null;
  status: LeadStatus;
  steps: Step[];
  error?: string;
  /** "scratch" = the business has no website: designed from its Google Maps listing. */
  mode?: "rebuild" | "scratch";
  prospectId?: string;
}

export interface Issue {
  severity: "high" | "medium" | "low";
  category: "mobile" | "contrast" | "performance" | "structure" | "content" | "seo";
  title: string;
  detail: string;
}

export interface Asset {
  path: string;          // relative to the lead folder, e.g. assets/hero.mp4
  sourceUrl: string;
  kind: "image" | "video" | "logo";
  width?: number;
  height?: number;
  aboveFold?: boolean;
  area?: number;         // rendered px² on desktop
}

export interface Capture {
  url: string;
  finalUrl: string;
  title: string;
  description: string;
  palette: { hex: string; weight: number; role?: string }[];
  fonts: { family: string; usage: string }[];
  logo: Asset | null;
  assets: Asset[];
  capturedAt: string;
}

export interface Fact {
  text: string;
  sourceUrl: string;
}

export interface Diagnosis {
  lighthouse: { performance: number; accessibility: number; bestPractices: number; seo: number } | null;
  issues: Issue[];
  strongestAsset: { path: string; kind: Asset["kind"]; reason: string } | null;
  brand: { primary: string; secondary?: string; accent?: string; background: string; text: string };
}

export interface GateCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface GateResult {
  pass: boolean;
  attempt: number;
  checks: GateCheck[];
}

export interface Benchmark {
  name: string;
  url: string;
  why: string;
}

export interface BenchmarkSet {
  vertical: string;
  label: string;
  register: string;       // what the buyer is evaluating
  color: string;
  sites: Benchmark[];
  createdAt: string;
}

export interface EventItem {
  id: number;
  at: string;
  leadId: string | null;
  kind: "lead" | "ready" | "review" | "failed" | "info";
  title: string;
  detail: string;
}

export type ClaudeMode = "session" | "api";

export interface Settings {
  mode: ClaudeMode;
  apiKeySet: boolean;
  generateModel: string;
  fastModel: string;
  elementorSecret: string;
  metaVerifyToken: string;
  metaPageTokenSet: boolean;
  metaAppSecretSet: boolean;
  claudePath: string;
  /** White-label profile */
  studioName: string;
  brandColor: string; // hex, drives the whole UI palette
  firstName: string;
  lastName: string;
  userName: string; // derived: first + last
  userEmail: string;
  userPhone: string;
  logoFile: string; // file name under data/brand, "" when unset
  /** Launch & SEO */
  psiKeySet: boolean;
  gtmetrixKeySet: boolean;
  qaEmail: string;
  seoChecklist: { label: string; group: string }[];
  avatarFile: string;
  /** Maintenance */
  careDay: number; // day of the month for the automatic check (1–28, 0 = off)
  careAutoStage: boolean; // also clone to staging and test updates automatically
  careDiffThreshold: number; // % of pixels allowed to change before a page needs review
  careKeepStaging: boolean; // keep the staging copy after the live update
  /** Super admin */
  currency: string; // ISO code for revenue, e.g. USD
}

export interface LeadDetail extends Lead {
  capture: Capture | null;
  diagnosis: Diagnosis | null;
  gate: GateResult | null;
  benchmarks: BenchmarkSet | null;
  hasMockup: boolean;
  hasSideBySide: boolean;
}

export interface Usage {
  mode: ClaudeMode;
  jobsToday: number;
  apiCostUsd: number;
  running: number;
  queued: number;
}

/* ---------- Lead Finder workspace ---------- */

export type SearchSource = "google_maps";
export type SearchStatus = "queued" | "searching" | "enriching" | "scoring" | "done" | "failed";

export interface FinderSearch {
  id: string;
  query: string;
  source: SearchSource;
  max: number;
  status: SearchStatus;
  found: number;
  enriched: number;
  withEmail: number;
  withWhatsapp: number;
  createdAt: string;
  finishedAt?: string;
  error?: string;
  color: string;
}

/** How WhatsApp was confirmed. "unconfirmed" means we couldn't prove it either way. */
export type WhatsappStatus = "business_profile" | "site_link" | "unconfirmed" | "no_phone" | "pending";

export interface Prospect {
  id: string;
  searchId: string;
  source: SearchSource;
  placeId: string;
  name: string;
  category: string;
  phone: string;       // E.164 when available
  website: string;
  address: string;
  rating: number | null;
  reviews: number | null;
  mapsUrl: string;
  emails: string[];
  emailPages: string[]; // where each email was found
  whatsapp: WhatsappStatus;
  whatsappName: string; // WhatsApp Business profile name, when shown
  tags: string[];       // "email", "whatsapp", "website", "no-website"
  enrichStatus: "pending" | "running" | "done" | "failed";
  enrichNote?: string;
  mockupLeadId?: string;
  fit?: ProspectFit;
  createdAt: string;
}

/** What a quick visit to the business's website found. */
export interface ProspectAudit {
  url: string;
  finalUrl: string;
  reachable: boolean;
  status: number;
  error: string;
  placeholder: string; // parked / coming soon / suspended text, when found
  blocked: boolean; // a bot check / firewall stopped the visit, so the site couldn't be judged
  https: boolean;
  sslError: boolean;
  socialOnly: string; // "Facebook page", "free Wix site"… when the "website" isn't a real site
  builder: string; // Wix, Squarespace, WordPress…
  loadMs: number | null;
  bytes: number | null;
  requests: number | null;
  mobile: { viewport: boolean; overflow: boolean; smallText: number };
  seo: { title: string; description: string; h1: number; images: number; missingAlt: number; og: boolean; schema: string[]; lang: boolean };
  contact: { tel: boolean; form: boolean; whatsapp: boolean; email: boolean };
  copyrightYear: number | null;
  oldTech: string[];
  words: number;
  shot: boolean; // desktop screenshot saved
}

export type FitGrade = "hot" | "warm" | "cold";

/** How good a prospect this business is for a new website: higher = better fit. */
export interface ProspectFit {
  status: "pending" | "running" | "done" | "failed";
  score: number;
  grade: FitGrade;
  summary: string;
  reasons: { text: string; points: number }[];
  design: { score: number; note: string } | null;
  audit: ProspectAudit | null;
  at: string;
  note?: string;
}

export interface FinderStats {
  total: number;
  withEmail: number;
  withWhatsapp: number;
  withWebsite: number;
  searches: number;
  running: number;
}

/* ---------- Builds workspace ---------- */

export type BuildStatus = "draft" | "queued" | "running" | "ready" | "needs_review" | "failed" | "paused";
export type BuildStepKey = "homepage" | "layout" | "pages" | "checks" | "package";

export const BUILD_STEPS: { key: BuildStepKey; label: string; hint: string }[] = [
  { key: "homepage", label: "Revise homepage", hint: "Apply your change requests" },
  { key: "layout", label: "Shared layout", hint: "Header, footer and styles for every page" },
  { key: "pages", label: "Write pages", hint: "One Claude pass per page" },
  { key: "checks", label: "Quality checks", hint: "Every page + site-wide links" },
  { key: "package", label: "Package", hint: "Zip ready to hand over" },
];

export interface BuildStep {
  key: BuildStepKey;
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  note?: string;
}

export interface BuildPage {
  slug: string;        // "index" for the homepage
  title: string;       // nav label + <title>
  brief: string;       // what this page should cover
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  checks: GateCheck[];
  pass: boolean | null;
  pendingChanges?: string; // a revision request waiting to run
  updatedAt?: string;
  note?: string;
}

export interface Build {
  id: string;
  leadId: string;
  business: string;
  url: string;
  status: BuildStatus;
  homepageChanges: string;
  details: string;      // project details the client sent after approval
  pages: BuildPage[];
  steps: BuildStep[];
  linkCheck: GateCheck | null;
  createdAt: string;
  error?: string;
}

export interface BuildStats {
  total: number;
  running: number;
  ready: number;
  pages: number;
}

/* ---------- WordPress workspace ---------- */

export type WpPageStatus = "pending" | "converting" | "awaiting_approval" | "approved" | "changes_requested" | "failed";
export type WpStatus = "setup" | "running" | "awaiting_approval" | "paused" | "done" | "failed";

/** A custom widget the plugin ships because a Pro widget isn't allowed. */
export interface WpCustomWidget {
  name: string;         // e.g. studio_price_table
  title: string;
  replaces: string;     // the Pro widget it stands in for
  forPage: string;
  version: number;
}

export interface WpSection {
  index: number;
  label: string;        // header, hero, services…
  status: "pending" | "converting" | "done" | "failed";
  widgets: string[];    // widget types used
  note?: string;
}

export interface WpPage {
  slug: string;
  title: string;
  status: WpPageStatus;
  sections: WpSection[];
  wpPageId: number | null;
  wpUrl: string;
  previewUrl: string;
  diff: { desktop: number | null; mobile: number | null } | null; // % of pixels that differ
  feedback?: string;
  note?: string;
  updatedAt?: string;
}

export interface WpConversion {
  id: string;
  buildId: string;
  business: string;
  siteUrl: string;
  wpUser: string;
  appPasswordSet: boolean;
  elementorPro: boolean;
  status: WpStatus;
  connected: { ok: boolean; elementor: string; pro: boolean; plugin: string; checkedAt: string } | null;
  pages: WpPage[];
  customWidgets: WpCustomWidget[];
  pluginVersion: number;
  createdAt: string;
  error?: string;
}

/* ---------- Post Launch & On-Page SEO workspace ---------- */

export type SeoPhase = "qa" | "perf" | "onpage";
export interface SeoRun { status: "running" | "done" | "failed"; startedAt: string; finishedAt?: string; note?: string }

export interface SeoSite {
  id: string;
  name: string;
  siteUrl: string;
  conversionId: string | null;   // linked WordPress conversion (shares its connector plugin)
  wpUser: string;
  appPasswordSet: boolean;
  connected: { ok: boolean; plugin: string; seoPlugin: string; checkedAt: string } | null;
  pages: { url: string; title: string }[];
  runs: Partial<Record<SeoPhase | "forms" | "fixes", SeoRun>>;
  qaSignedOff: boolean;
  createdAt: string;
  error?: string;
}

export interface QaForm {
  page: string;
  index: number;
  name: string;
  fields: { name: string; type: string; label: string; required: boolean }[];
  captcha: boolean;
  test?: { at: string; ok: boolean | null; detail: string; shot?: string };
}

export interface QaIssue {
  page: string;
  type: "spelling" | "grammar" | "punctuation" | "consistency" | "wrong-detail";
  text: string;
  suggestion: string;
  reason: string;
}

export interface QaConsistency {
  kind: "phone" | "email" | "address" | "name" | "hours" | "social" | "other";
  verdict: "consistent" | "inconsistent";
  values: { value: string; pages: string[] }[];
  note: string;
}

export interface QaResult {
  forms: QaForm[];
  issues: QaIssue[];
  consistency: QaConsistency[];
  links: { page: string; href: string; status: number | string }[];
}

export interface PerfMetrics {
  score: number;
  lcp: number; cls: number; tbt: number; fcp: number; si: number; ttfb: number;
  weight: number; requests: number;
  byType: Record<string, number>;   // bytes by resource type
}

export interface PerfPage {
  url: string;
  mobile: PerfMetrics | null;
  desktop: PerfMetrics | null;
  field: { lcp?: number; inp?: number; cls?: number; fcp?: number; ttfb?: number; category?: string; source: string } | null;
  experience: { https: boolean; viewport: boolean; mobileIssues: string[]; consoleErrors: number };
}

export interface PerfResult {
  pages: PerfPage[];
  gtmetrix: { url: string; grade: string; performance: number; structure: number; lcp: number; tbt: number; cls: number; fullyLoaded: number; bytes: number; requests: number; report: string } | { error: string } | null;
}

export interface SeoImage {
  src: string;
  page: string;
  alt: string | null;       // null = attribute missing
  bytes: number | null;
  format: string;
  width: number; height: number;       // natural
  renderedWidth: number;
  lazy: boolean;
  proposedAlt?: string;
  altApplied?: boolean;
  webp?: { status: "done" | "failed"; before: number; after: number; note?: string };
}

export interface SeoPageAudit {
  url: string;
  title: string; description: string; canonical: string; robots: string; lang: string;
  h1: string[]; headingSkips: number; wordCount: number; internalLinks: number;
  og: { title: boolean; description: boolean; image: boolean };
  schemaTypes: string[];
  proposed?: { title: string; description: string; applied?: boolean };
  schema?: { jsonld: unknown; types: string[]; errors: string[]; applied?: boolean };
}

export interface OnPageResult {
  pages: SeoPageAudit[];
  images: SeoImage[];
  site: { robotsTxt: boolean; sitemap: string; httpsRedirect: boolean; notFoundStatus: number; favicon: boolean };
}

export interface ChecklistItem {
  id: string;
  label: string;
  group: string;
  auto: boolean;
  status: "pass" | "fail" | "todo" | "done";
  detail?: string;
}

/* ---------- Maintenance (care) ---------- */

export interface CareEnv {
  wp: string;
  php: string;
  db: string;
  server: string;
  sapi: string;
  extensions: string[];
  memory_limit: string;
  wp_memory: string;
  max_exec: string;
  upload_max: string;
  locale: string;
  multisite: boolean;
  https: boolean;
  fs_method: string;
  disk_free: number | null;
  object_cache: boolean;
  debug: boolean;
  cron: boolean;
}

export interface CarePlugin {
  file: string;
  slug: string;
  name: string;
  version: string;
  active: boolean;
  update: string;
  package: boolean;
  requires_php: string;
  tested: string;
  wporg: boolean;
  auto_update: boolean;
}

export interface CareTheme {
  stylesheet: string;
  name: string;
  version: string;
  active: boolean;
  parent: boolean;
  update: string;
}

export interface CareSecurityCheck {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail" | "info";
  detail: string;
}

export interface CareStagingInfo {
  status: "none" | "scan" | "files" | "tables" | "config" | "db" | "ready" | "failed";
  url?: string;
  token?: string;
  dir?: string;
  files?: { done: number; total: number };
  tables?: { done: number; total: number };
  skip_media?: boolean;
  created_at?: number;
  ready_at?: number;
  error?: string;
}

/** What the connector's /care/status returns. */
export interface CareStatus {
  at: number;
  staging: boolean;
  home: string;
  env: CareEnv;
  core: { version: string; update: string; locale: string };
  plugins: CarePlugin[];
  themes: CareTheme[];
  translations: number;
  security: CareSecurityCheck[];
  db: { size: number; revisions: number; auto_drafts: number; trash: number; spam_comments: number; transients: number; autoload: number };
  backup: { plugins: string[]; updraft: boolean; last: number; last_ok: boolean };
  staging_site: CareStagingInfo | null;
  rollbacks: Record<string, { version: string; at: number }>;
  paths: { abspath: string; plugins: string; themes: string; content: string };
  paths_ok: boolean;
}

export type CareSeverity = "critical" | "high" | "medium" | "low" | "unknown";

export interface CareVuln {
  component: "core" | "plugin" | "theme" | "php";
  slug: string;
  name: string;
  installed: string;
  title: string;
  severity: CareSeverity;
  score: number | null;
  fixedIn: string | null; // null = no fix released yet
  link: string;
  cve: string;
}

export interface CareAbandoned {
  slug: string;
  name: string;
  reason: "closed" | "stale";
  detail: string;
}

export interface CareIntel {
  at: string;
  vulns: CareVuln[];
  abandoned: CareAbandoned[];
  php: { version: string; status: "supported" | "security" | "eol" | "unknown"; endsAt: string | null };
}

export interface CareHealth {
  at: string;
  ssl: { validTo: string; daysLeft: number; issuer: string } | null;
  domain: { expires: string; daysLeft: number; registrar: string } | null;
  dirListing: boolean;
  uptime: { days30: number | null; checks: number; lastDown: string | null; avgMs: number | null };
}

export interface CareIntegrity {
  at: string;
  core: { checked: boolean; modified: string[]; missing: string[]; unknown: string[] };
  plugins: { slug: string; name: string; modified: string[]; added: string[] }[];
  uploads_php: string[];
}

export type CareItemKind = "core" | "plugin" | "theme" | "translations";

export interface CareUpdateItem {
  kind: CareItemKind;
  id: string; // plugin file, theme stylesheet, "core", "translations"
  name: string;
  from: string;
  to: string;
  security: boolean; // fixes a known vulnerability
  premium: boolean; // not from wordpress.org
  staging?: { ok: boolean; note: string; rolledBack?: boolean };
  live?: { ok: boolean; note: string; rolledBack?: boolean };
  selected: boolean;
  blocked?: string; // why it can't be updated (e.g. premium plugin without a licence)
}

export interface CarePageCheck {
  path: string;
  status: number;
  fatal: boolean;
  consoleErrors: number;
  beforeStatus?: number;
  beforeConsole?: number;
  diff: number | null; // % of pixels changed vs the baseline
  before?: string; // file names under the site's data folder
  after?: string;
  diffImage?: string;
}

export interface CareFormCheck {
  page: string;
  index: number;
  name: string;
  before: boolean | null;
  after: boolean | null;
  mail: boolean | null; // a notification email was generated (staging only)
  detail: string;
}

export interface CareTestReport {
  at: string;
  target: "staging" | "live";
  pages: CarePageCheck[];
  forms: CareFormCheck[];
  errors: { fatal: number; warning: number; lines: string[] };
  env: { matches: boolean; diffs: string[] } | null;
  deactivated: string[];
  verdict: "pass" | "review" | "fail";
  reasons: string[];
}

export type CareStep = "scan" | "clone" | "baseline" | "update-staging" | "test-staging" | "approve" | "backup" | "update-live" | "verify-live" | "done";

export interface CareRun {
  id: string;
  month: string; // 2026-09
  trigger: "manual" | "schedule";
  startedAt: string;
  finishedAt?: string;
  step: CareStep;
  status: "running" | "waiting" | "done" | "failed" | "cancelled";
  note: string;
  items: CareUpdateItem[];
  staging?: CareTestReport;
  live?: CareTestReport;
  backup?: { plugin: string; ok: boolean; at: string; note: string };
  approvedAt?: string;
  backupConfirmed?: boolean;
  paths: string[]; // pages tested
  errorsSince?: number; // unix seconds: PHP errors after this count
  log: { at: string; text: string }[];
}

export interface CareSite {
  id: string;
  name: string;
  siteUrl: string;
  wpUser: string;
  appPasswordSet: boolean;
  seoSiteId: string | null;
  client: string;
  connected: { ok: boolean; plugin: string; care: number; checkedAt: string; error?: string } | null;
  summary: {
    wp: string;
    php: string;
    updates: number;
    security: number; // updates that fix a vulnerability
    vulns: number;
    critical: number;
    warnings: number; // security hardening checks not passing
    backup: string; // detected backup plugin(s)
    lastBackup: number;
  } | null;
  job: { kind: string; status: "running" | "done" | "failed"; note: string; startedAt: string; finishedAt?: string } | null;
  run: CareRun | null;
  history: { id: string; month: string; finishedAt: string; updated: number; verdict: "pass" | "review" | "fail"; note: string }[];
  lastScan: string | null;
  createdAt: string;
}

/* ---------- Communication (desktop app) ---------- */

export interface CommsService {
  id: string;
  kind: string; // preset key (whatsapp, gmail, …) or "custom"
  name: string;
  url: string;
  color: string;
  notify: boolean;
  muted: boolean; // no unread badge, no notifications
  createdAt: string;
}

/* ---------- Super admin ---------- */

export type ServiceKind = "mockup" | "website" | "wordpress" | "seo" | "maintenance" | "hosting" | "other";

export interface Payment {
  id: string;
  date: string; // YYYY-MM-DD
  client: string;
  domain: string; // links the payment to a client's other work
  service: ServiceKind;
  amount: number;
  status: "paid" | "pending";
  note: string;
  careId?: string; // retainer invoices
  period?: string; // YYYY-MM for retainer invoices
  createdAt: string;
}

export interface Retainer {
  careId: string;
  fee: number; // per month
  active: boolean;
  since: string;
}

export interface AdminClient {
  key: string; // domain
  name: string;
  url: string;
  source: string;
  stages: { lead: boolean; mockup: boolean; build: boolean; wordpress: boolean; live: boolean; maintenance: boolean };
  links: { lead?: string; build?: string; wordpress?: string; seo?: string; care?: string };
  lastActivity: string;
  paid: number;
  pending: number;
  retainer: number;
}

export interface AdminOverview {
  range: number; // days, 0 = all time
  currency: string;
  revenue: {
    paid: number;
    paidPrev: number | null;
    pending: number;
    mrr: number;
    allTime: number;
    months: { key: string; label: string; paid: number }[];
    byService: { service: ServiceKind; paid: number }[];
  };
  leads: {
    total: number;
    prev: number | null;
    bySource: { source: LeadSource; count: number }[];
    ready: number;
    review: number;
    failed: number;
    prospects: number;
    prospectsContactable: number;
    prospectsToMockup: number;
    weeks: { label: string; leads: number; prospects: number }[];
  };
  work: {
    builds: number;
    buildsReady: number;
    buildsActive: number;
    pagesBuilt: number;
    conversions: number;
    conversionsDone: number;
    wpPagesApproved: number;
    seoSites: number;
    seoSignedOff: number;
    seoFixed: number;
    careSites: number;
    careUpdates: number;
    careWaiting: number;
    careVulnerable: number;
    uptime: number | null;
  };
  usage: { jobs: number; apiCost: number };
  funnel: { stage: string; count: number }[];
  attention: { kind: "approve" | "failed" | "security" | "money"; title: string; detail?: string; link: string }[];
  activity: EventItem[];
  topClients: AdminClient[];
}

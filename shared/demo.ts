/**
 * Demo mode: a 7-day free trial. Every workspace is open and generous, but each kind of work has an
 * allowance, and the whole trial stops 7 days after it starts unless a license key is entered.
 * Change the numbers here: the server enforces them and the dashboard shows them.
 * Allowances are counted for good: deleting something doesn't give it back.
 */
export const DEMO_LIMITS = {
  mockups: 5, // leads from any source: manual, Lead Finder, Automations, webhooks (5 mockups)
  searches: 2, // Lead Finder searches
  automations: 2, // automation workflows (each can enrol up to DEMO_AUTOMATION_LEADS businesses in total)
  builds: 1, // full website builds
  wordpress: 1, // WordPress conversions
  seo: 1, // Launch & SEO sites
  care: 1, // maintenance sites
  comms: 40, // communication channels: all of them (the app allows 40 in total), never gated below
  campaigns: 1, // legacy one-shot campaigns
};
export type DemoKind = keyof typeof DEMO_LIMITS;

/** How long the free trial lasts, in days, from the moment the person chooses "Try the demo". */
export const DEMO_DAYS = 7;
/** Across all automation workflows, how many businesses the demo may enrol in total. */
export const DEMO_AUTOMATION_LEADS = 40;

/** Results per Lead Finder search or campaign in the demo (leads per search). */
export const DEMO_RESULTS = 20;
/** Store products per WordPress conversion in the demo. */
export const DEMO_PRODUCTS = 20;

/** Creating one of these (POST to the workspace root) uses an allowance. Comms is left out on purpose:
 *  all communication channels are available in the demo. */
export const DEMO_CREATE_ROUTES: Record<string, DemoKind> = {
  "/api/finder/searches": "searches",
  "/api/automations": "automations",
  "/api/builds": "builds",
  "/api/wp": "wordpress",
  "/api/seo": "seo",
  "/api/care": "care",
  "/api/campaigns": "campaigns",
};

export const DEMO_LABELS: Record<DemoKind, [string, string]> = {
  mockups: ["mockup", "mockups"],
  searches: ["Lead Finder search", "Lead Finder searches"],
  automations: ["automation", "automations"],
  builds: ["website build", "website builds"],
  wordpress: ["WordPress conversion", "WordPress conversions"],
  seo: ["SEO site", "SEO sites"],
  care: ["maintenance site", "maintenance sites"],
  comms: ["communication channel", "communication channels"],
  campaigns: ["automation campaign", "automation campaigns"],
};

export interface DemoState {
  left: Record<DemoKind, number>;
  results: number;
  products: number;
  /** When the free trial ends (ISO), and whole days left (0 on the last day). */
  expiresAt: string | null;
  daysLeft: number;
  /** True once the 7 days are up: everything is blocked until a key is entered. */
  expired: boolean;
  /** Total businesses the automations may still enrol before the demo cap. */
  automationLeadsLeft: number;
}

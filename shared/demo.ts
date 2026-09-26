/**
 * Demo mode: what an install can do before a license key is entered. Every workspace is open; each kind of
 * work has an allowance. Change the numbers here: the server enforces them and the dashboard shows them.
 * Allowances are counted for good: deleting something doesn't give it back.
 */
export const DEMO_LIMITS = {
  mockups: 3, // leads from any source: manual, Lead Finder, Automations, webhooks
  searches: 2, // Lead Finder searches
  builds: 1, // full website builds
  wordpress: 1, // WordPress conversions
  seo: 1, // Launch & SEO sites
  care: 1, // maintenance sites
  comms: 2, // communication channels
  campaigns: 1, // automation campaigns
};
export type DemoKind = keyof typeof DEMO_LIMITS;

/** Results per Lead Finder search or campaign in the demo. */
export const DEMO_RESULTS = 10;
/** Store products per WordPress conversion in the demo. */
export const DEMO_PRODUCTS = 20;

/** Creating one of these (POST to the workspace root) uses an allowance. */
export const DEMO_CREATE_ROUTES: Record<string, DemoKind> = {
  "/api/finder/searches": "searches",
  "/api/builds": "builds",
  "/api/wp": "wordpress",
  "/api/seo": "seo",
  "/api/care": "care",
  "/api/comms": "comms",
  "/api/campaigns": "campaigns",
};

export const DEMO_LABELS: Record<DemoKind, [string, string]> = {
  mockups: ["mockup", "mockups"],
  searches: ["Lead Finder search", "Lead Finder searches"],
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
}

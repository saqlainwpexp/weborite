/**
 * Demo mode: what an install can do before a license key is entered. Change the numbers here; the server
 * enforces them and the dashboard shows them.
 */
export const DEMO_LIMITS = {
  mockups: 3, // leads created (manual or from Lead Finder), counted for good: deleting a lead doesn't give one back
  searches: 2, // Lead Finder searches
  resultsPerSearch: 10,
};

/** Workspaces usable in the demo; the rest show what they do and an unlock button. */
export const DEMO_WORKSPACES: readonly string[] = ["mockups", "finder"];

/** API prefixes that belong to locked workspaces (and the in-app assistant, which can reach all of them). */
export const DEMO_LOCKED_API = ["/api/builds", "/api/wp", "/api/seo", "/api/care", "/api/comms", "/api/campaigns", "/api/admin", "/api/agent"];

export interface DemoState {
  mockupsLeft: number;
  searchesLeft: number;
  resultsPerSearch: number;
}

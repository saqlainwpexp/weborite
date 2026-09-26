/**
 * Which workspaces this build of the studio shows. Hidden workspaces disappear from the switcher,
 * the super-admin sidebar and the router (their URLs fall back to the Mockups dashboard); their
 * code and data stay untouched, so turning one back on is just adding its key here.
 *
 * All keys: admin, mockups, automations, finder, builds, wordpress, seo, care, comms
 */
export const ENABLED_WORKSPACES: readonly string[] = ["admin", "mockups", "automations", "finder", "builds", "wordpress", "seo", "care", "comms"];

export const workspaceEnabled = (key: string) => ENABLED_WORKSPACES.includes(key);

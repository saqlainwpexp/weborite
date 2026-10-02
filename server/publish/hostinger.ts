import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import SftpClient from "ssh2-sftp-client";
import { DATA, getLead, getSettings, leadDir, saveLead } from "../db.ts";
import type { Lead } from "../../shared/types.ts";

/**
 * Publish an approved mockup live over SFTP (a Hostinger subdomain) so the outreach email can link a
 * real URL. Each mockup goes into its own folder <basePath>/<slug>/, served at <publicBaseUrl>/<slug>/.
 *
 * The mockup HTML lives at mockup/index.html and references assets as ../assets/… ; live, we put
 * index.html and the assets side by side under <slug>/, so we rewrite ../assets/ → assets/.
 *
 * Credentials come from Settings (never hard-coded): hostingSftpHost/Port/User/Password,
 * hostingBasePath and hostingPublicBaseUrl. Nothing is sent anywhere else.
 */

export interface HostingConfig { host: string; port: number; user: string; password: string; basePath: string; publicBaseUrl: string }

export function hostingConfig(): HostingConfig {
  const s = getSettings();
  return {
    host: s.hostingSftpHost.trim(), port: s.hostingSftpPort || 22, user: s.hostingSftpUser.trim(),
    password: s.hostingSftpPassword, basePath: s.hostingBasePath.trim().replace(/\/+$/, ""),
    publicBaseUrl: s.hostingPublicBaseUrl.trim().replace(/\/+$/, ""),
  };
}

export const hostingReady = (c = hostingConfig()) => Boolean(c.host && c.user && c.password && c.basePath && c.publicBaseUrl);

/**
 * Host-key verification (trust-on-first-use). ssh2 accepts any server key by default, which would let a
 * man-in-the-middle capture the SFTP password. We pin the key fingerprint we saw first for this host:port
 * and refuse to connect (so the password is never sent) if it ever changes.
 */
const KNOWN_HOSTS = join(DATA, "sftp-known-hosts.json");
const readKnownHosts = (): Record<string, string> => { try { return JSON.parse(readFileSync(KNOWN_HOSTS, "utf8")); } catch { return {}; } };

function hostVerifier(host: string, port: number) {
  return (key: Buffer): boolean => {
    const fp = createHash("sha256").update(key).digest("base64");
    const id = `${host.toLowerCase()}:${port}`;
    const known = readKnownHosts();
    if (!known[id]) {
      known[id] = fp; // first connection: remember this server's key
      try { writeFileSync(KNOWN_HOSTS, JSON.stringify(known, null, 1), { mode: 0o600 }); } catch { /* best effort */ }
      return true;
    }
    return known[id] === fp;
  };
}

/** Shared connect options, including the host-key pin. */
function connectOpts(cfg: HostingConfig) {
  return { host: cfg.host, port: cfg.port, username: cfg.user, password: cfg.password, readyTimeout: 20000, hostVerifier: hostVerifier(cfg.host, cfg.port) };
}

/** A filesystem- and URL-safe folder name for this lead's live mockup. */
export function leadSlug(lead: Pick<Lead, "id" | "url" | "business">): string {
  const base = (() => { try { return new URL(lead.url).hostname.replace(/^www\./, ""); } catch { return lead.business || "mockup"; } })();
  return `${base.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "") || "mockup"}-${lead.id.slice(0, 6)}`;
}

/** Upload (or re-upload) a lead's mockup. Returns the live URL and records it on the lead. */
export async function publishMockup(leadId: string): Promise<{ url: string; path: string }> {
  const lead = getLead(leadId);
  if (!lead) throw new Error("Lead not found");
  const cfg = hostingConfig();
  if (!hostingReady(cfg)) throw new Error("Add your Hostinger SFTP details in Settings → Integrations first");

  const dir = leadDir(leadId);
  const indexPath = join(dir, "mockup", "index.html");
  if (!existsSync(indexPath)) throw new Error("There's no generated mockup to publish yet");

  const slug = leadSlug(lead);
  const remoteDir = `${cfg.basePath}/${slug}`;
  const html = readFileSync(indexPath, "utf8").replace(/\.\.\/assets\//g, "assets/");

  const sftp = new SftpClient();
  try {
    await sftp.connect(connectOpts(cfg));
    await sftp.mkdir(remoteDir, true);
    // Replace the page so re-publishing a revised mockup overwrites the old one.
    await sftp.put(Buffer.from(html, "utf8"), `${remoteDir}/index.html`);
    const assets = join(dir, "assets");
    if (existsSync(assets)) await sftp.uploadDir(assets, `${remoteDir}/assets`);
  } finally {
    await sftp.end().catch(() => {});
  }

  const url = `${cfg.publicBaseUrl}/${slug}/`;
  lead.publish = { url, path: remoteDir, at: new Date().toISOString() };
  saveLead(lead);
  return { url, path: remoteDir };
}

/** Remove a published mockup from the host and clear it off the lead. */
export async function unpublishMockup(leadId: string): Promise<void> {
  const lead = getLead(leadId);
  if (!lead) throw new Error("Lead not found");
  const cfg = hostingConfig();
  if (lead.publish?.path && hostingReady(cfg)) {
    const sftp = new SftpClient();
    try {
      await sftp.connect(connectOpts(cfg));
      await sftp.rmdir(lead.publish.path, true).catch(() => {});
    } finally {
      await sftp.end().catch(() => {});
    }
  }
  lead.publish = undefined;
  saveLead(lead);
}

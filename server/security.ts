import { timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { NextFunction, Request, Response } from "express";

/* ---------- which addresses the scrapers may visit ---------- */

/** Loopback, private-network, link-local and similar addresses (IPv4 and IPv6). */
export function isPrivateIp(ip: string) {
  const v4 = ip.replace(/^::ffff:/i, "");
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

/** True for hostnames that can only mean this PC or the local network. */
export function isPrivateHost(hostname: string) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home.arpa")) return true;
  if (isIP(h)) return isPrivateIp(h);
  return !h.includes("."); // single-label names resolve on the local network
}

/** Throws when a lead's website points at this PC or the local network (directly or through DNS). */
export async function assertPublicUrl(url: string) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http and https websites can be captured");
  if (isPrivateHost(u.hostname)) throw new Error(`${u.hostname} is a local address, not a public website`);
  const addrs = await lookup(u.hostname.replace(/^\[|\]$/g, ""), { all: true }).catch(() => []);
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error(`${u.hostname} points to a local network address, not a public website`);
}

/** Stops a scraping browser context from reaching this PC or the local network, even through redirects. */
export async function blockPrivateNetwork(ctx: import("playwright").BrowserContext) {
  await ctx.route(/^https?:\/\//i, (route) => {
    let host = "";
    try {
      host = new URL(route.request().url()).hostname;
    } catch {
      /* unparseable: let it fail on its own */
    }
    return host && isPrivateHost(host) ? route.abort("blockedbyclient") : route.fallback();
  });
}

/* ---------- the local dashboard API ---------- */

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The API has no login because it only listens on this PC. That alone doesn't stop a web page in
 * your browser from calling it, so:
 *  - the Host header must be localhost (stops DNS-rebinding sites from reading or changing anything),
 *  - changes must come from the dashboard itself, not from another site or a sandboxed mockup,
 *  - ids in the path can't smuggle in "../" to reach files outside the data folder.
 */
export function localOnly(req: Request, res: Response, next: NextFunction) {
  if (!LOCAL_HOST.test(req.get("host") ?? "")) return res.status(403).json({ error: "The dashboard only answers on localhost" });
  if (!SAFE.has(req.method)) {
    const origin = req.get("origin");
    const site = req.get("sec-fetch-site");
    if ((origin !== undefined && !LOCAL_ORIGIN.test(origin)) || (site && site !== "same-origin" && site !== "none")) {
      return res.status(403).json({ error: "Requests from other sites are not allowed" });
    }
  }
  if (req.path.startsWith("/api/")) {
    for (const seg of req.path.split("/")) {
      let d = seg;
      try {
        d = decodeURIComponent(seg);
      } catch {
        return res.sendStatus(400);
      }
      if (d === ".." || d === "." || /[\\/\0]/.test(d)) return res.sendStatus(400);
    }
  }
  res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "SAMEORIGIN" });
  next();
}

/**
 * Generated pages (mockups, builds, uploads) run in a sandbox with no origin, so their scripts can't
 * call the API as the dashboard. Fonts get an open CORS header so they still load inside the sandbox.
 */
export function sandboxFiles(req: Request, res: Response, next: NextFunction) {
  res.set({
    "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads",
    "X-Frame-Options": "SAMEORIGIN",
  });
  if (/\.(woff2?|ttf|otf|eot)$/i.test(req.path)) res.set("Access-Control-Allow-Origin", "*");
  next();
}

/** Constant-time comparison for webhook secrets; an empty secret never matches. */
export function secretMatches(given: unknown, expected: string) {
  if (typeof given !== "string" || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

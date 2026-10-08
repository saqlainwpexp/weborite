/**
 * User-facing error text. The pipeline throws low-level errors (Playwright navigation timeouts, DNS
 * failures, AI CLI output, …) whose raw messages — "page.goto: Timeout 45000ms exceeded. Call log:
 * - navigating to …" — mean nothing to an agency owner. humanError() maps the common ones to a short,
 * plain explanation. The raw error is still logged to the console for debugging; only what the UI shows
 * goes through here.
 */
export function humanError(e: unknown): string {
  const raw = (e instanceof Error ? e.message : String(e ?? "")).trim();
  const m = raw.toLowerCase();

  // --- loading the prospect's website ---
  if (/err_name_not_resolved|enotfound|getaddrinfo|dns/.test(m))
    return "Couldn't reach the website — the address may be wrong or the domain is offline.";
  if (/err_connection_refused|econnrefused|connection refused/.test(m))
    return "The website refused the connection — its server may be down.";
  if (/err_connection_(reset|closed|aborted)|econnreset|socket hang up/.test(m))
    return "The connection to the website dropped before it finished loading.";
  if (/err_cert|cert_|ssl|certificate|err_ssl/.test(m))
    return "The website has an SSL/certificate problem, so it couldn't be loaded safely.";
  if (/\b(403|forbidden)\b|err_blocked|access denied|cloudflare|captcha|bot/.test(m))
    return "The website blocked our visit (bot protection), so it couldn't be captured.";
  if (/\b(404|not found)\b/.test(m) && /goto|navigat/.test(m))
    return "That page couldn't be found (404) — the link may have moved.";
  if (/timeout.*exceeded|exceeded.*timeout|navigating to|page\.goto|timed? ?out|etimedout/.test(m))
    return "The website took too long to respond — it may be down, very slow, or blocking automated visits.";

  // --- the browser engine itself ---
  if (/executable doesn'?t exist|playwright install|failed to launch|browser.*(install|launch)/.test(m))
    return "The built-in browser needs to finish installing. Please try again in a minute.";

  // --- the AI provider ---
  if (/no ai|provider|api key|unauthorized|401|quota|rate.?limit|insufficient|billing|credit/.test(m) && /ai|claude|openai|gemini|model|token|key|quota/.test(m))
    return "The AI provider couldn't complete the request — check your AI settings (key, sign-in or quota).";

  // --- nothing matched: a short generic line, never the raw log ---
  return "Something went wrong while building this mockup. Please try running it again.";
}

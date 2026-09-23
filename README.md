# Mockup Studio

This tool turns each lead into a rebuilt homepage mockup. A lead arrives from an Elementor form, Meta Lead Ads, or manual entry. For each one the studio:

1. Captures the current homepage and a few inner pages.
2. Diagnoses it with a light check, not a full audit.
3. Matches it to a benchmark set for its vertical.
4. Has Claude rebuild the homepage.
5. Runs deterministic quality checks.
6. Renders the old and new pages side by side for review.

Everything runs locally on your PC. The only paid part is Claude, which comes either from your Claude plan (Session mode) or from an API key (API mode).

## Setup (once)

```bash
npm install
npx playwright install chromium
```

For Session mode (uses your Claude Pro/Max plan):

```bash
npm i -g @anthropic-ai/claude-code
claude
```

Log in once when `claude` opens, then close it. For API mode, paste an Anthropic API key in **Settings** and switch the mode.

## Run

```bash
npm run dev
```

The dashboard runs at http://localhost:5173. The API runs on port 4000 (local only), and the webhooks listen on port 4001.

To run a production build:

```bash
npm run build
npm start
```

Once built, the dashboard is served at http://localhost:4000.

## Receiving leads

Expose **only** the webhook port through a free Cloudflare Tunnel:

```bash
cloudflared tunnel --url http://localhost:4001
```

Paste the printed https URL into **Settings → Webhooks** to get:

- **Elementor:** `…/hooks/elementor?key=<secret>`. In the form widget, go to Actions After Submit → Webhook. The form needs a website field; any label containing *website*, *url*, *site* or *domain* works.
- **Meta Lead Ads:** callback `…/hooks/meta` and the verify token shown in Settings. Subscribe the Page to `leadgen`, save a Page access token with `leads_retrieval`, and add a website question to the lead form.

Duplicate leads (same site or the same email) are skipped automatically.

## Pipeline

| Step | What happens | Output (`data/leads/<id>/`) |
|---|---|---|
| Capture | Playwright takes desktop (1440) and mobile (375) screenshots, downloads media and the logo, samples the brand palette by area, collects the fonts, and pulls copy from the homepage plus up to four inner pages | `desktop.jpg`, `mobile.jpg`, `assets/`, `capture.json`, `facts.json`, `checks.json` |
| Diagnose | Lighthouse, axe contrast, and real-tap mobile checks (menu, sideways scroll, overlap, tap targets). Claude then picks the **strongest asset** and classifies the vertical | `diagnosis.json`, `lighthouse.json` |
| Vertical & benchmarks | Reuses `data/benchmarks/<vertical>.json`, or runs a one-time web research pass to build it | shared library |
| Generate | Claude writes `mockup/index.html`. Brand colours, logo and strongest asset are **locked inputs**, and facts are restricted to `facts.json` | `mockup/index.html` |
| Quality gate | WCAG contrast, undefined CSS classes, placeholder/stock/broken media, every number traced to the source site, strongest asset present, logo and primary colour present, 375px layout with a working nav and semantic landmarks. On failure, Claude gets **one** retry with the failures | `gate.json` |
| Side-by-side | Old vs new at desktop and mobile, with badges for the three hard constraints | `side-by-side.png` |

If Claude is unavailable (CLI not installed, plan limit reached, no API key), the job **pauses** and retries after 20 minutes. Jobs interrupted by a restart resume on the next start.

## Lead Finder workspace

Switch workspaces from the menu next to the logo. **Lead Finder** runs a Google Maps search (for example "HVAC companies in Rotterdam") and saves each business's name, category, phone, rating, review count, website and address. Then it:

- **Scans for emails:** the homepage plus up to four contact / over-ons / impressum pages, including mailto links, Cloudflare-protected addresses, and "info [at] …" spellings. Addresses on the business's own domain come first.
- **Checks WhatsApp:** it tags **WhatsApp** when wa.me shows a WhatsApp Business profile for the number (the page shows the business name), or when their site links to WhatsApp. Anything else shows as "not confirmed". The public wa.me page can't tell a personal WhatsApp user from a number that has no WhatsApp at all.
- **Skips duplicates:** a business is saved once across all searches.

From a lead you can export to CSV (with filters) or click **Create mockup** to send it to the Mockups workspace.

Scraping Google Maps goes against Google's terms of service. Keep volumes modest; the scraper already paces itself.

## Builds workspace

Turns an approved mockup into a complete website (usually 5–10 pages). Start one from the **Start build** button on a mockup lead, or from **Builds → New build**. Then:

1. **Brief:** enter the homepage change requests, the project details the client sent (these count as verified facts), and the page list (Home plus up to 11 more, each with a one-line brief).
2. **Revise homepage:** Claude applies the change requests to the approved mockup.
3. **Shared layout:** the homepage is split into `styles.css`, `site.js`, header and footer. Claude links the navigation to every page (`about.html`, …) and the current page is highlighted automatically.
4. **Write pages:** one Claude pass per page. It writes only the `<main>`, reusing the shared styles, so every page matches.
5. **Quality checks:** the same gate as mockups (contrast, undefined classes, placeholders, facts, brand, 375px), run on every page with one automatic fix, plus a site-wide link check. Links to sections that don't exist are repaired automatically.
6. **Package:** `site.zip`, ready to hand over or upload to any static host.

After the build, you can preview each page at desktop and mobile size and send a change request for a single page without rebuilding the rest.

## WordPress workspace

Converts a finished build into Elementor pages on the client's WordPress site, one page at a time.

1. **New conversion:** pick the build, choose **Elementor free + custom widgets** or **Elementor Pro in scope**, and enter the site URL and a WordPress username.
2. **Connect:** download the **Studio Connector** plugin from the conversion page and install it on the client site. Create an Application Password (Users → Profile) and test the connection.
3. **Convert:** each section of the page is measured in the browser at 1440px and 375px (sizes, spacing, fonts, colours, layout). Claude turns the measurements into Elementor containers and native widgets.
   - A validator rejects the HTML and Shortcode widgets, Pro widgets when Pro isn't in scope, and layout HTML or inline styles hidden inside Text Editor widgets.
   - The header and footer are converted once and reused. With Pro, they become theme-builder templates.
   - Without Pro, anything that needs a Pro widget becomes a custom `Studio_Widget_*` Elementor widget. It's added to the connector plugin, so install the updated plugin when the dashboard asks.
4. **Review:** the page is pushed as a **draft**, screenshotted through a private preview link, and compared pixel by pixel with the HTML at desktop and mobile width. **Approve** starts the next page; **Request changes** sends feedback for the whole page or one section.

## Freelancer Bids workspace

Watches freelancer.com for new projects that match your skills, has Claude write a proposal for each one, and places the bid. Claude runs through the same Session or API mode as the rest of the studio.

1. **Connect:** create an app at freelancer.com → Settings → Developer, tick the scopes *Manage your projects, bids and milestones* and *View your user and profile information*, and generate a token. Paste it in **Bid settings** and choose **Sandbox** (freelancer-sandbox.com, needs its own account and token) or **Live**. The token is stored only in the local database.
2. **Choose what to bid on:** Freelancer skills, optional search words, words to avoid, fixed or hourly, minimum budget (compared in USD), maximum existing bids, verified clients only, and countries to skip. Only projects posted in the last hour (configurable) are picked up, so the first run doesn't bid on a backlog.
3. **About you:** your profile and a few past proposals. Claude only claims experience that's written here, and it skips jobs that don't fit, look like scams, or are underpriced.
4. **Pricing:** Claude rates each job's complexity from 0 to 1. The bid lands between *simple* (default 50% of the client's range) and *complex* (default 90%), rounded to a normal price and always kept inside the range. A "$300+" budget with no maximum is capped at the minimum × 1.3.
5. **Review or automatic:** in review mode each draft waits in **Projects → To review**, where you can edit the text, amount and delivery time, then place the bid. Automatic mode sends bids on its own, up to a daily limit; after that, drafts wait for you.

The project text comes from the client, so Claude writes proposals with every tool switched off, in an empty folder.

## Notes

- The brand palette is derived deterministically from the live page, never by Claude. In the dashboard, the lead page shows it as **Locked brand**.
- Old sites often block iframes. The left pane therefore defaults to the screenshot, and the ↻ button tries the live page.
- Benchmark sets can be edited on the **Benchmarks** page.

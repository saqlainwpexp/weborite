# Weborite Studio: project memory

Read this first in every new session. It records what the app is, how it's built and shipped, the decisions already made, and what's still open. Keep it up to date when something here changes.

## The product

**Weborite Studio** (package name `mockup-studio`) is a Windows desktop app for web design agencies. It's sold by Weborite Solutions (Pakistan, hello@weborite.com), whose owner is the user. Its website is **studio.weborite.com**; weborite.com is the owner's agency portfolio and is a separate thing.

Stack: Electron shell (`electron/main.mjs`), an Express + TypeScript server (`server/`, run with tsx in dev and bundled for the app), a React + Vite UI (`web/src/`), shared types in `shared/types.ts`, SQLite via `node:sqlite` (`server/db.ts`), and Playwright/Chromium for browsing and screenshots.

Workspaces (switcher in `web/src/layout/Layout.tsx`, flags in `shared/features.ts`):

- **Mockups** (`server/queue.ts`, `server/pipeline/*`): capture → diagnose → benchmark set per vertical → AI generates the homepage → quality gate → side-by-side render.
  - **List tools** (`web/src/pages/Leads.tsx`, `LeadsTable.tsx`): bulk select / edit / delete / export — routes `POST|PATCH /api/leads/bulk` and `POST /api/leads/export`.
  - **Rating + feedback + revise** (`web/src/pages/LeadDetail.tsx`): rate /10 + feedback (`POST /api/leads/:id/feedback`), and "Request changes" (`POST /api/leads/:id/revise`) which re-runs from `generate` with `reviseRequest`. `generateMockup` takes `opts:{failures?,changes?}`; a change/retry amends the current mockup, a **sameness** gate failure re-picks a different design (writes `design.json`, avoids the last pick).
  - **Learned feedback**: every rating comment / change request is stored globally (`DATA/feedback-notes.json`, `addFeedbackNote`/`listFeedbackNotes`) and injected into future generate prompts as "LEARNED PREFERENCES" so corrections don't repeat.
  - **Design variety**: `pickDesignSystem` now rotates across measured systems for unmatched verticals (was always the single most-versatile → the "all look the same" bug). Niche libraries still use the `recipe.ts` mixer. New design sets: see `design-library/README.md`.
  - **Playbook + outreach draft** (after the gate, cached to the lead folder): `server/playbook.ts` (`POST /api/playbook/:id`, plain-text brief) is separate from the outreach email `server/pitch.ts` (`POST /api/pitch/:id`). Both shown on the detail page (`outreach`/`playbook` in `/api/leads/:id`).
  - **Publish live (Hostinger SFTP)** `server/publish/hostinger.ts`: `POST|DELETE /api/leads/:id/publish`, uploads `mockup/`+`assets/` to a subdomain folder, stores `lead.publish.url`. Creds in Settings → Integrations (`hostingSftp*`, `hostingBasePath`, `hostingPublicBaseUrl`, `autoPublishOnReady`; password sealed). The live URL feeds the outreach email/playbook and the automations `{{mockup_url}}`.
- **Automations** (`server/automations/*`, `web/src/pages/automations/Workflows.tsx`): a visual workflow builder, plus the older "Quick campaigns" (`server/campaigns`). Reply tracking now **branches** instead of only stopping: `wf_replies.sentiment` (heuristic `classifyReply`, from subject + a peeked body snippet via `inboxSince(..., withText)`), a `reply_sentiment` condition field, a wait mode **"reply"** (continue on reply or after N days), a `mark_dead` action, and a `{{mockup_url}}` variable. A workflow that reacts to replies (`branchesOnReply`) keeps running on reply; others stop as before. New **"followup"** template (`routes.ts`): mockup → email → wait for reply → positive ⇒ notify "move to full build?" / negative ⇒ one follow-up → wait → mark dead.
- **Lead Finder** (`server/finder/*`): Google Maps scraping, then enrichment (emails, WhatsApp) and a fit score. Also has a **Meta leads** tab (`web/src/pages/finder/MetaLeads.tsx`, `MetaLeadDetail.tsx`): a separate `MetaLead` model/table (`server/finder/metaStore.ts`, routes `server/finder/metaRoutes.ts` at `/api/meta`) for ad-form leads, distinct from the Google Maps `Prospect`. Captures Facebook/Instagram Lead Ads (the existing Meta webhook in `server/intake.ts` now stores every lead here, website or not, and links a Mockup when the form has a URL), plus manual add and CSV import (header-mapped, de-duped on email/leadgen id). Status pipeline new→contacted→qualified→won→lost; a lead with a website can be handed to Mockups. **Next change (not built): the live Facebook Lead Ads API/token setup UI.**
- **Builds**: full sites from approved mockups.
- **WordPress** (`server/wp/*`): Elementor conversion and the Studio Connector plugin.
- **Launch & SEO** (`server/seo/*` plus `server/golive/*`): QA, performance, on-page SEO and a Go-live tab.
- **Maintenance** (`server/care/*`): monthly updates tested on staging.
- **Communication** (`server/comms.ts`).
- **Super admin** (`server/admin.ts`).

## How the owner works

- Develop and push on the branch named in the session instructions (so far `claude/vigilant-allen-hwaf20`). The owner merges it into their local branch on Windows and builds there.
- Commands the owner runs (PowerShell): `git pull`, `git merge origin/<branch>`, `npm install`, `npm run dist`. The installer lands at `release\Weborite Studio Setup <version>.exe`.
  - **Gotcha:** a plain `git pull` on their own branch doesn't bring in the Claude branch. They must `git merge origin/<branch>`. If the build prints the old version number, that's why.
- `npm run dist` makes the **customer build**: minified, obfuscated, licensing on. `npm run dist:owner` makes the **owner build**: readable, licensing off. Never share the owner build.
- Never commit secrets. The license **public** key goes in `shared/licenseKey.ts` (`LICENSE_PUBLIC_KEY`), which is empty in git; the owner sets it locally. A customer build refuses to build without it.
- Design taste: keep the rose/wine palette and the Inter Tight/Inter fonts. The owner rejected a green rebrand. Aim for a clean, professional, Apple-like look. Prefer real screenshots to placeholders.

## Build, protection and release

- **Dependency note:** Hostinger publishing uses `ssh2-sftp-client` (prod dep; `@types/...` dev). It's bundled `external` (esbuild `packages: "external"`), so run `npm install` after merging this branch before `npm run dist`. Auto-update adds `electron-updater` (prod dep, used only in `electron/main.mjs`, not the server bundle) — `npm install` after merging.
- `scripts/build-server.mjs` bundles the server with esbuild into `app-dist/server.mjs`.
  - For customer builds it minifies and then runs **javascript-obfuscator** (string array, base64).
  - **Critical:** functions passed to Playwright (`page.evaluate`, `$$eval`, `$eval`, `waitForFunction`, `addInitScript`…) run inside the web page. `keepBrowserCodePlain()` parses the bundle with acorn and wraps those functions, inline or passed by name, in `/* javascript-obfuscator:disable/enable */` comments.
  - Without this, the app fails with "ReferenceError: hE is not defined". Any new browser-side helper passed by name is found automatically. Browser-side functions must stay self-contained (no references to module scope).
- The build reads `LICENSE_PUBLIC_KEY` from the environment if set, which is how CI supplies it.
- electron-builder produces an NSIS x64 installer. The electron fuse `runAsNode` must stay on, because `server/pipeline/browser.ts` uses `ELECTRON_RUN_AS_NODE` to install Playwright's browser. DevTools are off in customer builds.
- **Releases:** `.github/workflows/release.yml` (windows-latest) runs when `.github/release-notes/v<version>.md` is pushed (or on a `v*` tag).
  - It builds the installer, then creates the tag and a GitHub release with the `.exe` attached.
  - It needs the repo secret **`LICENSE_PUBLIC_KEY`**, which is **not set yet**, so runs fail at "Check the license key secret". After the owner adds it, "Re-run jobs" works.
  - This environment can't push tags, which is why the workflow is triggered by the notes file instead.
  - To release: bump `version` in package.json and package-lock.json (the root fields only), then add the notes file.
- **Auto-update (electron-updater):** customer builds update themselves from a generic feed at **https://studio.weborite.com/updates/** (set in `build.publish`, package.json). `npm run dist` writes `release/latest.yml` + `.exe` + `.exe.blockmap`; the release workflow runs `scripts/upload-updates.mjs` to SFTP them into Hostinger's `updates/` folder.
  - **New repo secrets** the upload step needs (Settings → Secrets and variables → Actions): `UPDATE_SFTP_HOST`, `UPDATE_SFTP_USER`, `UPDATE_SFTP_PASS`, `UPDATE_SFTP_PATH` (absolute path to the web-served `updates` folder, e.g. `…/public_html/updates`), optional `UPDATE_SFTP_PORT`. If unset, the step skips without failing the release.
  - **Deploy note:** create the public `updates/` folder on Hostinger and make sure the site's clean-URL `.htaccess` doesn't rewrite `/updates/*.yml|.exe|.blockmap`.
  - The desktop shell wires it in `electron/main.mjs` (`autoDownload` off; `updates:check`/`download`/`install` IPC → preload `studioDesktop.updates` → `web/src/components/UpdateBanner.tsx` banner + Settings → Plan & license "App updates"). Owner builds and runs from source never auto-update (gated via `build` in `electron/build-info.json`).
  - Unsigned, so integrity is the SHA-512 in `latest.yml` over HTTPS (not an Authenticode signature) and SmartScreen still warns. **First rollout:** existing installs have no updater, so users install the first updater-enabled version once by hand; updates after that are in-app.
- Current version: **0.4.0**. The repo `saqlainwpexp/weborite` is private.

## Licensing and website

- `site/` is the static website for studio.weborite.com, hosted on Hostinger.
  - It uses clean URLs via `.htaccess`, with a buy page, a demo page and legal pages.
  - `site/license/` is a PHP license server (SQLite, Ed25519-signed responses; the app verifies them with the public key). Lemon Squeezy wasn't usable because it requires Stripe, which doesn't work in Pakistan.
- **Onboarding** (`web/src/pages/Activation.tsx`, `POST /api/license/onboard`): collects name, email, phone, company, "what you do", a company description, and a **personalization** block (niche, writing-style references, case studies, design context + mission/goals, free notes). These persist to Settings (`role`, `companyDescription`, `niche`, `writingStyle`, `caseStudies`, `designContext`, `personalizationNotes` in `shared/types.ts`), are editable in **Settings → Profile** ("Business & personalization"), and feed AI prompts via `agencyProfileBlock(focus)` in `server/db.ts` (injected in `server/pipeline/generate.ts` and `server/pitch.ts`). On submit the details are also emailed to **info@weborite.com**: the app POSTs best-effort to `${LICENSE_API}/onboard` → `site/license/onboard.php` (added to `site/license/.htaccess`), which `mail()`s `ONBOARDING_EMAIL`. Best-effort, so being offline never blocks setup. **Deploy note:** upload the new `site/license/onboard.php` and the updated `.htaccess` to Hostinger for the email to work.
- **Trial tracking** (so the admin page shows free-trial / unlicensed installs, not just paid licences): the PHP server has a `trials` table (`site/license/lib.php` `record_trial`), written by `onboard.php` and by a new lightweight heartbeat `ping.php` (`v1/ping` in `.htaccess`). The app keeps a stable anonymous `installId` (in a new `app_meta` table, `server/license/index.ts`), sends it + the app version (passed from Electron via `STUDIO_VERSION`) on onboarding, and — when in demo — pings `${LICENSE_API}/ping` on startup and every 12h (alongside `revalidate`, in `startLicenseTimers`). The admin page has a **"Free-trial installs"** section (name/email/company, version, started, last seen, status: trialing/quiet/bought — "bought" = their email now matches a paid licence). **Deploy note:** upload the updated `site/license/{lib,onboard,admin}.php`, the new `ping.php`, and the updated `.htaccess` to Hostinger; then rebuild + ship the app so installs send the id/heartbeat.
- Settings no longer has a **Billing** tab (removed at the owner's request). `web/src/components/Billing.tsx` is now unused but kept in the tree; `/settings/billing` redirects to Profile.
- `server/license/index.ts` covers activation, periodic validation and grace periods.
  - Demo limits are in `shared/demo.ts`. `useDemoAllowance`/`demoLeft` enforce them; `intakeLead` enforces the mockup limit.
  - A 402 response makes the UI open the upgrade window.
  - Licensing is bypassed when running from source unless `STUDIO_DESKTOP=1`.
- Settings → "Plan & license" (`web/src/components/PlanLicense.tsx`).

## AI providers (Settings → AI, formerly "Claude")

- Every AI call goes through `runClaude(req)` in `server/claude/runner.ts` (the name is historical): a prompt, optional images and optional web search in, text out.
- `aiProvider` chooses who does the work:
  - `claude`: the existing modes `session` (Claude Code CLI on the user's plan), `api` (Anthropic key) and `cloud` (jobs over GitHub for a claude.ai worker; skill `.claude/skills/cloud-worker`).
  - `openai`: `openaiAccess` = `login` (Codex CLI `codex exec`, signed in with ChatGPT) or `api` (Responses API).
  - `gemini`: `geminiAccess` = `login` (Gemini CLI `gemini -p … --output-format json --approval-mode plan`, signed in with Google) or `api` (generateContent).
  - `openrouter`, `compatible` (any OpenAI-style `/chat/completions`), and `custom` (any agent CLI; prompt on stdin, answer on stdout).
- The code is in `server/claude/providers.ts`. The endpoints in `server/claude/aiRoutes.ts` are `/api/ai/status` (CLI versions), `/api/ai/login` (opens a terminal running the CLI's sign-in) and `/api/ai/test`. The UI is `web/src/components/AiSettings.tsx`.
- Models per provider are in `aiModels` (heavy = mockups and builds, fast = everything else). A blank model on a sign-in CLI means that CLI's default.
- Antigravity has no headless CLI; its models are reached through Gemini CLI or the Gemini API. Prompts are tuned for Claude.
- Verified CLI flags: `codex --search exec --skip-git-repo-check --sandbox read-only --color never --output-last-message F --image=P -`, and `gemini -p "…" --output-format json --approval-mode plan` with the prompt on stdin.

## Job queues (parallel)

- `server/pool.ts` is `Pool<J>(key, limit, run)`: up to `limit()` jobs run at once, never two with the same key.
- It's used by mockups (key: lead), Lead Finder (key: search), builds, WordPress (key: conversion, so its pages go one by one), SEO (key: site) and maintenance (up to 2).
- Settings: `parallelJobs` (default 3) and `parallelSearches` (default 2).
- `ensureBenchmarks` shares one research run per vertical.

## Automations (workflow builder)

- The canvas UI has Email, Wait, Condition (yes/no) and Action steps. The trigger is one of: a search finishes (niche + location; Save & Run starts it), a label is added, or a mockup is ready.
- Actions: create mockup, add or remove label, notify, stop. The "Starter" template: search → create mockup → wait for the mockup → has email? → email (mockup attached) → wait 3 days → follow-up; no email → label "call".
- The engine (`server/automations/engine.ts`) ticks every 10 seconds.
  - It sends email over direct SMTP (`server/golive/smtp.ts` `sendMail`) from the **outreach mailbox** (Settings → Integrations), 45 seconds apart, within a daily cap.
  - Temporary SMTP errors retry 3 times, 5 minutes apart. The "do-not-contact" label is respected, and an address emailed by another workflow in the last 30 days is skipped.
- **Stop on reply:** the engine reads the outreach inbox over IMAP every 3 minutes (`inboxSince` in `server/golive/imap.ts`, read-only EXAMINE, headers only).
  - A reply from the emailed address, or from the same business domain unless it's a free-mail domain, stops every workflow for that business and labels it "replied".
  - Auto-replies and bounces are ignored.
- Business labels live in `Prospect.labels` and `labelsAt`. Don't use `tags`: `computeTags` rewrites them on every scan.
- Mockups have no public URL, so emails attach a preview JPEG (`mockupPreview`).

## Launch & SEO → Go-live tab

- The connector's `server/wp/php/golive.php` provides:
  - Plugin install: UpdraftPlus, FluentSMTP, Wordfence (through `studio_care_harden`, which keeps Application Passwords **on**; Wordfence turns them off by default and that locks the app out), and LiteSpeed Cache only on LiteSpeed servers.
  - A backup schedule; security and agency-admin-email mu-plugins (the security one also removes Wordfence's app-password block and returns 403 for xmlrpc).
  - `.htaccess` deny rules and WebP rules, with a loopback self-check that removes them again if the site returns 500. WebP is also made on upload.
  - llms.txt, OG tags and archive canonicals when no SEO plugin is active, the hardened form handler (`studio_form_fields`/`studio_form_status`, action `studio_form`), redirects (301 on 404) and the go-live switch (removes staging HTTP auth, allows indexing).
- Server: external checks (`server/golive/checks.ts`), DNS for **any provider** (snapshot from public DNS over DoH, exact records to change, "I've changed them", verify, rollback values), a transfer plan (IPS tag for .uk, auth code otherwise), a direct SMTP/IMAP test, a delivery test that reads SPF/DKIM from an IMAP QA inbox, a redirect map from the old site, and the project record (hosting account ownership, track A/B, people checks, restore test, GSC).
- **Cloudflare API integration was removed at the owner's request**: DNS can be anywhere, and mail connects directly.
- Schema is merged into the Yoast or Rank Math graph without duplicate types (`studio_schema_missing`).

## Testing notes (cloud sessions)

- Local WordPress test site: `php -S 127.0.0.1:8899 router.php` in the scratchpad `wptest` folder, with wp-cli and the plugins. It's rebuilt in each session and isn't in git.
- Run the app from source with `STUDIO_DATA=<dir> API_PORT=4310 HOOK_PORT=4311 npx tsx server/index.ts`, then complete onboarding with `POST /api/license/onboard`.
- Stop test servers by PID or with `lsof -t -i :PORT` (`pkill -f` has killed the shell in this environment).
- Outbound SMTP ports are blocked here, so test mail with local mock SMTP/IMAP servers. GitHub tag pushes are blocked.

## Open items

- Never tested against real services:
  - signed-in Codex or Gemini CLI, and valid OpenAI or Gemini keys
  - a real Gmail IMAP inbox or real SMTP sending
  - live Google Maps scraping in the fixed customer build
- Reply tracking reads INBOX only (not spam). Opens and clicks aren't tracked.
- The installer isn't code-signed, so SmartScreen warns (both the first install and each auto-update). Adding an OV/EV cert later also lets electron-updater verify the publisher — drop it into the release workflow's build step; no code change needed.
- Not built: mockup protection / watermarked previews (a LinkedIn question is still unanswered). Revoke the old test license key E832F624-… as the owner planned.
- Auto-update untested against the live Hostinger feed (needs the `UPDATE_SFTP_*` secrets set and the first updater-enabled build installed by hand). Confirm `release/latest.yml` is produced by `npm run dist` on the first release.

## Security review (AFINE desktop checklist) — done 2026-10-02

- Audited against the AFINE desktop checklist. Strong already: DPAPI-wrapped AES-GCM vault (`server/vault.ts`), loopback-only API with anti-rebind/anti-CSRF/traversal guards (`server/security.ts` `localOnly`), parameterized SQL, untrusted data to CLIs on stdin (never interpolated), SSRF guards on scraping, Ed25519 licence with nonce binding, Electron contextIsolation/sandbox/no-nodeIntegration.
- Fixed this session: (1) Meta webhook now **fails closed** when no app secret is set (`server/intake.ts`); (2) SFTP publish **verifies the host key** (trust-on-first-use, pinned in `DATA/sftp-known-hosts.json`) so the Hostinger password can't be MITM'd (`server/publish/hostinger.ts`); (3) `codexPath`/`geminiPath` validated against shell metacharacters like `claudePath` (`server/index.ts`); (4) brand assets served with a bare `sandbox` CSP so an uploaded SVG can't run script (`server/index.ts`).
- Lower priority / by design, not changed: `runAsNode` fuse stays on (needed for the Playwright install; env-var/inspect fuses are off); `customCommand` runs via shell by design (user-set, CSRF-protected).

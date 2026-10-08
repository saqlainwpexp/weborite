# Weborite Studio: project memory

Read this first in every new session. It records what the app is, how it's built and shipped, the decisions already made, and what's still open. Keep it up to date when something here changes.

## The product

**Weborite Studio** (package name `mockup-studio`) is a Windows desktop app for web design agencies. It's sold by Weborite Solutions (Pakistan, hello@weborite.com), whose owner is the user. Its website is **studio.weborite.com**; weborite.com is the owner's agency portfolio and is a separate thing.

Stack: Electron shell (`electron/main.mjs`), an Express + TypeScript server (`server/`, run with tsx in dev and bundled for the app), a React + Vite UI (`web/src/`), shared types in `shared/types.ts`, SQLite via `node:sqlite` (`server/db.ts`), and Playwright/Chromium for browsing and screenshots.

Workspaces (switcher in `web/src/layout/Layout.tsx`, flags in `shared/features.ts`):

- **Mockups** (`server/queue.ts`, `server/pipeline/*`): capture → diagnose → benchmark set per vertical → AI generates the homepage → quality gate → side-by-side render.
  - **List tools** (`web/src/pages/Leads.tsx`, `LeadsTable.tsx`): bulk select / edit / delete / export — routes `POST|PATCH /api/leads/bulk` and `POST /api/leads/export`.
  - **Rating + feedback + revise** (`web/src/pages/LeadDetail.tsx`): rate /10 + feedback (`POST /api/leads/:id/feedback`), and "Request changes" (`POST /api/leads/:id/revise`) which re-runs from `generate` with `reviseRequest`. `generateMockup` takes `opts:{failures?,changes?}`; a change/retry amends the current mockup, a **sameness** gate failure re-picks a different design (writes `design.json`, avoids the last pick).
  - **Lead notes + one-click delivery pipeline** (`LeadDetail.tsx`, right column): every mockup `Lead` has free-text CRM `notes` (`Lead.notes`, `POST /api/leads/:id/notes`, 8k cap) with a Notes card and a sticky-note indicator in `LeadsTable.tsx`. `GET /api/leads/:id` now also returns a `pipeline` block — `{ build, conversion }` looked up by `listBuilds().leadId` / `listConversions().buildId` — driving a **"Delivery pipeline" card** (Mockup → Website build → WordPress → Launch & SEO → Maintenance) whose single button advances to the next real stage: **one-click Build full website** (`POST /api/builds` with `DEFAULT_PAGES` + `start:true`, then navigates to the build) when a mockup exists and no build yet; otherwise it links into the right workspace (build → `/wp/new?build=`, etc.). WordPress onward needs live-site credentials so those stages are navigations, not silent runs. The old right-column "Pipeline" card (mockup-generation steps) was renamed **"Mockup steps"** to avoid confusion.
  - **Learned feedback**: every rating comment / change request is stored globally (`DATA/feedback-notes.json`, `addFeedbackNote`/`listFeedbackNotes`) and injected into future generate prompts as "LEARNED PREFERENCES" so corrections don't repeat.
  - **Design variety**: `pickDesignSystem` now rotates across measured systems for unmatched verticals (was always the single most-versatile → the "all look the same" bug). Niche libraries still use the `recipe.ts` mixer. New design sets: see `design-library/README.md`.
  - **Moc queue (preferred over recipe/system)** `server/pipeline/mocs.ts`: the real fix for "every niche gets the same template". Instead of feeding rules + fragments, it shows the model **one whole finished homepage design** ("moc") and has it **clone that exact layout** re-skinned with the lead's brand/logo/photos/facts. One moc is consumed per generation (the next in the niche's pool) and retired to the "gutter" (used list, persisted in `DATA/moc-usage.json`); the next generation pulls the next moc, wrapping around when all are used. Niche is keyword-matched (`MOC_NICHES`, 24 niches + `general` catch-all). Mocs live in `design-library/<niche>/mocs/*.{webp,jpg,png,avif}`, named `1,2,3…` (data-dir copy overrides the repo one, so no rebuild to add). In `generate.ts`, moc wins over recipe/ds; amend/gate-retry reuse the stored moc (`design.json.{mocNiche,moc}`), fresh/sameness advance. Owner uploads mocs; see `design-library/MOCS.md` for the niche list + how-to.
    - **No-moc fallback = Dribbble, then recipe/system** `server/pipeline/dribbble.ts`: when no uploaded moc matches (a listed niche with an empty pool, or an unlisted vertical), instead of the one generic layout it fetches a fresh, niche-appropriate shot from Dribbble (Playwright, `dribbble.com/search/shots/popular/web-design?q=…`) and clones THAT like a moc. Shots cached in `DATA/dribbble-cache/<query>/`, with a per-query used list (`DATA/dribbble-usage.json`) that paginates so each fresh run pulls a different design. Best-effort — offline/blocked returns null and it falls back to the recipe mixer → measured design-system rotation (both already vary per lead). In `generate.ts`, order is **library moc → Dribbble → recipe → design-system**; amend reuses the stored `design.json.{moc|dribbble}`.
  - **Session-mode image fix (why mocs looked generic)** `server/claude/sessionRunner.ts`: session mode (`claude -p`) doesn't attach images as vision — it tells Claude to open them with the Read tool, which is sandboxed to the lead folder. Reference designs (moc/Dribbble shot, recipe crops, design-system slices) live OUTSIDE that folder, so Claude never saw them and the page came out generic. Fix: copy any out-of-folder image into `<leadDir>/_refs/` and reference those. (API mode already sends real base64 image blocks, so it was unaffected.) The generate step note now says which design was used — `Cloned moc: hvac/3.webp` / `Cloned a Dribbble design` / `Recipe mix: …` / `Design system: …` (`designSourceLabel` in `queue.ts`) — so it's visible whether a moc was actually used.
  - **Stop / abort a run** `server/claude/abort.ts` (per-lead `AbortController` registry) + `stopLead` in `queue.ts` + `POST /api/leads/:id/stop` + a **Stop** button on the lead page (shown while queued/running). Stop kills the in-flight AI call (session: `child.kill()`; API: stream `signal`), drops a queued job, resets the running step to pending and sets a new `"stopped"` LeadStatus (clean cancel, not "failed"); re-running resumes. The signal is threaded via `RunRequest.signal`, set in `runClaude` from the registry. Non-AI steps (Playwright capture) stop at the next AI checkpoint rather than mid-call.
  - **Friendly errors** `server/pipeline/errors.ts` `humanError()`: the UI never shows raw Playwright/AI logs (e.g. "page.goto: Timeout 45000ms exceeded…"). `queue.ts` maps every failure (and step note) to a short plain line ("The website took too long to respond — it may be down, very slow, or blocking automated visits."); the raw error still goes to the console. `ClaudeUnavailableError`'s own message is already friendly and passes through.
  - **Playbook + outreach draft** (after the gate, cached to the lead folder): `server/playbook.ts` (`POST /api/playbook/:id`, plain-text brief) is separate from the outreach email `server/pitch.ts` (`POST /api/pitch/:id`). Both shown on the detail page (`outreach`/`playbook` in `/api/leads/:id`).
  - **Outreach tab** (`LeadDetail.tsx`, a dedicated tab between Redesign and SEO; replaced the old outreach-email modal): edits the pitch (subject/body, Regenerate via `/api/pitch`) and actually **sends** it over the outreach mailbox SMTP — `POST /api/leads/:id/send-email` (`server/index.ts`) reuses `outreach()`/`outreachReady()`/`mockupPreview()` (`automations/engine.ts`) + `sendMail` (`golive/smtp.ts`), optional mockup-preview JPEG attachment; plus Copy and mailto. `/api/leads/:id` now returns `emailReady` (SMTP configured) so the Send button is gated. A **WhatsApp** card prefills a message (seeded with the published mockup link) and opens `wa.me`, plus a `tel:` call button. The detail-page lead-detail tabs are Overview · Redesign · Outreach · SEO audit · Competitors · How to close.
    - **Send test to me**: `send-email` with `{test:true}` goes to your own outreach address (subject prefixed `[TEST]`) and is not logged against the lead.
    - **Outreach history**: sending an email, or opening WhatsApp/the dialer, stamps `Lead.lastContactedAt` and prepends a dated line to `Lead.notes` (recent-first) via `logContact` — the email send does it inline, WhatsApp/call via `POST /api/leads/:id/contacted {channel}`. "Last contacted" shows in the Overview "At a glance" card; the client keeps the Notes card in sync without clobbering unsaved edits.
    - **Live-link check**: when the mockup is published and its URL isn't in the email body, the tab shows an "Add it" prompt (appends the live link) and a confirm before sending without it.
  - **Mobile header rule + gate check**: generate prompt rule 7 (`generate.ts`, in shared `SYSTEM_RULES` so clone mode gets it too) requires the mobile header to be just logo + hamburger, with CTAs moved to a **sticky bottom action bar** on mobile. Enforced by `mobileHeaderCheck()` (`capture.ts`, browser-side) → gate check "Mobile header (logo + menu only)" (`gate.ts`), which feeds back into the regenerate pass. The gate also saves a mobile screenshot of the mockup to `mockup-mobile.jpg`.
  - **Publish live (Hostinger SFTP)** `server/publish/hostinger.ts`: `POST|DELETE /api/leads/:id/publish`, uploads `mockup/`+`assets/` to a subdomain folder, stores `lead.publish.url`. Creds in Settings → Integrations (`hostingSftp*`, `hostingBasePath`, `hostingPublicBaseUrl`, `autoPublishOnReady`; password sealed). The live URL feeds the outreach email/playbook and the automations `{{mockup_url}}`.
- **Automations** (`server/automations/*`, `web/src/pages/automations/Workflows.tsx`): a visual workflow builder, plus the older "Quick campaigns" (`server/campaigns`). Reply tracking now **branches** instead of only stopping: `wf_replies.sentiment` (heuristic `classifyReply`, from subject + a peeked body snippet via `inboxSince(..., withText)`), a `reply_sentiment` condition field, a wait mode **"reply"** (continue on reply or after N days), a `mark_dead` action, and a `{{mockup_url}}` variable. A workflow that reacts to replies (`branchesOnReply`) keeps running on reply; others stop as before. New **"followup"** template (`routes.ts`): mockup → email → wait for reply → positive ⇒ notify "move to full build?" / negative ⇒ one follow-up → wait → mark dead.
- **Lead Finder** (`server/finder/*`): Google Maps scraping, then enrichment (emails, WhatsApp) and a fit score. Also has a **Meta leads** tab (`web/src/pages/finder/MetaLeads.tsx`, `MetaLeadDetail.tsx`): a separate `MetaLead` model/table (`server/finder/metaStore.ts`, routes `server/finder/metaRoutes.ts` at `/api/meta`) for ad-form leads, distinct from the Google Maps `Prospect`. Captures Facebook/Instagram Lead Ads (the existing Meta webhook in `server/intake.ts` now stores every lead here, website or not, and links a Mockup when the form has a URL), plus manual add and CSV import (header-mapped, de-duped on email/leadgen id). Status pipeline new→contacted→qualified→won→lost; a lead with a website can be handed to Mockups, which then flows through the normal Build → WordPress → Launch/SEO → Maintenance path on the resulting mockup `Lead` (those stay manual per-workspace steps).
  - **Website + tags + pipeline tracker** (`MetaLead.website`, `labels`, `activity[]`, `followUpAt`): the manual add form and the detail page take a `website` so a hand-added lead can start a mockup; the mockup route injects it as a `Website` field and carries the lead's labels onto the mockup `Lead`. Every Meta-workspace lead auto-carries the `META_TAG` ("Meta ads") tag (enforced in `metaStore.ts` `fill`/`hydrate`); "Premium" is a manual toggle, plus free-form tags. A timestamped **pipeline timeline** (`MetaActivity`, kinds in `META_ACTIVITY`: contacted / follow_up / mockup_created / mockup_sent / proposal_sent / note / status) is logged via `POST /api/meta/leads/:id/activity` (helper `logMetaActivity`); logging a contact nudges new→contacted, status changes auto-log, scheduling a follow-up sets `followUpAt` (surfaced on the list as a "Follow-ups due" filter + column, overdue in red) and `…/activity/clear-followup` marks it done. CSV export gained Website + Follow-up columns.
  - **Next change (not built): the live Facebook Lead Ads API/token setup UI.**
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
- **Linux build:** the `build.linux` config targets AppImage + `.deb` (x64). Scripts `npm run dist:linux` (customer) / `npm run dist:owner:linux` (owner) → `release/Weborite-Studio-<version>.AppImage` + `.deb`. electron-builder can only build Linux targets **on Linux**, so on the owner's Windows box use WSL/Ubuntu or Docker (`electronuserland/builder`), or let the release workflow's `linux` job build it. The code is already cross-platform: `server/vault.ts` has no DPAPI off Windows so the vault key is stored raw (protected only by file perms — acceptable per-user), and `aiRoutes.ts` opens `x-terminal-emulator` for CLI sign-in on Linux. Linux **auto-update is not wired** yet (AppImage supports it, `.deb` doesn't; `upload-updates.mjs` still only pushes the Windows `.exe`/`latest.yml`).
- **macOS build:** the `build.mac` config targets `.dmg` + `.zip` (arm64 + x64). Scripts `npm run dist:mac` / `npm run dist:owner:mac` → `release/Weborite-Studio-<version>-<arch>.dmg`. electron-builder can only build mac targets **on macOS**, so build on a Mac or via the release workflow's `macos` job (there's no Windows cross-build for mac). **Unsigned** (`mac.identity: null`, `CSC_IDENTITY_AUTO_DISCOVERY=false`): Gatekeeper will block it, so users right-click → Open (or `xattr -dr com.apple.quarantine <app>`). Notarisation/signing needs an Apple Developer ID cert + `CSC_LINK`/`CSC_KEY_PASSWORD` later. Mac auto-update isn't wired (same as Linux).
- **Releases:** `.github/workflows/release.yml` runs when `.github/release-notes/v<version>.md` is pushed (or on a `v*` tag). Three jobs: **`windows`** (windows-latest) builds the NSIS `.exe`, **`linux`** (ubuntu-latest) builds the AppImage + `.deb`, and **`macos`** (macos-latest) builds the `.dmg`; all attach to the same GitHub release.
  - It builds the installer(s), then creates the tag and a GitHub release with the `.exe` (+ AppImage/`.deb` + `.dmg`) attached.
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
  - the Dribbble no-moc fallback (`server/pipeline/dribbble.ts`) against live Dribbble — untested; it's best-effort and falls back to the recipe/design-system rotation if Dribbble is slow, offline, bot-blocked, or changes its markup
- Reply tracking reads INBOX only (not spam). Opens and clicks aren't tracked.
- The installer isn't code-signed, so SmartScreen warns (both the first install and each auto-update). Adding an OV/EV cert later also lets electron-updater verify the publisher — drop it into the release workflow's build step; no code change needed.
- Not built: mockup protection / watermarked previews (a LinkedIn question is still unanswered). Revoke the old test license key E832F624-… as the owner planned.
- Auto-update untested against the live Hostinger feed (needs the `UPDATE_SFTP_*` secrets set and the first updater-enabled build installed by hand). Confirm `release/latest.yml` is produced by `npm run dist` on the first release.

## Security review (AFINE desktop checklist) — done 2026-10-02

- Audited against the AFINE desktop checklist. Strong already: DPAPI-wrapped AES-GCM vault (`server/vault.ts`), loopback-only API with anti-rebind/anti-CSRF/traversal guards (`server/security.ts` `localOnly`), parameterized SQL, untrusted data to CLIs on stdin (never interpolated), SSRF guards on scraping, Ed25519 licence with nonce binding, Electron contextIsolation/sandbox/no-nodeIntegration.
- Fixed this session: (1) Meta webhook now **fails closed** when no app secret is set (`server/intake.ts`); (2) SFTP publish **verifies the host key** (trust-on-first-use, pinned in `DATA/sftp-known-hosts.json`) so the Hostinger password can't be MITM'd (`server/publish/hostinger.ts`); (3) `codexPath`/`geminiPath` validated against shell metacharacters like `claudePath` (`server/index.ts`); (4) brand assets served with a bare `sandbox` CSP so an uploaded SVG can't run script (`server/index.ts`).
- Lower priority / by design, not changed: `runAsNode` fuse stays on (needed for the Playwright install; env-var/inspect fuses are off); `customCommand` runs via shell by design (user-set, CSRF-protected).

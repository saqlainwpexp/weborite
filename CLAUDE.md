# Weborite Studio: project memory

Read this first in every new session. It records what the app is, how it's built and shipped, the decisions already made, and what's still open. Keep it up to date when something here changes.

## The product

**Weborite Studio** (package name `mockup-studio`) is a Windows desktop app for web design agencies. It's sold by Weborite Solutions (Pakistan, hello@weborite.com), whose owner is the user. Its website is **studio.weborite.com**; weborite.com is the owner's agency portfolio and is a separate thing.

Stack: Electron shell (`electron/main.mjs`), an Express + TypeScript server (`server/`, run with tsx in dev and bundled for the app), a React + Vite UI (`web/src/`), shared types in `shared/types.ts`, SQLite via `node:sqlite` (`server/db.ts`), and Playwright/Chromium for browsing and screenshots.

Workspaces (switcher in `web/src/layout/Layout.tsx`, flags in `shared/features.ts`):

- **Mockups** (`server/queue.ts`, `server/pipeline/*`): capture → diagnose → benchmark set per vertical → AI generates the homepage → quality gate → side-by-side render.
- **Automations** (`server/automations/*`, `web/src/pages/automations/Workflows.tsx`): a visual workflow builder, plus the older "Quick campaigns" (`server/campaigns`).
- **Lead Finder** (`server/finder/*`): Google Maps scraping, then enrichment (emails, WhatsApp) and a fit score.
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
- Current version: **0.3.0**. The repo `saqlainwpexp/weborite` is private.

## Licensing and website

- `site/` is the static website for studio.weborite.com, hosted on Hostinger.
  - It uses clean URLs via `.htaccess`, with a buy page, a demo page and legal pages.
  - `site/license/` is a PHP license server (SQLite, Ed25519-signed responses; the app verifies them with the public key). Lemon Squeezy wasn't usable because it requires Stripe, which doesn't work in Pakistan.
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

- The owner still needs to add the `LICENSE_PUBLIC_KEY` repo secret, or build locally.
- Never tested against real services:
  - signed-in Codex or Gemini CLI, and valid OpenAI or Gemini keys
  - a real Gmail IMAP inbox or real SMTP sending
  - live Google Maps scraping in the fixed customer build
- Reply tracking reads INBOX only (not spam). Opens and clicks aren't tracked.
- The installer isn't code-signed, so SmartScreen warns.
- Not built: mockup protection / watermarked previews (a LinkedIn question is still unanswered). Revoke the old test license key E832F624-… as the owner planned.

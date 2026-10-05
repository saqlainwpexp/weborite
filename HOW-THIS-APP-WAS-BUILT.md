# How Weborite Studio Was Built — A Simple Guide

This doc explains, in plain English, how the whole app is put together and how the main pieces work. No computer-science degree needed. Read it top to bottom and you'll understand your own product.

---

## 1. What the app actually is

Weborite Studio is a **Windows desktop program**. But under the hood, it's really a little **website running inside its own window**.

Think of it like this:

- There's a **web page** (the screens you click around in).
- There's a **small server** (the brain that does the work — talks to AI, saves data, takes screenshots).
- There's a **shell** that wraps both of those into one `.exe` you can install.

That "shell" is a tool called **Electron**. Electron is how apps like Slack, VS Code, and WhatsApp Desktop are made. It lets you build a desktop app using normal website technology.

So the app is three layers glued together:

| Layer | What it is | In this project |
|-------|-----------|-----------------|
| **The shell** | The window + install file | `electron/main.mjs` |
| **The brain (server)** | Does the real work | `server/` folder |
| **The face (UI)** | What you see and click | `web/src/` folder |

They all run on your own PC. Nothing is hosted online — the whole thing lives inside the installed app.

---

## 2. The three layers, one by one

### The face — what you see (`web/`)

This is built with **React** (a popular tool for building screens) and **Vite** (a tool that bundles the screens up fast).

Every page you click — Mockups, Lead Finder, Automations, Settings — is a file in `web/src/pages/`. For example:
- `web/src/pages/Leads.tsx` is the list of leads.
- `web/src/pages/Settings.tsx` is the settings screen (the Hosting form you just saw lives here).

The face **can't do anything by itself**. When you click a button, it sends a message to the brain and shows whatever comes back.

### The brain — the server (`server/`)

This is the part that actually works. It's built with **Express** (a tool for handling those messages) and **TypeScript** (JavaScript with safety checks).

The brain listens for messages like "make a mockup for this lead" or "save these settings", does the job, and sends an answer back. These message addresses are called **routes** — e.g. `POST /api/leads/:id/publish` means "publish this lead's mockup".

The brain only listens to **your own PC** (localhost), so nobody on the internet can reach it. That's a deliberate safety choice.

### The shell — Electron (`electron/`)

Electron opens the window, loads the face inside it, starts the brain in the background, and handles desktop things like the app icon, the menu, and **auto-updates**. It's the glue that turns a website into a real installable program.

---

## 3. Where data is stored

The app uses **SQLite** — a tiny database that's just a single file on your PC (no separate database server needed). It keeps your leads, settings, licence info, and so on. The code for this is in `server/db.ts`.

Bigger files (screenshots, the generated mockups, cached AI results) are saved as normal files in folders, one folder per lead.

---

## 4. How a mockup gets made (the heart of the app)

This is the most important part. When you ask for a mockup, the brain runs a **pipeline** — a series of steps, like an assembly line. The steps live in `server/pipeline/`:

1. **Capture** — A hidden browser (a tool called **Playwright**, which drives a real Chrome) visits the prospect's current website and takes screenshots.
2. **Diagnose** — AI looks at the site and finds what's wrong (slow, ugly on mobile, bad for Google, etc.).
3. **Benchmark** — It gathers examples of great sites in that business's industry, so the new design has something good to aim for.
4. **Pick a design** — It chooses a design style. (There's a clever bit here that *rotates* styles so every mockup doesn't look the same.)
5. **Generate** — AI writes a brand-new homepage using the prospect's own words, colours, and photos.
6. **Quality gate** — It checks the result is actually good before showing it. If it fails, it tries again or picks a different design.
7. **Render** — It shows the old site and the new one side by side.

After that, two more things are prepared automatically:
- An **outreach email** (the sales email you send the prospect) — `server/pitch.ts`.
- A **playbook** (a plan for winning the client) — `server/playbook.ts`.

And if you turned on auto-publish, the mockup is **uploaded live** to your Hostinger subdomain so the email can link a real page.

---

## 5. The AI part

Every AI task — diagnosing, generating, writing emails — goes through **one single door** in the code: a function called `runClaude` in `server/claude/runner.ts`.

Why one door? So you can **swap which AI does the work** without changing anything else. In Settings → AI you can pick Claude, OpenAI, Gemini, and others. The rest of the app doesn't care which one you chose — it just asks `runClaude` and gets text back.

---

## 6. The other workspaces

Each tab in the app is its own mini-section of the brain, all built the same way (a page in `web/`, routes in `server/`):

- **Lead Finder** — scrapes Google Maps for businesses, finds their emails, scores how good a fit they are.
- **Automations** — a drag-and-drop builder for "when X happens, do Y" (e.g. find leads → make mockups → email them → follow up). An engine checks every few seconds whether any step is due.
- **Builds / WordPress / SEO / Maintenance** — turn approved mockups into real finished websites and keep them healthy.

They all reuse the same shared tools: the one AI door, the one database, the same job system.

---

## 7. Running many jobs at once

Making a mockup takes time. If you had 10 leads, you wouldn't want to wait for them one by one. So there's a small **job queue** (`server/pool.ts`) that runs a few jobs side by side (3 by default), while making sure it never runs two for the same lead at once. Settings let you change how many run together.

---

## 8. How it's turned into a sellable product

### Two kinds of build

- `npm run dist` → the **customer build**. The code is scrambled (obfuscated) so people can't copy it, and licensing is switched on. This is what you sell. Until someone enters a licence key, it runs in **demo mode** (a 7-day free trial with limits).
- `npm run dist:owner` → the **owner build**. Readable code, no licensing. For your eyes only — never share it.

### Licensing

The app checks a licence key to decide if someone has paid. It uses a signed "certificate" system (Ed25519) — the key is verified using a public key stored in the code, so a licence can't be faked. The licence server is a small PHP site on Hostinger (`site/license/`).

### The demo (free trial)

Defined in `shared/demo.ts`: 7 days, with limits like 5 mockups, 2 searches, 2 automations. Everything else (like setting up SMTP email and Hostinger publishing) is fully available in the trial so people can test the real thing.

---

## 9. How updates reach customers

New versions update themselves using **electron-updater**. Here's the flow:

1. You build a new version → it produces `Weborite-Studio-Setup.exe`, a `.blockmap`, and a `latest.yml` (a little label file that says "here's the newest version and its name").
2. You upload those 3 files to `studio.weborite.com/updates/`.
3. Installed apps quietly check that `latest.yml`, see a newer version, and offer to update.

The first version has to be installed by hand (because older copies had no updater yet). After that, updates are automatic.

---

## 10. The map — where to find things

```
electron/        → the app window + auto-update
server/          → the brain (all the real work)
  pipeline/      → the mockup assembly line
  claude/        → the single AI "door"
  automations/   → the workflow engine
  finder/        → Lead Finder (Google Maps scraping)
  publish/       → upload mockups live to Hostinger
  db.ts          → the database
web/src/         → the screens you click
  pages/         → one file per page
shared/          → things both brain and face use (types, demo limits)
site/            → the public website + licence server
scripts/         → build tools (packaging, obfuscation)
```

---

## 11. The one-paragraph summary

Weborite Studio is a **website in a desktop wrapper**. The **face** (React) shows the screens, the **brain** (an Express server on your own PC) does the work, and **Electron** packages them into a `.exe`. The brain uses a **hidden browser** to screenshot sites, **one swappable AI door** to generate designs and emails, and a **small file database** to remember everything. It's built two ways — a locked customer version with a free-trial demo, and an open owner version — and it keeps itself up to date by downloading new versions from your Hostinger site.

That's the whole thing. Everything else is detail built on top of these ideas.

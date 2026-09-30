import { Router } from "express";
import { exec, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSettings } from "../db.ts";
import { runClaude } from "./runner.ts";

export const ai = Router();

const version = (command: string) =>
  new Promise<string | null>((resolve) => {
    const win = process.platform === "win32";
    const cmd = `${win && command.includes(" ") ? `"${command}"` : command} --version`;
    exec(cmd, { timeout: 15000, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout.trim().split("\n")[0].slice(0, 80)));
  });

/** Which sign-in CLIs are installed. */
ai.get("/status", async (_req, res) => {
  const s = getSettings();
  const [claude, codex, gemini] = await Promise.all([version(s.claudePath || "claude"), version(s.codexPath || "codex"), version(s.geminiPath || "gemini")]);
  res.json({ claude, codex, gemini });
});

/** Opens a terminal window running the tool's own sign-in (the browser opens for ChatGPT / Google / Claude). */
ai.post("/login", (req, res) => {
  const s = getSettings();
  const tool = String(req.body?.tool ?? "");
  const command = tool === "codex" ? `${s.codexPath || "codex"} login` : tool === "gemini" ? s.geminiPath || "gemini" : tool === "claude" ? s.claudePath || "claude" : "";
  if (!command) return res.status(400).json({ error: "Unknown tool" });
  try {
    // Verbatim so cmd sees the quotes exactly: start "title" cmd /k <command>
    if (process.platform === "win32") spawn("cmd.exe", ["/d", "/s", "/c", `start "Sign in" cmd /k ${command}`], { detached: true, stdio: "ignore", windowsHide: false, windowsVerbatimArguments: true }).unref();
    else if (process.platform === "darwin") spawn("osascript", ["-e", `tell application "Terminal" to do script "${command.replace(/"/g, '\\"')}"`, "-e", 'tell application "Terminal" to activate'], { detached: true, stdio: "ignore" }).unref();
    else spawn("x-terminal-emulator", ["-e", command], { detached: true, stdio: "ignore" }).unref();
    res.json({ ok: true, command });
  } catch (e) {
    res.status(500).json({ error: `Couldn't open a terminal: ${(e as Error).message}. Run "${command}" yourself.`, command });
  }
});

/** A tiny request through the chosen provider, to check it's set up. */
ai.post("/test", async (_req, res) => {
  const dir = mkdtempSync(join(tmpdir(), "studio-ai-test-"));
  const t = Date.now();
  try {
    const r = await runClaude({ leadId: "", task: "agent", system: "You are a connection test.", prompt: "Reply with exactly: OK", cwd: dir });
    res.json({ ok: /\bok\b/i.test(r.text), text: r.text.slice(0, 200), ms: Date.now() - t });
  } catch (e) {
    res.json({ ok: false, text: (e as Error).message.slice(0, 400), ms: Date.now() - t });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

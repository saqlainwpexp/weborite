import { spawn } from "node:child_process";
import { relative } from "node:path";
import { ClaudeUnavailableError, type RunRequest, type RunResult } from "./runner.ts";

/**
 * Runs Claude Code headless (`claude -p`) using whatever account the CLI is logged in with,
 * so a Pro/Max subscription covers the usage instead of per-token API billing.
 */
export function runSession(req: RunRequest, opts: { claudePath: string; model: string }): Promise<RunResult> {
  const imageNote = req.images?.length
    ? `\n\nBefore answering, open and look at these image files with the Read tool:\n${req.images
        .map((p) => "- " + relative(req.cwd, p).replace(/\\/g, "/"))
        .join("\n")}`
    : "";
  const prompt = `${req.prompt}${imageNote}\n\nReply with the final answer only, in the exact format requested.`;

  const tools = ["Read", "Glob", "Grep"];
  if (req.web) tools.push("WebSearch", "WebFetch");

  const args = [
    "-p",
    "--output-format", "json",
    "--model", opts.model,
    "--allowedTools", tools.join(","),
    "--disallowedTools", "Bash,Edit,Write,NotebookEdit",
    "--max-turns", req.web ? "40" : "12",
  ];

  return new Promise((resolve, reject) => {
    const win = process.platform === "win32";
    const cmd = win && opts.claudePath.includes(" ") ? `"${opts.claudePath}"` : opts.claudePath;
    const child = spawn(cmd, args, { cwd: req.cwd, shell: win, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) =>
      reject(new ClaudeUnavailableError(`Could not start Claude Code (${opts.claudePath}): ${e.message}. Install it with "npm i -g @anthropic-ai/claude-code" and run "claude" once to log in.`)),
    );
    child.on("close", (code) => {
      let parsed: { result?: string; is_error?: boolean; total_cost_usd?: number; subtype?: string } | null = null;
      try {
        parsed = JSON.parse(out);
      } catch {
        /* fall through */
      }
      if (!parsed) {
        const msg = (err || out).trim().slice(0, 400);
        if (code !== 0 && /not.*(logged|authenticat)|login|recognized|not found/i.test(msg)) return reject(new ClaudeUnavailableError(msg));
        return reject(new Error(`Claude Code exited with ${code}: ${msg}`));
      }
      if (parsed.is_error || !parsed.result) {
        const msg = parsed.result || parsed.subtype || "unknown error";
        if (/not logged in|\/login|authenticat|credential/i.test(msg)) return reject(new ClaudeUnavailableError(`Claude Code isn't logged in. Run "claude" in a terminal and log in. (${msg})`));
        if (/limit|usage/i.test(msg)) return reject(new ClaudeUnavailableError(`Plan usage limit reached: ${msg}`));
        return reject(new Error(`Claude Code error: ${msg}`));
      }
      resolve({ text: parsed.result, costUsd: parsed.total_cost_usd ?? 0 });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

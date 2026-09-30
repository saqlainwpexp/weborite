import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ClaudeUnavailableError, type RunRequest, type RunResult } from "./runner.ts";

/**
 * Other AI providers, behind the same "prompt (+ images, + web research) in, text out" contract as Claude:
 *  - OpenAI API (Responses API) and Codex CLI (sign in with ChatGPT)
 *  - Gemini API and Gemini CLI (sign in with Google)
 *  - any OpenAI-compatible API: OpenRouter, Groq, DeepSeek, Mistral, Together, Ollama, LM Studio…
 *  - a custom command: any agent CLI that reads the prompt on stdin and prints the answer
 */

const mime = (p: string) => (p.endsWith(".png") ? "image/png" : p.endsWith(".webp") ? "image/webp" : "image/jpeg");
const b64 = (p: string) => readFileSync(p).toString("base64");
const maxTokens = (req: RunRequest) => (req.heavy ? 32000 : 12000);

async function post(url: string, body: unknown, headers: Record<string, string>, provider: string) {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(15 * 60e3) });
  } catch (e) {
    throw new ClaudeUnavailableError(`Couldn't reach ${provider}: ${(e as Error).message}`);
  }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const err = json.error as { message?: string } | string | undefined;
    const msg = (typeof err === "string" ? err : err?.message) || text.slice(0, 300);
    if (res.status === 401 || res.status === 403 || /api key (is )?(not valid|invalid)|invalid api key/i.test(msg)) throw new ClaudeUnavailableError(`${provider} rejected the API key: ${msg}`);
    if (res.status === 429) throw new ClaudeUnavailableError(`${provider} rate limit or quota reached: ${msg}`);
    if (res.status >= 500) throw new ClaudeUnavailableError(`${provider} is having problems (${res.status}): ${msg}`);
    throw new Error(`${provider} ${res.status}: ${msg}`);
  }
  return json;
}

/* ---------- OpenAI (Responses API) ---------- */

export async function runOpenAIApi(req: RunRequest, opts: { apiKey: string; model: string }): Promise<RunResult> {
  if (!opts.apiKey) throw new ClaudeUnavailableError("OpenAI is selected but no OpenAI API key is saved in Settings → AI.");
  const content: unknown[] = [{ type: "input_text", text: req.prompt }];
  for (const p of req.images ?? []) content.push({ type: "input_image", image_url: `data:${mime(p)};base64,${b64(p)}` });
  const body = (tool?: string) => ({
    model: opts.model,
    instructions: req.system,
    input: [{ role: "user", content }],
    max_output_tokens: maxTokens(req),
    ...(tool ? { tools: [{ type: tool }] } : {}),
  });
  let json: Record<string, unknown>;
  try {
    json = await post("https://api.openai.com/v1/responses", body(req.web ? "web_search" : undefined), { Authorization: `Bearer ${opts.apiKey}` }, "OpenAI");
  } catch (e) {
    // Older accounts and models only know the preview name of the web search tool.
    if (req.web && /web_search/i.test((e as Error).message)) json = await post("https://api.openai.com/v1/responses", body("web_search_preview"), { Authorization: `Bearer ${opts.apiKey}` }, "OpenAI");
    else throw e;
  }
  const output = (json.output ?? []) as { type: string; content?: { type: string; text?: string }[] }[];
  const text = output.filter((o) => o.type === "message").flatMap((o) => o.content ?? []).filter((c) => c.type === "output_text").map((c) => c.text ?? "").join("");
  if (!text) throw new Error(`OpenAI returned no text (${String((json.incomplete_details as { reason?: string })?.reason ?? json.status ?? "empty")})`);
  return { text, costUsd: 0 };
}

/* ---------- Gemini API ---------- */

export async function runGeminiApi(req: RunRequest, opts: { apiKey: string; model: string }): Promise<RunResult> {
  if (!opts.apiKey) throw new ClaudeUnavailableError("Gemini is selected but no Gemini API key is saved in Settings → AI.");
  const parts: unknown[] = [{ text: req.prompt }];
  for (const p of req.images ?? []) parts.push({ inline_data: { mime_type: mime(p), data: b64(p) } });
  const json = await post(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`,
    {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts }],
      generationConfig: { maxOutputTokens: req.heavy ? 60000 : 16000 },
      ...(req.web ? { tools: [{ google_search: {} }] } : {}),
    },
    { "x-goog-api-key": opts.apiKey },
    "Gemini",
  );
  const cand = ((json.candidates ?? []) as { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[])[0];
  const text = (cand?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("");
  if (!text) throw new Error(`Gemini returned no text (${cand?.finishReason ?? (json.promptFeedback as { blockReason?: string })?.blockReason ?? "empty"})`);
  return { text, costUsd: 0 };
}

/* ---------- OpenAI-compatible chat completions (OpenRouter, Groq, DeepSeek, Ollama…) ---------- */

export async function runCompatible(req: RunRequest, opts: { baseUrl: string; apiKey: string; model: string; name: string; webSuffix?: string }): Promise<RunResult> {
  if (!opts.baseUrl) throw new ClaudeUnavailableError(`${opts.name}: add the API address in Settings → AI.`);
  if (!opts.model) throw new ClaudeUnavailableError(`${opts.name}: enter a model name in Settings → AI.`);
  const content: unknown[] = [{ type: "text", text: req.prompt }];
  for (const p of req.images ?? []) content.push({ type: "image_url", image_url: { url: `data:${mime(p)};base64,${b64(p)}` } });
  const model = req.web && opts.webSuffix && !opts.model.endsWith(opts.webSuffix) ? opts.model + opts.webSuffix : opts.model;
  const json = await post(
    `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`,
    { model, max_tokens: maxTokens(req), messages: [{ role: "system", content: req.system }, { role: "user", content: req.images?.length ? content : req.prompt }] },
    { ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}), "HTTP-Referer": "https://studio.weborite.com", "X-Title": "Weborite Studio" },
    opts.name,
  );
  const choice = ((json.choices ?? []) as { message?: { content?: string | { type: string; text?: string }[] }; finish_reason?: string }[])[0];
  const c = choice?.message?.content;
  const text = typeof c === "string" ? c : (c ?? []).map((x) => x.text ?? "").join("");
  if (!text) throw new Error(`${opts.name} returned no text (${choice?.finish_reason ?? "empty"})`);
  return { text, costUsd: 0 };
}

/* ---------- command-line agents (sign in with your ChatGPT or Google account) ---------- */

function spawnCli(command: string, args: string[], input: string, cwd: string, name: string, loginHint: string): Promise<{ out: string; err: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const win = process.platform === "win32";
    const cmd = win && command.includes(" ") && !command.startsWith('"') ? `"${command}"` : command;
    const quoted = win ? args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args;
    const child = spawn(cmd, quoted, { cwd, shell: win, windowsHide: true, env: process.env });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), 30 * 60e3);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ClaudeUnavailableError(`Couldn't start ${name} (${command}): ${e.message}. ${loginHint}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const all = `${err}\n${out}`;
      if (code !== 0 && /not (logged|signed) in|login required|please (log|sign) ?in|unauthori[sz]ed|401|auth(entication)? (required|failed)|no credentials|set an auth method/i.test(all)) {
        return reject(new ClaudeUnavailableError(`${name} isn't signed in. ${loginHint}`));
      }
      if (code !== 0 && /(is not recognized|command not found|ENOENT|cannot find)/i.test(all)) return reject(new ClaudeUnavailableError(`${name} isn't installed. ${loginHint}`));
      if (code !== 0 && /rate limit|quota|usage limit|too many requests|429/i.test(all)) return reject(new ClaudeUnavailableError(`${name} usage limit reached: ${all.trim().slice(-300)}`));
      resolve({ out, err, code });
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

const withSystem = (req: RunRequest, extra = "") => `${req.system}\n\n---\n\n${req.prompt}${extra}\n\nReply with the final answer only, in the exact format requested. Don't edit or create any files.`;

/** OpenAI Codex CLI, signed in with a ChatGPT account (`codex login`). */
export async function runCodexCli(req: RunRequest, opts: { command: string; model: string }): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), "studio-codex-"));
  const last = join(dir, "last.txt");
  try {
    // --search (live web search) belongs to the main codex command, before "exec".
    const args = [...(req.web ? ["--search"] : []), "exec", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", "--output-last-message", last];
    if (opts.model) args.push("--model", opts.model);
    for (const p of req.images ?? []) args.push(`--image=${p}`);
    args.push("-");
    const r = await spawnCli(opts.command || "codex", args, withSystem(req), req.cwd, "Codex CLI", 'Install it with "npm i -g @openai/codex", then use Sign in under Settings → AI (or run "codex login").');
    let text = "";
    try {
      text = readFileSync(last, "utf8").trim();
    } catch {
      text = r.out.trim();
    }
    if (r.code !== 0 || !text) throw new Error(`Codex CLI exited with ${r.code}: ${(r.err || r.out).trim().slice(-400)}`);
    return { text, costUsd: 0 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Google Gemini CLI, signed in with a Google account (run `gemini` once and choose "Login with Google"). */
export async function runGeminiCli(req: RunRequest, opts: { command: string; model: string }): Promise<RunResult> {
  // Gemini CLI reads files named with @path (images included) relative to the folder it runs in.
  const images = req.images?.length ? `\n\nLook at these images before answering:\n${req.images.map((p) => "@" + relative(req.cwd, p).replace(/\\/g, "/")).join("\n")}` : "";
  // -p makes it headless (the instructions come on stdin); plan mode is read-only.
  const args = ["-p", "Follow the instructions above.", "--output-format", "json", "--approval-mode", "plan"];
  if (opts.model) args.push("--model", opts.model);
  const r = await spawnCli(opts.command || "gemini", args, withSystem(req, images), req.cwd, "Gemini CLI", 'Install it with "npm i -g @google/gemini-cli", then use Sign in under Settings → AI (or run "gemini" and choose Login with Google).');
  let text = "";
  try {
    const j = JSON.parse(r.out.slice(r.out.indexOf("{"))) as { response?: string; error?: { message?: string } };
    if (j.error?.message) throw new Error(j.error.message);
    text = (j.response ?? "").trim();
  } catch (e) {
    if (r.out.trim().startsWith("{")) throw e;
    text = r.out.trim();
  }
  if (r.code !== 0 || !text) throw new Error(`Gemini CLI exited with ${r.code}: ${(r.err || r.out).trim().slice(-400)}`);
  return { text, costUsd: 0 };
}

/** Any other agent CLI: the prompt goes in on stdin, the answer comes back on stdout. */
export async function runCustomCli(req: RunRequest, opts: { command: string; model: string }): Promise<RunResult> {
  if (!opts.command.trim()) throw new ClaudeUnavailableError("Custom command is selected but no command is set in Settings → AI.");
  const images = req.images?.length ? `\n\nImage files to look at (paths relative to the current folder):\n${req.images.map((p) => "- " + relative(req.cwd, p).replace(/\\/g, "/")).join("\n")}` : "";
  const command = opts.command.replace(/\{model\}/g, opts.model);
  const r = await new Promise<{ out: string; err: string; code: number | null }>((resolve, reject) => {
    const child = spawn(command, { cwd: req.cwd, shell: true, windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), 30 * 60e3);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(new ClaudeUnavailableError(`Couldn't start the custom command: ${e.message}`)));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ out, err, code });
    });
    child.stdin.write(withSystem(req, images));
    child.stdin.end();
  });
  if (r.code !== 0 || !r.out.trim()) throw new Error(`The custom command exited with ${r.code}: ${(r.err || r.out).trim().slice(-400)}`);
  return { text: r.out.trim(), costUsd: 0 };
}

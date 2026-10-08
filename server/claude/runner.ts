import { getSettings, recordRun } from "../db.ts";
import { abortSignal } from "./abort.ts";
import { runSession } from "./sessionRunner.ts";
import { runApi } from "./apiRunner.ts";
import { runCloud } from "./cloudRunner.ts";
import { runCodexCli, runCompatible, runCustomCli, runGeminiApi, runGeminiCli, runOpenAIApi } from "./providers.ts";
import type { AiModelKey } from "../../shared/types.ts";

export interface RunRequest {
  leadId: string;
  task: "diagnose" | "vertical" | "benchmarks" | "generate" | "build" | "seo" | "qualify" | "agent";
  system: string;
  prompt: string;
  /** Absolute paths to PNG/JPEG files Claude should look at. */
  images?: string[];
  /** Allow live web research (benchmark building). */
  web?: boolean;
  /** Working folder: session mode runs the CLI here so Claude can read lead files. */
  cwd: string;
  /** Use the heavier generation model (otherwise the fast model). */
  heavy?: boolean;
  /** Set by runClaude from the abort registry; lets the provider kill the call when Stop is pressed. */
  signal?: AbortSignal;
}

export interface RunResult {
  text: string;
  costUsd: number;
}

export class ClaudeUnavailableError extends Error {}

/** Runs a request on whichever AI is chosen in Settings → AI (the name stays: it began as Claude-only). */
export async function runClaude(req: RunRequest): Promise<RunResult> {
  const s = getSettings();
  req.signal ??= abortSignal(req.leadId); // let the Stop button kill this call

  if (s.aiProvider && s.aiProvider !== "claude") {
    const key: AiModelKey = s.aiProvider === "openai" ? `openai-${s.openaiAccess}` : s.aiProvider === "gemini" ? `gemini-${s.geminiAccess}` : s.aiProvider;
    const m = s.aiModels[key] ?? { heavy: "", fast: "" };
    const model = (req.heavy ? m.heavy : m.fast) || m.heavy || m.fast;
    const result =
      key === "openai-api" ? await runOpenAIApi(req, { apiKey: s.openaiKey, model })
      : key === "openai-login" ? await runCodexCli(req, { command: s.codexPath, model })
      : key === "gemini-api" ? await runGeminiApi(req, { apiKey: s.geminiKey, model })
      : key === "gemini-login" ? await runGeminiCli(req, { command: s.geminiPath, model })
      : key === "openrouter" ? await runCompatible(req, { baseUrl: "https://openrouter.ai/api/v1", apiKey: s.openrouterKey, model, name: "OpenRouter", webSuffix: ":online" })
      : key === "compatible" ? await runCompatible(req, { baseUrl: s.compatibleBaseUrl, apiKey: s.compatibleKey, model, name: "The AI API" })
      : await runCustomCli(req, { command: s.customCommand, model });
    recordRun(req.leadId, key, req.task, 0);
    return result;
  }
  const model = req.heavy ? s.generateModel : s.fastModel;
  const result =
    s.mode === "api"
      ? await runApi(req, { apiKey: s.apiKey, model })
      : s.mode === "cloud"
        ? await runCloud(req, { triggerUrl: s.cloudTriggerUrl, triggerToken: s.cloudTriggerToken, githubToken: s.githubToken, repo: s.cloudRepo, branch: s.cloudBranch, model })
        : await runSession(req, { claudePath: s.claudePath, model });
  recordRun(req.leadId, s.mode, req.task, s.mode === "api" ? result.costUsd : 0);
  return result;
}

/** Pull the first fenced block of the given language, or the whole text if none. */
export function extractFenced(text: string, lang: string): string {
  const re = new RegExp("```" + lang + "\\s*\\n([\\s\\S]*?)```", "i");
  const m = text.match(re);
  if (m) return m[1].trim();
  return text.trim();
}

/**
 * The first real JSON value in a reply. Models sometimes put prose or bracketed placeholders ("[placeholder]",
 * "[Your name]") before the JSON, so each "{" or "[" is tried in turn, matched to its closing bracket (strings
 * respected), and the first block that parses wins. Objects and arrays are preferred over bare tokens.
 */
export function extractJson<T>(text: string): T {
  for (const body of [extractFenced(text, "json"), text]) {
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (c !== "{" && c !== "[") continue;
      const end = matchBracket(body, i);
      if (end < 0) continue;
      try {
        return JSON.parse(body.slice(i, end + 1)) as T;
      } catch {
        /* not JSON (e.g. "[placeholder]"): try the next bracket */
      }
    }
  }
  throw new Error(`The AI's answer had no valid JSON in it: “${text.trim().slice(0, 120)}${text.trim().length > 120 ? "…" : ""}”. Try again, or pick a stronger model in Settings → AI.`);
}

/** Index of the bracket that closes the one at `start`, skipping brackets inside strings; -1 if unbalanced. */
function matchBracket(s: string, start: number) {
  const stack: string[] = [];
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

export function extractHtml(text: string): string {
  const fenced = extractFenced(text, "html");
  const start = fenced.search(/<!doctype html|<html/i);
  const end = fenced.lastIndexOf("</html>");
  if (start === -1 || end === -1) throw new Error("Claude did not return a complete HTML document");
  return fenced.slice(start, end + "</html>".length);
}

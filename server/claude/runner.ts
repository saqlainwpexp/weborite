import { getSettings, recordRun } from "../db.ts";
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
}

export interface RunResult {
  text: string;
  costUsd: number;
}

export class ClaudeUnavailableError extends Error {}

/** Runs a request on whichever AI is chosen in Settings → AI (the name stays: it began as Claude-only). */
export async function runClaude(req: RunRequest): Promise<RunResult> {
  const s = getSettings();
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

export function extractJson<T>(text: string): T {
  const body = extractFenced(text, "json");
  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  return JSON.parse(body.slice(start, end + 1)) as T;
}

export function extractHtml(text: string): string {
  const fenced = extractFenced(text, "html");
  const start = fenced.search(/<!doctype html|<html/i);
  const end = fenced.lastIndexOf("</html>");
  if (start === -1 || end === -1) throw new Error("Claude did not return a complete HTML document");
  return fenced.slice(start, end + "</html>".length);
}

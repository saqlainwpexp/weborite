import { getSettings, recordRun } from "../db.ts";
import { runSession } from "./sessionRunner.ts";
import { runApi } from "./apiRunner.ts";

export interface RunRequest {
  leadId: string;
  task: "diagnose" | "vertical" | "benchmarks" | "generate" | "build" | "seo" | "qualify" | "bid";
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
  /** Text-only answer with every tool switched off (the prompt holds untrusted third-party text). */
  noTools?: boolean;
}

export interface RunResult {
  text: string;
  costUsd: number;
}

export class ClaudeUnavailableError extends Error {}

export async function runClaude(req: RunRequest): Promise<RunResult> {
  const s = getSettings();
  const result =
    s.mode === "api"
      ? await runApi(req, { apiKey: s.apiKey, model: req.heavy ? s.generateModel : s.fastModel })
      : await runSession(req, { claudePath: s.claudePath, model: req.heavy ? s.generateModel : s.fastModel });
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

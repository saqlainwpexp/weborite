import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { ClaudeUnavailableError, type RunRequest, type RunResult } from "./runner.ts";

// USD per million tokens (input, output).
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5": [5, 25],
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
};

export async function runApi(req: RunRequest, opts: { apiKey: string; model: string }): Promise<RunResult> {
  if (!opts.apiKey) throw new ClaudeUnavailableError("API mode is selected but no Anthropic API key is saved in Settings.");
  const client = new Anthropic({ apiKey: opts.apiKey });

  const content: Anthropic.ContentBlockParam[] = [];
  for (const path of req.images ?? []) {
    const media_type = path.endsWith(".png") ? "image/png" : path.endsWith(".webp") ? "image/webp" : "image/jpeg";
    content.push({ type: "image", source: { type: "base64", media_type, data: readFileSync(path).toString("base64") } });
  }
  content.push({ type: "text", text: req.prompt });

  const tools: Anthropic.ToolUnion[] = req.web
    ? [{ type: "web_search_20260209", name: "web_search", max_uses: 12 } as Anthropic.ToolUnion]
    : [];

  const messages: Anthropic.MessageParam[] = [{ role: "user", content }];
  let text = "";
  let cost = 0;
  const [pin, pout] = PRICES[opts.model] ?? [5, 25];

  try {
    // Loop only to resume server-tool turns that pause (long web research).
    for (let i = 0; i < 5; i++) {
      const stream = client.messages.stream({
        model: opts.model,
        max_tokens: req.heavy ? 64000 : 16000,
        thinking: { type: "adaptive" },
        output_config: { effort: req.heavy ? "high" : "medium" },
        system: req.system,
        messages,
        ...(tools.length ? { tools } : {}),
      }, { signal: req.signal }); // Stop button aborts the request
      const msg = await stream.finalMessage();
      const u = msg.usage;
      cost += ((u.input_tokens + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0) * 0.1) * pin + u.output_tokens * pout) / 1e6;
      if ((u.server_tool_use?.web_search_requests ?? 0) > 0) cost += (u.server_tool_use!.web_search_requests * 10) / 1000;

      if (msg.stop_reason === "refusal") throw new Error("Claude declined this request.");
      text += msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      if (msg.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: msg.content });
    }
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new ClaudeUnavailableError("The saved Anthropic API key was rejected.");
    if (e instanceof Anthropic.RateLimitError) throw new ClaudeUnavailableError("Anthropic API rate limit reached. The job will retry later.");
    throw e;
  }
  return { text, costUsd: cost };
}

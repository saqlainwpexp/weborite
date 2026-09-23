import { Router } from "express";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "../db.ts";
import { runClaude, ClaudeUnavailableError } from "../claude/runner.ts";
import { PAGES, TOOLS, byName, type Args } from "./tools.ts";

/**
 * The floating in-app assistant. It works in both Claude modes by running a plain text loop: each
 * turn Claude replies with one JSON object — call a tool, open a page, or give a final answer. Read
 * tools run straight away; write tools stop and are sent back for the user to confirm before running.
 */

export const agent = Router();

const AGENT_DIR = join(DATA, "agent");
mkdirSync(AGENT_DIR, { recursive: true });

type Step = { role: "user" | "assistant" | "observation"; text: string };
const MAX_STEPS_PER_TURN = 6;

const toolDocs = () =>
  TOOLS.map((t) => {
    const args = Object.entries(t.args).map(([k, d]) => `${k} (${d})`).join(", ") || "no arguments";
    return `- ${t.name}${t.write ? t.danger ? " [WRITE, DANGER]" : " [WRITE]" : ""}: ${t.desc} Arguments: ${args}.`;
  }).join("\n");

function system(overview: string) {
  return `You are the assistant built into Weborite Studio, a desktop app a web agency uses to run its work. You help the owner get things done across the app by calling tools. Today is ${new Date().toISOString().slice(0, 10)}.

You cannot run code, browse the web, or read files yourself — the ONLY way you can do anything or find anything out is by calling the tools below. Never try to perform a task directly; emit the matching tool action instead.

Reply with EXACTLY ONE JSON object and nothing else, in a \`\`\`json code block. It must be one of:
1. Call a tool:      {"thought": "why", "action": "<tool name>", "args": { ... }}
2. Open a page:      {"navigate": "<page name or /path>", "say": "one short sentence to the user"}
3. Final answer:     {"final": "your message to the user"}

Use the exact tool name in "action" and the exact argument names listed. Example — to check a site's speed:
{"thought": "The user wants a page-speed test.", "action": "speed_test", "args": {"siteUrl": "https://example.com"}}

Rules:
- Gather what you need with read tools (they run immediately and you get an Observation back) before acting.
- For any WRITE tool, just emit the action. The app shows the user a confirmation with a Run button and only then runs it — you do NOT ask "shall I?" in text; emit the action and let the app confirm. After it runs you get the result as an Observation.
- Resolve sites by whatever the user typed (a URL or a name); the tools match loosely.
- Prefer the specific tool. For "check the speed of X" use speed_test. Only navigate when no tool fits (e.g. starting a full build or WordPress conversion, which need details you should let the user fill in on the page).
- Keep final answers short and concrete. Mention what you did and, when useful, that results appear on the relevant page.

Tools:
${toolDocs()}

Pages you can navigate to (by name): ${Object.keys(PAGES).join(", ")}. You may also navigate to any /path.

Current state:
${overview}`;
}

function parse(reply: string): { action?: string; args?: Args; final?: string; navigate?: string; say?: string; thought?: string } | null {
  const fenced = reply.match(/```json\s*([\s\S]*?)```/i)?.[1] ?? reply;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    const obj = JSON.parse(fenced.slice(start, end + 1));
    if (obj && typeof obj === "object" && !obj.action && typeof obj.tool === "string") obj.action = obj.tool;
    return obj;
  } catch {
    return null;
  }
}

const clip = (s: string, n = 4000) => (s.length > n ? s.slice(0, n) + "…" : s);

function renderPrompt(steps: Step[]) {
  const recent = steps.slice(-24);
  const body = recent
    .map((s) => (s.role === "user" ? `User: ${s.text}` : s.role === "assistant" ? `You: ${s.text}` : `Observation: ${clip(s.text)}`))
    .join("\n\n");
  return `${body}\n\nReply with the next single JSON object.`;
}

async function think(steps: Step[], overview: string): Promise<string> {
  // Session mode (the Claude CLI) ignores the separate system field, so fold it into the prompt too.
  const sys = system(overview);
  const prompt = `${sys}\n\n--- Conversation so far ---\n\n${renderPrompt(steps)}`;
  const { text } = await runClaude({ leadId: "agent", task: "agent", system: sys, prompt, cwd: AGENT_DIR });
  return text;
}

async function overviewText(): Promise<string> {
  try {
    return clip(JSON.stringify(await byName("get_overview")!.run({}), null, 1), 2500);
  } catch {
    return "(could not load the overview)";
  }
}

function resolveNavigate(target: string): string {
  const t = String(target || "").trim();
  if (t.startsWith("/")) return t;
  return PAGES[t.toLowerCase()] ?? "/";
}

/**
 * Advance the conversation. Body: { steps, approve? }.
 *  - approve === true/false answers a pending write (the last assistant step is its action).
 *  - otherwise the last step is a new user message.
 * Returns { steps, done, reply?, pending?, navigate? }.
 */
agent.post("/", async (req, res) => {
  const steps: Step[] = Array.isArray(req.body?.steps) ? req.body.steps.filter((s: Step) => s && typeof s.text === "string" && ["user", "assistant", "observation"].includes(s.role)).slice(-60) : [];
  const approve: boolean | undefined = typeof req.body?.approve === "boolean" ? req.body.approve : undefined;
  if (!steps.length) return res.status(400).json({ error: "No conversation" });

  const overview = await overviewText();
  let justRanWrite = false;

  try {
    // Resolve a pending write the user just answered.
    if (approve !== undefined) {
      const last = [...steps].reverse().find((s) => s.role === "assistant");
      const parsed = last && parse(last.text);
      const tool = parsed?.action ? byName(parsed.action) : undefined;
      if (!tool || !tool.write) return res.status(400).json({ error: "There is no action waiting to be confirmed." });
      if (!approve) {
        steps.push({ role: "observation", text: "The user declined this action. Do not run it." });
      } else {
        try {
          const result = await tool.run((parsed!.args ?? {}) as Args);
          steps.push({ role: "observation", text: `Ran ${tool.name}. Result: ${clip(JSON.stringify(result))}` });
          justRanWrite = true;
        } catch (e) {
          steps.push({ role: "observation", text: `Ran ${tool.name} but it failed: ${(e as Error).message}` });
        }
      }
    }

    for (let i = 0; i < MAX_STEPS_PER_TURN; i++) {
      const reply = await think(steps, overview);
      const parsed = parse(reply);
      steps.push({ role: "assistant", text: reply.trim() });

      if (!parsed) {
        steps.push({ role: "observation", text: "That was not a single valid JSON object. Reply with one JSON object as instructed." });
        continue;
      }
      if (typeof parsed.final === "string") return res.json({ steps, done: true, reply: parsed.final });
      if (typeof parsed.navigate === "string") {
        return res.json({ steps, done: true, reply: parsed.say || "Opening that now.", navigate: resolveNavigate(parsed.navigate) });
      }
      const tool = parsed.action ? byName(parsed.action) : undefined;
      if (!tool) {
        steps.push({ role: "observation", text: `There is no tool called "${parsed.action}". Use one of: ${TOOLS.map((t) => t.name).join(", ")}.` });
        continue;
      }
      if (tool.write && !justRanWrite) {
        // Stop and let the user confirm before anything changes.
        return res.json({ steps, done: false, pending: { tool: tool.name, args: parsed.args ?? {}, summary: tool.summary((parsed.args ?? {}) as Args), danger: Boolean(tool.danger) } });
      }
      justRanWrite = false;
      if (tool.write) {
        // A write reached here only right after approval: already handled above; guard just in case.
        continue;
      }
      try {
        const result = await tool.run((parsed.args ?? {}) as Args);
        steps.push({ role: "observation", text: `${tool.name} → ${clip(JSON.stringify(result))}` });
      } catch (e) {
        steps.push({ role: "observation", text: `${tool.name} failed: ${(e as Error).message}` });
      }
    }
    return res.json({ steps, done: true, reply: "I've done what I can for now. Tell me the next step, or check the relevant page." });
  } catch (e) {
    if (e instanceof ClaudeUnavailableError) return res.status(503).json({ error: (e as Error).message, steps });
    return res.status(500).json({ error: (e as Error).message, steps });
  }
});

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { CLOUD_ROUTINE_PROMPT } from "../../shared/cloudPrompt.ts";
import { ClaudeUnavailableError, type RunRequest, type RunResult } from "./runner.ts";

/**
 * Cloud mode: hands the job to a Claude Code cloud session instead of the local CLI, so the work is
 * covered by the claude.ai plan's cloud usage.
 *
 * GitHub is the mailbox. We commit jobs/<id>/job.json (+ images) to a branch, fire a Routine through
 * its API trigger, and poll the same branch until the cloud session commits jobs/<id>/result.txt
 * (or error.txt). The routine is optional: without one, a cloud session running the cloud-worker skill
 * works through the queue instead. The Routine's saved prompt is CLOUD_ROUTINE_PROMPT (shared/cloudPrompt.ts).
 */

export interface CloudOpts {
  /** Optional. Without a routine, a cloud session running the cloud-worker skill picks jobs up. */
  triggerUrl: string; // https://api.anthropic.com/v1/claude_code/routines/trig_.../fire
  triggerToken: string;
  githubToken: string;
  repo: string; // owner/name
  branch: string; // must start with claude/ so the cloud session may push to it
  model: string;
}

export { CLOUD_ROUTINE_PROMPT };

const POLL_MS = 15_000;
const TIMEOUT_MS = 40 * 60_000;
const WORKER_TIMEOUT_MS = 3 * 60 * 60_000;

function gh(opts: CloudOpts, path: string, init: RequestInit = {}) {
  return fetch(`https://api.github.com/repos/${opts.repo}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${opts.githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

async function ensureBranch(opts: CloudOpts) {
  const ref = encodeURIComponent(`heads/${opts.branch}`);
  const has = await gh(opts, `/git/ref/${ref}`);
  if (has.ok) return;
  if (has.status === 401 || has.status === 403) throw new ClaudeUnavailableError(`GitHub token can't access ${opts.repo} (HTTP ${has.status}). It needs Contents: read & write.`);
  const repo = await gh(opts, "");
  if (!repo.ok) throw new ClaudeUnavailableError(`GitHub repo ${opts.repo} not reachable (HTTP ${repo.status})`);
  const { default_branch } = (await repo.json()) as { default_branch: string };
  const base = await gh(opts, `/git/ref/${encodeURIComponent(`heads/${default_branch}`)}`);
  if (!base.ok) throw new Error(`Could not read ${default_branch} on ${opts.repo}: HTTP ${base.status}`);
  const { object } = (await base.json()) as { object: { sha: string } };
  const made = await gh(opts, "/git/refs", { method: "POST", body: JSON.stringify({ ref: `refs/heads/${opts.branch}`, sha: object.sha }) });
  if (!made.ok && made.status !== 422) throw new Error(`Could not create branch ${opts.branch}: HTTP ${made.status}`);
}

async function putFile(opts: CloudOpts, path: string, content: Buffer, message: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await gh(opts, `/contents/${path}`, {
      method: "PUT",
      body: JSON.stringify({ message, content: content.toString("base64"), branch: opts.branch }),
    });
    if (r.ok) return;
    if (r.status !== 409 && r.status !== 422) throw new Error(`GitHub upload of ${path} failed: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
  }
  throw new Error(`GitHub upload of ${path} kept conflicting`);
}

async function readFile(opts: CloudOpts, path: string): Promise<string | null> {
  const r = await gh(opts, `/contents/${path}?ref=${encodeURIComponent(opts.branch)}`, { headers: { Accept: "application/vnd.github.raw+json" } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub read of ${path} failed: HTTP ${r.status}`);
  return r.text();
}

export async function runCloud(req: RunRequest, opts: CloudOpts): Promise<RunResult> {
  if (!opts.githubToken || !/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new ClaudeUnavailableError("Cloud mode needs a GitHub token and a repo like owner/name (Settings → Claude).");
  if (!opts.branch.startsWith("claude/")) throw new ClaudeUnavailableError('Cloud branch must start with "claude/" so the cloud session is allowed to push to it.');

  const id = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${req.leadId.replace(/[^\w-]/g, "").slice(0, 24)}-${req.task}`;
  const dir = `jobs/${id}`;
  await ensureBranch(opts);

  const images = (req.images ?? []).map((p, i) => ({ p, name: `img-${i + 1}${extname(p) || ".png"}` }));
  for (const img of images) await putFile(opts, `${dir}/${img.name}`, readFileSync(img.p), `cloud job ${id}: ${basename(img.p)}`);
  const job = { system: req.system, prompt: req.prompt, images: images.map((i) => i.name), web: Boolean(req.web), model: opts.model, task: req.task };
  await putFile(opts, `${dir}/job.json`, Buffer.from(JSON.stringify(job, null, 2)), `cloud job ${id}`);

  // With a routine configured, start a cloud session for this job. Without one (or when the routine
  // is out of runs), the job waits on the branch for a worker session (.claude/skills/cloud-worker).
  let routineStarted = false;
  if (opts.triggerUrl && opts.triggerToken) {
    const fire = await fetch(opts.triggerUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.triggerToken}`,
        "anthropic-beta": "experimental-cc-routine-2026-04-01",
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: `repo: ${opts.repo}\nbranch: ${opts.branch}\njob folder: ${dir}` }),
    });
    if (fire.ok) routineStarted = true;
    else if (fire.status === 401 || fire.status === 403) throw new ClaudeUnavailableError(`Routine trigger rejected the token (HTTP ${fire.status}): ${(await fire.text()).slice(0, 300)}`);
    else console.warn(`[cloud] routine trigger failed (HTTP ${fire.status}); job ${id} waits for a worker session`);
  }
  const timeoutMs = routineStarted ? TIMEOUT_MS : WORKER_TIMEOUT_MS;

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((res) => setTimeout(res, POLL_MS));
    const result = await readFile(opts, `${dir}/result.txt`);
    if (result) return { text: result, costUsd: 0 };
    const error = await readFile(opts, `${dir}/error.txt`);
    if (error) throw new Error(`Cloud session couldn't finish: ${error.slice(0, 400)}`);
  }
  throw new Error(`Cloud job ${id} timed out after ${timeoutMs / 60_000} minutes${routineStarted ? "" : " (no worker session picked it up: open a claude.ai/code session on the repo and say \"run the cloud worker\")"}`);
}

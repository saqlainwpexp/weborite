// Cloud-mode worker helper, run inside a claude.ai/code session (see .claude/skills/cloud-worker).
//   node scripts/cloud-worker.mjs pending   list queued jobs (job folders with no result/error yet)
//   node scripts/cloud-worker.mjs wait      block until at least one job is queued, then list them
//   node scripts/cloud-worker.mjs done <job folder>   commit + push that job's result.txt / error.txt
// Jobs live on the claude/cloud-jobs branch (override with CLOUD_BRANCH), checked out at .cloud-jobs/.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const branch = process.env.CLOUD_BRANCH || "claude/cloud-jobs";
const dir = resolve(".cloud-jobs");
const git = (...a) => execFileSync("git", a, { cwd: existsSync(dir) ? dir : ".", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function sync() {
  if (!existsSync(dir)) {
    execFileSync("git", ["fetch", "-q", "origin", branch]);
    execFileSync("git", ["worktree", "add", "-q", "--detach", dir, `origin/${branch}`]);
  }
  git("fetch", "-q", "origin", branch);
  git("reset", "-q", "--hard", `origin/${branch}`);
}

function pending() {
  sync();
  const jobs = join(dir, "jobs");
  if (!existsSync(jobs)) return [];
  return readdirSync(jobs, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(jobs, d.name))
    .filter((p) => existsSync(join(p, "job.json")) && !existsSync(join(p, "result.txt")) && !existsSync(join(p, "error.txt")))
    .sort();
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "pending") {
  console.log(pending().join("\n") || "(no queued jobs)");
} else if (cmd === "wait") {
  for (;;) {
    const p = pending();
    if (p.length) {
      console.log(p.join("\n"));
      break;
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
} else if (cmd === "done" && arg) {
  const job = resolve(arg);
  const out = ["result.txt", "error.txt"].map((f) => join(job, f)).filter(existsSync);
  if (!out.length) throw new Error(`write result.txt or error.txt in ${job} first`);
  git("add", ...out);
  git("commit", "-q", "-m", `cloud job ${job.split(/[\\/]/).pop()}: done`);
  for (let i = 0; ; i++) {
    try {
      git("push", "-q", "origin", `HEAD:${branch}`);
      break;
    } catch (e) {
      if (i >= 4) throw e;
      git("pull", "-q", "--rebase", "origin", branch);
    }
  }
  console.log("pushed", out.join(", "));
} else {
  console.log("usage: node scripts/cloud-worker.mjs pending | wait | done <job folder>");
}

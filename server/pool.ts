import { getSettings } from "./db.ts";

/**
 * A job queue that runs several jobs at once (up to `limit()`), but never two jobs with the same key at the
 * same time: two mockups run side by side, while the pages of one WordPress conversion still go one by one.
 */
export class Pool<J> {
  private waiting: J[] = [];
  private active = new Map<string, J>();

  constructor(
    private key: (job: J) => string,
    private limit: () => number,
    private run: (job: J) => Promise<void>,
  ) {}

  /** Add a job unless an equal one is already waiting (`same` decides equality; default: same key). */
  push(job: J, same: (a: J, b: J) => boolean = (a, b) => this.key(a) === this.key(b)) {
    if (!this.waiting.some((w) => same(w, job))) this.waiting.push(job);
    this.pump();
  }

  remove(pred: (job: J) => boolean) {
    this.waiting = this.waiting.filter((j) => !pred(j));
  }

  isActive(key: string) {
    return this.active.has(key);
  }
  isQueued(pred: (job: J) => boolean) {
    return this.waiting.some(pred);
  }
  get running() {
    return this.active.size;
  }
  get queued() {
    return this.waiting.length;
  }
  activeJobs() {
    return [...this.active.values()];
  }
  queuedJobs() {
    return [...this.waiting];
  }

  private pump() {
    while (this.active.size < Math.max(1, this.limit())) {
      const i = this.waiting.findIndex((j) => !this.active.has(this.key(j)));
      if (i < 0) return;
      const [job] = this.waiting.splice(i, 1);
      const k = this.key(job);
      this.active.set(k, job);
      void this.run(job)
        .catch((e) => console.error("[pool]", e))
        .finally(() => {
          this.active.delete(k);
          this.pump();
        });
    }
  }
}

/** How many jobs of each kind run at once (Settings → Claude → Parallel jobs). */
export function parallel(kind: "ai" | "searches" | "care") {
  const s = getSettings() as unknown as { parallelJobs?: number; parallelSearches?: number };
  const ai = Math.max(1, Math.min(8, Number(s.parallelJobs) || 3));
  if (kind === "searches") return Math.max(1, Math.min(4, Number(s.parallelSearches) || 2));
  // Maintenance clones and updates are heavy on the client's server and on this computer.
  if (kind === "care") return Math.min(2, ai);
  return ai;
}

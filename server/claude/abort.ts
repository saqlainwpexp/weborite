/**
 * Per-lead abort registry. When a mockup job runs we register an AbortController for its lead; the
 * "Stop" button aborts it, which kills the in-flight AI process (see sessionRunner / apiRunner) so
 * generation actually ends instead of running to completion no matter what.
 */
const controllers = new Map<string, AbortController>();

/** Begin a cancellable run for a lead (replaces any previous controller). */
export function startAbort(leadId: string): AbortController {
  const ac = new AbortController();
  controllers.set(leadId, ac);
  return ac;
}

/** The signal to pass into AI calls for this lead, if a run is registered. */
export function abortSignal(leadId: string): AbortSignal | undefined {
  return controllers.get(leadId)?.signal;
}

/** True while a cancellable run is registered (i.e. the lead is actively running). */
export function isRunning(leadId: string): boolean {
  return controllers.has(leadId);
}

/** Request cancellation of a lead's run. Returns true if there was a run to abort. */
export function abortLead(leadId: string): boolean {
  const ac = controllers.get(leadId);
  if (!ac) return false;
  ac.abort();
  return true;
}

export function clearAbort(leadId: string) {
  controllers.delete(leadId);
}

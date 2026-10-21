// Pure batching helper, split out of workflow.ts so it can be unit-tested
// directly — workflow.ts imports "cloudflare:workers"/"cloudflare:workflows"
// at module scope, which vitest's plain node environment can't resolve (see
// vitest.config.ts: Workers-runtime pieces are exercised via `wrangler dev`).

/** Split `items` into consecutive chunks of at most `size`, preserving order. */
export function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

/** True when `e` is a Workflow instance-creation collision ("this id already
 * exists") rather than a genuine failure. A `Workflow.create()` call whose
 * `step.do()` gets re-invoked for the same logical run (the platform's own
 * at-least-once execution model — see the Workflows "Idempotency Violation"
 * gotcha) hits exactly this on its second invocation, once the first one's
 * create already succeeded. Matched on message text (case-insensitive,
 * against both the "instance.already_exists" code and its "Instance already
 * exists" prose) since the SDK doesn't expose a typed error class for it. */
export function isInstanceAlreadyExistsError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /already[_ ]exists/i.test(message);
}

/** True when `message` names Cloudflare's own "WorkflowInternalError" /
 * "Attempt failed due to internal workflows error" — a documented,
 * long-standing platform-level fault (see e.g. github.com/cloudflare/
 * workers-sdk issues and the Cloudflare community forum), not something
 * caused by anything in this codebase. This repo has hit it since at least
 * 2026-08-04, on ordinary cities, well before enrichment batching existed —
 * every recorded occurrence has been on a different city/florist, with no
 * evidence any specific content triggers it. runEnrichBatches retries the
 * affected batch with a fresh instance id when it sees this, rather than
 * failing the whole job over a platform blip. */
export function isPlatformInternalError(message: string | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return m.includes("internal workflows error") || m.includes("workflowinternalerror");
}

import "server-only";

// Thin server-only client for the one thing the dashboard asks the ingest worker
// to do on demand: run the reconcile sweep (or reconcile a single order). The
// reconcile logic lives only in the worker (ingest-worker/src/reconcile.ts) — it
// needs the ORDER_QUEUE binding and the worker's Shopify creds — so we call it
// rather than duplicate it here.
//
// Requires two env vars, server-side only:
//   INGEST_WORKER_URL — the worker's base URL (e.g. https://facundo-ingest-worker.<sub>.workers.dev)
//   OUTBOX_SECRET      — the shared secret the worker already uses to call back
//                        into the dashboard; reused here to gate the inbound call.

export interface ReconcileSweepResult {
  ran: boolean;
  reason?: string;
  backfilled: string[];
  parkedChecked: number;
  healed: string[];
  /** Order ids whose tags were refreshed (missing or stale), in any non-'received'
   * status. Optional: a worker deployed before
   * ingest-worker/src/reconcile.ts::backfillMissingTags won't send it. */
  tagsBackfilled?: string[];
  /** True when the self-heal / tag-backfill passes hit their per-tick cap this
   * run — i.e. the parked/tag-stale population wasn't fully covered, not that
   * it's exhausted. Optional: a worker deployed before this field existed won't
   * send it. */
  parkedCapped?: boolean;
  tagsCapped?: boolean;
}

export interface ReconcileOrderResult {
  found: boolean;
  reason?: string;
  result?: "matched" | "updated" | "noop";
  tags?: string | null;
}

/** One order's outcome from a batch retry (see reconcileOrders below). */
export interface ReconcileOrdersResultItem {
  orderId: string;
  result: ReconcileOrderResult;
}

type Ok<T> = { ok: true; data: T };
type Err = { ok: false; status: number; error: string };

function workerBase(): string | null {
  const u = process.env.INGEST_WORKER_URL?.trim();
  return u ? u.replace(/\/+$/, "") : null;
}

async function callReconcile<T>(body: Record<string, unknown>): Promise<Ok<T> | Err> {
  const base = workerBase();
  const secret = process.env.OUTBOX_SECRET;
  if (!base) return { ok: false, status: 501, error: "INGEST_WORKER_URL is not set — can't reach the ingest worker." };
  if (!secret) return { ok: false, status: 501, error: "OUTBOX_SECRET is not set — can't authenticate to the ingest worker." };

  let res: Response;
  try {
    res = await fetch(`${base}/reconcile`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-outbox-secret": secret },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, status: 502, error: `Could not reach the ingest worker: ${e instanceof Error ? e.message : "network error"}` };
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    return { ok: false, status: 502, error: `Ingest worker returned ${res.status}. ${detail}` };
  }
  const data = (await res.json().catch(() => null)) as T | null;
  if (data == null) return { ok: false, status: 502, error: "Ingest worker returned an unreadable response." };
  return { ok: true, data };
}

/** Force a full reconcile sweep now (bypasses the worker's hourly throttle). */
export function reconcileSweep(): Promise<Ok<ReconcileSweepResult> | Err> {
  return callReconcile<ReconcileSweepResult>({});
}

/** Arm (or stop) the full-table catch-up sweep. The sweep itself runs on the
 *  worker's per-minute cron — this only flips the flag, so it returns at once
 *  rather than holding a request open for the ~hour the pass takes. */
export function reconcileAll(mode: "dry" | "apply" | "stop"): Promise<Ok<{ ok: boolean }> | Err> {
  return callReconcile<{ ok: boolean }>({ all: mode });
}

/** Reconcile a single order now (re-pull the full Shopify order + re-evaluate). */
export function reconcileOrder(orderId: string): Promise<Ok<ReconcileOrderResult> | Err> {
  return callReconcile<ReconcileOrderResult>({ orderId });
}

/** Retry a specific batch of orders now — e.g. the ids a full-table sweep logged
 *  as failed (External ops → provider "shopify", operation "reconcile_all",
 *  ok=false). Loops the same per-order reconcile reconcileOrder() above uses;
 *  there's no discovery here, the caller supplies the ids explicitly. */
export function reconcileOrders(orderIds: string[]): Promise<Ok<ReconcileOrdersResultItem[]> | Err> {
  return callReconcile<ReconcileOrdersResultItem[]>({ orderIds });
}

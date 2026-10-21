import { createServiceClient } from "@/lib/supabaseAdmin";
import { captureError } from "@/lib/monitor";

// Durable effects outbox — enqueue + claim/mark primitives. The actual effect
// handlers (payout retry, writeback, notify) live in lib/outboxDrain.ts so this
// module stays import-cycle-free (payout.ts enqueues from here).

export type EffectKind = "payout" | "shopify_writeback" | "notify_client";

// Backoff schedule in minutes, indexed by attempt count.
export const BACKOFF_MIN = [1, 5, 15, 60, 180, 720];

export interface OutboxRow {
  id: string;
  kind: EffectKind;
  payload: Record<string, unknown>;
  order_id: string | null;
  status: "pending" | "done" | "dead";
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
}

// Enqueue an effect. `dedupeKey` guarantees at most one PENDING effect for it
// (a done/dead effect doesn't block re-enqueue). Never throws.
export async function enqueueEffect(
  kind: EffectKind,
  payload: Record<string, unknown>,
  opts?: { orderId?: string | null; dedupeKey?: string },
): Promise<void> {
  try {
    const admin = createServiceClient();
    const { error } = await admin.from("outbox").insert({
      kind, payload, order_id: opts?.orderId ?? null, dedupe_key: opts?.dedupeKey ?? null,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase error is untyped
    if (error && (error as any).code !== "23505") captureError("outbox.enqueue_failed", error); // 23505 = a pending effect already queued
  } catch (e) {
    captureError("outbox.enqueue_threw", e);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase admin client is loosely typed
type Admin = any;

// Lease one due pending effect (push next_attempt_at forward so a concurrent
// drain skips it). Guarded on (id, attempts) so exactly one drainer wins.
export async function leaseEffect(admin: Admin, row: OutboxRow): Promise<boolean> {
  const lease = new Date(Date.now() + 5 * 60_000).toISOString();
  const { data } = await admin.from("outbox")
    .update({ next_attempt_at: lease, updated_at: new Date().toISOString() })
    .eq("id", row.id).eq("status", "pending").eq("attempts", row.attempts)
    .select("id");
  return !!data?.length;
}

export async function markDone(admin: Admin, id: string, attempts: number): Promise<void> {
  await admin.from("outbox").update({ status: "done", attempts, last_error: null, updated_at: new Date().toISOString() }).eq("id", id);
}

export async function markResult(admin: Admin, row: OutboxRow, error: string): Promise<"retry" | "dead"> {
  const attempts = (row.attempts ?? 0) + 1;
  if (attempts >= (row.max_attempts ?? BACKOFF_MIN.length)) {
    await admin.from("outbox").update({ status: "dead", attempts, last_error: error, updated_at: new Date().toISOString() }).eq("id", row.id);
    return "dead";
  }
  const backoff = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)];
  await admin.from("outbox").update({
    attempts, last_error: error, next_attempt_at: new Date(Date.now() + backoff * 60_000).toISOString(), updated_at: new Date().toISOString(),
  }).eq("id", row.id);
  return "retry";
}

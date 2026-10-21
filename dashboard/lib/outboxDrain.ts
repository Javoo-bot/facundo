import { createServiceClient } from "@/lib/supabaseAdmin";
import { leaseEffect, markDone, markResult, type OutboxRow } from "@/lib/outbox";
import { retryPayoutRow } from "@/lib/payout";
import { writeBackStatus } from "@/lib/shopifyWriteback";
import { notifyClient } from "@/lib/clientComms";
import { captureError } from "@/lib/monitor";

// Executes one effect. Kept here (not in lib/outbox.ts) so the effect imports
// don't create a cycle with payout.ts (which enqueues into the outbox).
async function runEffect(row: OutboxRow): Promise<{ ok: boolean; error?: string }> {
  const p = (row.payload ?? {}) as Record<string, unknown>;
  try {
    if (row.kind === "payout") {
      const r = await retryPayoutRow(String(p.payoutId));
      // added = money went out; not-failed = someone already resolved it → moot, done.
      if (r.added || r.reason === "not-failed") return { ok: true };
      return { ok: false, error: r.reason ?? "payout-not-added" };
    }
    if (row.kind === "shopify_writeback") {
      await writeBackStatus(String(p.shopifyOrderId), p.state as Parameters<typeof writeBackStatus>[1], {
        orderId: row.order_id ?? undefined,
        // Nothing has been deployed with the old `odooFloristId` key, so no
        // migration shim — just a typeof guard against a persisted payload
        // that isn't a number (rather than risk NaN from a stray cast).
        floristNumber: typeof p.floristNumber === "number" ? p.floristNumber : undefined,
        totalPayout: (p.totalPayout as { amount: number; currency: string } | null | undefined) ?? undefined,
      });
      return { ok: true };
    }
    if (row.kind === "notify_client") {
      await notifyClient(String(p.orderId), p.kind as Parameters<typeof notifyClient>[1]);
      return { ok: true };
    }
    return { ok: false, error: `unknown kind ${row.kind}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "effect threw" };
  }
}

// Drain due effects: lease → run → mark done / retry (backoff) / dead. Idempotent
// and safe to run concurrently (the lease guards each row).
export async function drainOutbox(limit = 20): Promise<{ processed: number; done: number; retried: number; dead: number }> {
  const admin = createServiceClient();
  const nowIso = new Date().toISOString();
  const { data: due } = await admin.from("outbox")
    .select("*").eq("status", "pending").lte("next_attempt_at", nowIso)
    .order("next_attempt_at", { ascending: true }).limit(limit);

  let done = 0, retried = 0, dead = 0;
  for (const row of (due ?? []) as OutboxRow[]) {
    if (!(await leaseEffect(admin, row))) continue; // another drainer took it
    const res = await runEffect(row);
    if (res.ok) { await markDone(admin, row.id, (row.attempts ?? 0) + 1); done++; }
    else if ((await markResult(admin, row, res.error ?? "failed")) === "dead") {
      dead++;
      captureError("outbox.effect_dead", new Error(`${row.kind} effect ${row.id} exhausted retries${row.order_id ? ` for order ${row.order_id}` : ""}: ${res.error ?? "failed"}`));
    }
    else retried++;
  }
  return { processed: (due ?? []).length, done, retried, dead };
}

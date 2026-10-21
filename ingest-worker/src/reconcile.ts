// Missing-webhook reconciliation sweep (lifecycle branch `webhook-missing`).
//
// Shopify `orders/create` webhooks can be dropped (Shopify-side, or an outage
// on our side during the delivery window), leaving an order that never entered
// our queue. This periodically pulls recent Shopify orders and re-enqueues any
// we never received — exactly as the webhook path does (send to ORDER_QUEUE),
// so the rest of the pipeline is unchanged.
//
// Idempotent: re-enqueuing an order that later (or already) arrived via webhook
// is a no-op — the OrderWorkflow is keyed on shopifyOrderId (an "already
// exists" create is acked in index.ts::queue) and upsertOrder is on-conflict
// shopify_order_id. So a duplicate enqueue never double-processes.
//
// Throttled to ~hourly via app_settings.reconcile_last_run_at (a claim-style
// conditional update), so a per-minute cron never runs it every minute.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient, logExternalOp } from "./db";
import { refreshFromShopify, loadWorkingSetCriteria, weFulfilledOrder, type ParkedOrderRow } from "./lateMatch";
import { WORKING_SET_TERMINAL } from "./workingSet";
import { shopifyLifecycle, orderClosure } from "./shopifyLifecycle";
import { captureError } from "./monitor";
import type { Env } from "./types";

const SHOPIFY_API = "2024-07";
const RECONCILE_INTERVAL_MS = 60 * 60 * 1000; // run at most ~hourly
// A forced (on-demand) run still claims — it just debounces against a very recent
// run instead of the hourly throttle. The claim is the ONLY mutex (it's stamped
// at the start of a run and the sweep is bounded to finish well within this), so
// forcing without it would let a manual trigger start on top of an in-flight cron
// sweep and race the candidate-insert guards into a double-offer. Must comfortably
// exceed a worst-case sweep duration (≤SELFHEAL_CAP sequential Shopify calls).
const FORCE_DEBOUNCE_MS = 2 * 60 * 1000;
const LOOKBACK_MS = 2 * 60 * 60 * 1000; // pull orders created in the last ~2h (overlaps the interval)
// Self-heal reaches back further than the create-backfill pull: a parked order
// waiting on a late tag can sit for hours/days, so the 2h window would miss it.
const SELFHEAL_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000; // re-check parked orders up to ~14d old
const SELFHEAL_CAP = 100; // …at most this many per sweep, so it stays cheap
// Tag backfill runs over the same window but a different population (see
// backfillMissingTags), so it gets its own cap — one Shopify call per order.
const TAG_BACKFILL_CAP = 100;

interface ShopifyOrder {
  id: number | string;
  [k: string]: unknown;
}

/** What a sweep did — returned so an on-demand caller (the dashboard's admin
 * "Reconcile now") can show a result. `ran:false` means it no-op'd (creds unset,
 * or throttled on a non-forced run). */
export interface ReconcileResult {
  ran: boolean;
  reason?: string;         // set when ran=false
  backfilled: string[];    // shopify_order_ids re-enqueued (missing from our table)
  parkedChecked: number;   // parked orders re-evaluated by self-heal
  healed: string[];        // order ids that self-heal matched
  tagsBackfilled: string[]; // order ids whose missing tags were restored (any status)
  parkedCapped: boolean;   // true when selfHealParkedOrders hit SELFHEAL_CAP — the parked
                            // population wasn't fully covered this tick, not that it's exhausted
  tagsCapped: boolean;     // same signal for backfillMissingTags' TAG_BACKFILL_CAP
}

const skipped = (reason: string): ReconcileResult => ({
  ran: false, reason, backfilled: [], parkedChecked: 0, healed: [], tagsBackfilled: [],
  parkedCapped: false, tagsCapped: false,
});

/** Claim the right to run: atomically stamp `reconcile_last_run_at = now` only if
 * the last run started more than `minGapMs` ago (or never). Returns true if we
 * won the claim, false if another run holds it (too recent), "error" on failure.
 * Serves as both the throttle and the mutex — it's stamped at the START of a run
 * and the sweep finishes well within any gap we pass, so a winner blocks any other
 * caller for the duration. */
async function claimReconcileRun(sb: SupabaseClient, minGapMs: number): Promise<boolean | "error"> {
  const cutoffIso = new Date(Date.now() - minGapMs).toISOString();
  const { data, error } = await sb
    .from("app_settings")
    .update({ reconcile_last_run_at: new Date().toISOString() })
    .eq("id", 1)
    .or(`reconcile_last_run_at.is.null,reconcile_last_run_at.lt.${cutoffIso}`)
    .select("id");
  if (error) { captureError("reconcile.claim", error); return "error"; }
  return !!(data && data.length > 0);
}

/**
 * Self-heal parked orders + backfill any missing from Shopify. No-op when Shopify
 * Admin creds are unset, or (on the hourly cron path) when it already ran within
 * the last hour. `opts.force` bypasses the throttle — used by the on-demand admin
 * trigger. Never throws — reconciliation must not break the cron sweep it shares
 * an invocation with. Returns a summary of what it did.
 */
/** Clear `worklist_at` on every explicitly-picked order that has reached a
 * terminal state, so the working set stays a list of live work rather than an
 * ever-growing history. Returns how many dropped out.
 *
 * Deliberately does NOT touch anything mid-flight: an order only leaves once
 * it's paid/closed/cancelled/delivered, and leaving the set never rewinds work
 * (matching only ever fires on an order still at "received"). */
export async function dropFinishedFromWorkingSet(sb: SupabaseClient): Promise<number> {
  const { data, error } = await sb
    .from("orders")
    .update({ worklist_at: null })
    .not("worklist_at", "is", null)
    .in("status", [...WORKING_SET_TERMINAL])
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

export async function reconcileMissingOrders(env: Env, opts: { force?: boolean } = {}): Promise<ReconcileResult> {
  if (!env.SHOPIFY_SHOP || !env.SHOPIFY_ADMIN_TOKEN) return skipped("shopify-creds-unset"); // creds unset → no-op

  const sb = createServiceClient(env);

  // Claim: the conditional update both serializes concurrent runs (only one
  // caller flips the row and gets it back) and enforces the interval. The cron
  // path uses the hourly interval; a forced run uses a short debounce so it can't
  // start on top of an in-flight sweep (or a second forced click) yet still runs
  // near-immediately on demand. Losing the claim → no-op with a reason the UI
  // can surface.
  const claim = await claimReconcileRun(sb, opts.force ? FORCE_DEBOUNCE_MS : RECONCILE_INTERVAL_MS);
  if (claim === "error") return skipped("claim-error");
  if (!claim) return skipped(opts.force ? "recently-ran" : "throttled");

  // Keep the working set self-cleaning: an order staff picked by hand stays in
  // it until the order finishes, then drops out on its own. Without this the
  // set only ever grows, and a paste from three weeks ago silently keeps
  // widening what the gate admits. One indexed UPDATE, no Shopify calls, so it
  // runs before anything that can fail on the network.
  await dropFinishedFromWorkingSet(sb).catch((e) => captureError("reconcile.worklistdrop", e));

  // Late-tag safety net FIRST — it makes its own per-order Shopify calls, so it
  // must run even in a quiet period when the bulk pull below returns nothing (a
  // parked order can be days old with no recent orders around it).
  const selfHeal = await selfHealParkedOrders(env, sb).catch((e) => {
    captureError("reconcile.selfheal", e);
    return { checked: 0, healed: [] as string[], capped: false };
  });

  // Then restore tags on orders the parked sweep structurally cannot see —
  // anything already matched/escalated/cancelled that never got its tags at all.
  // Tag-only, never starts work; see backfillMissingTags.
  const tagBackfill = await backfillMissingTags(env, sb).catch((e) => {
    captureError("reconcile.tagbackfill", e);
    return { checked: 0, updated: [] as string[], capped: false };
  });

  // Bulk-pull recent Shopify orders (status=any → cancelled/archived too) to
  // backfill any we never received via webhook.
  const createdAtMin = new Date(Date.now() - LOOKBACK_MS).toISOString();
  const url =
    `https://${env.SHOPIFY_SHOP}/admin/api/${SHOPIFY_API}/orders.json` +
    `?status=any&created_at_min=${encodeURIComponent(createdAtMin)}&limit=100`;

  let orders: ShopifyOrder[];
  try {
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": env.SHOPIFY_ADMIN_TOKEN } });
    if (!res.ok) {
      captureError("reconcile.fetch", new Error(`Shopify orders.json ${res.status}: ${await res.text().catch(() => "")}`));
      return {
        ran: true, backfilled: [], parkedChecked: selfHeal.checked, healed: selfHeal.healed, tagsBackfilled: tagBackfill.updated,
        parkedCapped: selfHeal.capped, tagsCapped: tagBackfill.capped,
      };
    }
    orders = ((await res.json()) as { orders?: ShopifyOrder[] }).orders ?? [];
  } catch (e) {
    captureError("reconcile.fetch", e);
    return {
      ran: true, backfilled: [], parkedChecked: selfHeal.checked, healed: selfHeal.healed, tagsBackfilled: tagBackfill.updated,
      parkedCapped: selfHeal.capped, tagsCapped: tagBackfill.capped,
    };
  }

  let backfilled: string[] = [];
  if (orders.length > 0) {
    // Diff against our table: which of these shopify_order_ids do we already have?
    const ids = orders.map((o) => String(o.id));
    const { data: existing, error: selErr } = await sb
      .from("orders")
      .select("shopify_order_id")
      .in("shopify_order_id", ids);
    if (selErr) {
      captureError("reconcile.select", selErr);
    } else {
      const have = new Set((existing ?? []).map((r) => String(r.shopify_order_id)));
      const missing = orders.filter((o) => !have.has(String(o.id)));
      // Re-enqueue each missing order exactly as the webhook path does.
      for (const o of missing) await env.ORDER_QUEUE.send({ shopifyOrderId: String(o.id), raw: o });
      backfilled = missing.map((o) => String(o.id));
      if (backfilled.length) {
        // A missed webhook is an anomaly worth alerting on (captureError is the
        // go-live alerting hook; see monitor.ts).
        captureError(
          "reconcile.backfill",
          new Error(`Backfilled ${backfilled.length} order(s) missing from webhook delivery: ${backfilled.join(", ")}`),
        );
      }
    }
  }

  return {
    ran: true, backfilled, parkedChecked: selfHeal.checked, healed: selfHeal.healed, tagsBackfilled: tagBackfill.updated,
    parkedCapped: selfHeal.capped, tagsCapped: tagBackfill.capped,
  };
}

/** Result of reconciling a single order on demand. */
export interface OrderReconcileResult {
  found: boolean;
  reason?: string;                                // set when found=false or a fetch failed
  result?: "matched" | "closed" | "conflict" | "updated" | "noop"; // what refreshFromShopify did
  tags?: string | null;                           // the freshest Shopify tags applied
}

/**
 * Reconcile ONE order on demand: re-pull its current tags from Shopify, refresh
 * our stored copy, and run the late match if it's parked and now qualifies. The
 * targeted counterpart to the sweep (same idempotent helper), for the per-order
 * admin action. Looks the order up by OUR internal id.
 */
export async function reconcileOneOrder(env: Env, orderId: string): Promise<OrderReconcileResult> {
  if (!env.SHOPIFY_SHOP || !env.SHOPIFY_ADMIN_TOKEN) return { found: false, reason: "shopify-creds-unset" };
  const sb = createServiceClient(env);
  const { data: row, error } = await sb
    .from("orders")
    .select("id, shopify_order_id, status, tags, delivery_address, city_id, delivery_lat, delivery_lng, delivery_at, worklist_at")
    .eq("id", orderId)
    .maybeSingle();
  if (error) { captureError("reconcile.one.select", error); return { found: false, reason: "db-error" }; }
  if (!row) return { found: false, reason: "not-found" };

  let fresh: unknown;
  try { fresh = await fetchShopifyOrder(env, String((row as { shopify_order_id: unknown }).shopify_order_id)); }
  catch (e) { captureError("reconcile.one.fetch", e); return { found: true, reason: "shopify-error" }; }

  const criteria = await loadWorkingSetCriteria(sb);
  const result = await refreshFromShopify(sb, row as unknown as ParkedOrderRow, fresh, criteria, env);
  const tags = (fresh as { tags?: unknown }).tags;
  return { found: true, result, tags: typeof tags === "string" && tags.length ? tags : null };
}

/**
 * Retry a specific list of orders on demand — the admin-driven counterpart to a
 * failed full-table sweep (Task 1 above logs each sweep failure's order id to
 * `external_ops`; an admin reads them off the backoffice's External-ops page and
 * passes them back in here). Deliberately no discovery/query logic of its own:
 * it just loops `reconcileOneOrder` per id, sequentially (these are expected to
 * be a small, human-curated batch — the handful of ids a sweep tick failed on —
 * not a bulk operation, so there's no need for concurrency here).
 */
export async function reconcileOrders(env: Env, orderIds: string[]): Promise<{ orderId: string; result: OrderReconcileResult }[]> {
  const results: { orderId: string; result: OrderReconcileResult }[] = [];
  for (const orderId of orderIds) {
    results.push({ orderId, result: await reconcileOneOrder(env, orderId) });
  }
  return results;
}

/** Fetch one Shopify order in full (the freshest source — our stored copy may be
 * stale if any orders/updated webhook was dropped, not just a tag one). Shopify
 * is the truth: everything it owns on the row is refreshed from this. */
async function fetchShopifyOrder(env: Env, shopifyOrderId: string): Promise<unknown> {
  const url = `https://${env.SHOPIFY_SHOP}/admin/api/${SHOPIFY_API}/orders/${shopifyOrderId}.json`;
  const res = await fetch(url, { headers: { "X-Shopify-Access-Token": env.SHOPIFY_ADMIN_TOKEN as string } });
  if (!res.ok) throw new Error(`Shopify order ${shopifyOrderId}: ${res.status}`);
  const j = (await res.json()) as { order?: unknown };
  if (!j.order) throw new Error(`Shopify order ${shopifyOrderId}: no order in response`);
  return j.order;
}

/**
 * Refresh tags for orders that have already left "received" — whatever their
 * current tags value, not just orders that never got any.
 *
 * The store app tags an order MINUTES after checkout, but orders/create fires at
 * checkout — so every order is first written with `tags = null` and depends on a
 * later orders/updated webhook to fill them in (and on any FURTHER webhook to
 * keep them current). When an update is missed (a worker deploy gap, a dropped
 * delivery, the subscription not yet registered), selfHealParkedOrders below
 * can't help — it only looks at `status = "received"`, so the moment an order
 * is matched or escalated it becomes invisible to every healing path.
 *
 * This used to scope to `tags IS NULL`, which fixed the permanently-null case
 * (133 orders, incl. 7 real `local-florist` ones) but left a second gap: once
 * such an order picked up ANY tag at all — even a single early tag, before the
 * rest arrived or changed — it dropped out of this query forever, so its tags
 * could go stale for the rest of the order's life with no automatic path to
 * refresh them. Selecting on status alone (like selfHealParkedOrders does for
 * "received") closes that gap too, at the cost of one Shopify call per
 * non-received order in the window each sweep — the same cost profile
 * selfHealParkedOrders already pays for parked orders.
 *
 * Never starts work by construction: this reuses refreshFromShopify, whose match
 * leg is gated on `status === "received"` (shouldLateMatch) — and this pass
 * deliberately excludes "received", which the parked sweep already owns. So it
 * can never start work on an order; it only restores the truth of a column.
 * Idempotent: an order whose tags already match Shopify's is a no-op write.
 */
export async function backfillMissingTags(
  env: Env,
  sb: SupabaseClient,
): Promise<{ checked: number; updated: string[]; capped: boolean }> {
  if (!env.SHOPIFY_SHOP || !env.SHOPIFY_ADMIN_TOKEN) return { checked: 0, updated: [], capped: false };
  const since = new Date(Date.now() - SELFHEAL_LOOKBACK_MS).toISOString();
  const { data, error } = await sb
    .from("orders")
    .select("id, shopify_order_id, status, tags, delivery_address, city_id, delivery_lat, delivery_lng, delivery_at, worklist_at")
    .neq("status", "received") // parked orders are selfHealParkedOrders' job
    .gte("shopify_created_at", since)
    .limit(TAG_BACKFILL_CAP);
  if (error) { captureError("reconcile.tagbackfill.select", error); return { checked: 0, updated: [], capped: false }; }

  const rows = data ?? [];
  // Hitting the cap means this population wasn't fully covered THIS tick, not
  // that it's exhausted — the next tick picks up wherever the window still
  // includes. Worth a visible signal (not silence indistinguishable from "caught
  // up"), but not a page: a capped-but-otherwise-healthy pass is steady-state,
  // not one of the two classes captureError is reserved for (see monitor.ts).
  const capped = rows.length === TAG_BACKFILL_CAP;
  if (capped) console.warn(`[reconcile] backfillMissingTags hit its cap (${TAG_BACKFILL_CAP}) — more orders may be waiting for this tick's window.`);
  if (rows.length === 0) return { checked: 0, updated: [], capped };

  const criteria = await loadWorkingSetCriteria(sb);

  const updated: string[] = [];
  for (const row of rows) {
    const shopifyOrderId = String((row as { shopify_order_id: unknown }).shopify_order_id);
    let fresh: unknown;
    // One order's failure must not abandon the rest of the batch.
    try { fresh = await fetchShopifyOrder(env, shopifyOrderId); }
    catch (e) { captureError("reconcile.tagbackfill.fetch", e); continue; }
    // Unlike a plain null-check: a row here can already carry non-null tags, so
    // Shopify returning null is itself a real change (tags removed) that must
    // still be written — refreshFromShopify's own diff (freshTags !== row.tags)
    // decides whether there's anything user-visible to report.
    const result = await refreshFromShopify(sb, row as unknown as ParkedOrderRow, fresh, criteria, env)
      .catch((e) => { captureError("reconcile.tagbackfill.write", e); return "noop" as const; });
    if (result !== "noop") updated.push(String((row as { id: unknown }).id));
  }
  return { checked: rows.length, updated, capped };
}

/**
 * Re-evaluate every order still parked at "received" with no candidates yet — it
 * missed its match, most often because a required tag arrived after the create
 * webhook. Pull each one's current Shopify tags and run the late match if it now
 * qualifies (refreshFromShopify is idempotent and skips already-matched
 * orders). Bounded to the last ~14d and capped per sweep. Orders that already
 * have candidate assignments (incl. semi-mode matches awaiting approval, which
 * stay at "received") are filtered out cheaply so they cost no Shopify call.
 */
async function selfHealParkedOrders(env: Env, sb: SupabaseClient): Promise<{ checked: number; healed: string[]; capped: boolean }> {
  const since = new Date(Date.now() - SELFHEAL_LOOKBACK_MS).toISOString();
  const { data: parked, error } = await sb
    .from("orders")
    .select("id, shopify_order_id, status, tags, delivery_address, city_id, delivery_lat, delivery_lng, delivery_at, worklist_at, order_assignments(id)")
    .eq("status", "received")
    .gte("shopify_created_at", since)
    .limit(SELFHEAL_CAP);
  if (error) { captureError("reconcile.selfheal.select", error); return { checked: 0, healed: [], capped: false }; }
  // Cap hit on the RAW fetch (before the already-has-candidates filter below) —
  // that's the signal that the "received, in-window" population itself is
  // larger than this tick covered, regardless of how many of those rows turn
  // out to already have candidates. See backfillMissingTags' twin for why this
  // is a console.warn, not captureError.
  const capped = (parked ?? []).length === SELFHEAL_CAP;
  if (capped) console.warn(`[reconcile] selfHealParkedOrders hit its cap (${SELFHEAL_CAP}) — more parked orders may be waiting for this tick's window.`);
  const needs = (parked ?? []).filter((r) => !((r as { order_assignments?: unknown[] }).order_assignments?.length));
  if (needs.length === 0) return { checked: 0, healed: [], capped };

  const criteria = await loadWorkingSetCriteria(sb);

  const healed: string[] = [];
  for (const row of needs) {
    const shopifyOrderId = String((row as { shopify_order_id: unknown }).shopify_order_id);
    let fresh: unknown;
    try { fresh = await fetchShopifyOrder(env, shopifyOrderId); }
    catch (e) { captureError("reconcile.selfheal.fetch", e); continue; }
    const result = await refreshFromShopify(sb, row as unknown as ParkedOrderRow, fresh, criteria, env)
      .catch((e) => { captureError("reconcile.selfheal.match", e); return "noop" as const; });
    if (result === "matched") healed.push(String((row as { id: unknown }).id));
  }
  return { checked: needs.length, healed, capped };
}

// ---------------------------------------------------------------------------
// Full-table reconcile — align EVERY order with Shopify, not just the last ~14d.
//
// The two sweeps above are windowed (SELFHEAL_LOOKBACK_MS) and capped, which is
// right for steady-state: they exist to catch a webhook dropped minutes or days
// ago. But that leaves everything older permanently unreachable — when this
// landed, 1,103 of 3,622 orders were already outside the window, and 3,607 sat
// open (1,846 escalated, 1,761 received) against a Shopify that had long since
// fulfilled or archived many of them.
//
// This is the catch-up pass. Armed deliberately (never on by itself), it walks
// the whole table oldest-first in capped batches on the SAME per-minute cron,
// remembers where it got to in app_settings, and disarms itself at the end.
// ~3.6k orders at FULL_SWEEP_CAP/tick ≈ an hour.
//
// It reuses `refreshFromShopify` — the same primitive the orders/updated webhook
// and the per-order re-pull use — so a full sweep cannot drift from them.
// `dry` mode is the exception, and even there it reuses the same pure decision
// (`shopifyLifecycle` + `orderClosure`) rather than a parallel rule: it just
// stops before writing anything.

const FULL_SWEEP_CAP = 60; // per tick, on top of the two windowed passes above

export interface FullSweepStats {
  swept: number;
  closed: number;      // in dry mode: WOULD close
  conflicts: number;   // in dry mode: WOULD conflict
  noChange: number;
  errors: number;
  startedAt?: string;
  finishedAt?: string;
}

const EMPTY_STATS: FullSweepStats = { swept: 0, closed: 0, conflicts: 0, noChange: 0, errors: 0 };

/** Arm (or stop) the full sweep. Resets the cursor + stats so an arming always
 *  starts from the beginning — a half-finished pass is never silently resumed
 *  under a different mode. */
export async function armFullSweep(
  env: Env,
  mode: "dry" | "apply" | null,
  sbOverride?: SupabaseClient,
): Promise<{ ok: boolean }> {
  const sb = sbOverride ?? createServiceClient(env);
  const { error } = await sb.from("app_settings").update({
    reconcile_all_mode: mode,
    reconcile_all_after_created_at: null,
    reconcile_all_after_id: null,
    reconcile_all_stats: mode ? { ...EMPTY_STATS, startedAt: new Date().toISOString() } : null,
  }).eq("id", 1);
  if (error) { captureError("reconcile.all.arm", error); return { ok: false }; }
  return { ok: true };
}

/** One tick of the full sweep. No-op unless armed. Never throws. */
export async function reconcileAllOrders(
  env: Env,
  sbOverride?: SupabaseClient,
): Promise<{ ran: boolean; mode?: string; stats?: FullSweepStats; done?: boolean }> {
  if (!env.SHOPIFY_SHOP || !env.SHOPIFY_ADMIN_TOKEN) return { ran: false };
  const sb = sbOverride ?? createServiceClient(env);
  const { data: cfg } = await sb
    .from("app_settings")
    .select("reconcile_all_mode, reconcile_all_after_created_at, reconcile_all_after_id, reconcile_all_stats")
    .eq("id", 1)
    .maybeSingle();
  const mode = cfg?.reconcile_all_mode as "dry" | "apply" | null | undefined;
  if (!mode) return { ran: false };

  const criteria = await loadWorkingSetCriteria(sb);
  const stats: FullSweepStats = { ...EMPTY_STATS, ...((cfg?.reconcile_all_stats as FullSweepStats | null) ?? {}) };
  const afterCreatedAt = cfg?.reconcile_all_after_created_at as string | null;
  const afterId = cfg?.reconcile_all_after_id as string | null;

  // Keyset pagination on (created_at, id) — stable under concurrent writes in a
  // way OFFSET is not, and it survives the sweep being interrupted. The id
  // tiebreak is NOT optional: bulk imports write many rows inside one
  // transaction and therefore share a created_at to the microsecond, so a
  // timestamp-only cursor would silently skip every row after the first
  // whenever a batch boundary landed inside such a group. `created_at` (ours,
  // NOT NULL) rather than shopify_created_at, which the schema permits to be
  // null — a null there would make the cursor comparison undefined.
  let q = sb
    .from("orders")
    .select("id, shopify_order_id, status, tags, delivery_address, city_id, delivery_lat, delivery_lng, delivery_at, worklist_at, created_at")
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(FULL_SWEEP_CAP);
  if (afterCreatedAt && afterId) {
    // (created_at, id) > (cursor) — PostgREST has no row-value comparison, so
    // it's spelled out. Timestamps are quoted: they contain `+` and `:`.
    q = q.or(`created_at.gt."${afterCreatedAt}",and(created_at.eq."${afterCreatedAt}",id.gt.${afterId})`);
  }
  const { data: rows, error } = await q;
  if (error) { captureError("reconcile.all.select", error); return { ran: false }; }

  const batch = rows ?? [];
  if (batch.length === 0) {
    await sb.from("app_settings").update({
      reconcile_all_mode: null,
      reconcile_all_stats: { ...stats, finishedAt: new Date().toISOString() },
    }).eq("id", 1);
    return { ran: true, mode, stats, done: true };
  }

  for (const row of batch) {
    const rowId = (row as { id: string }).id;
    const shopifyOrderId = String((row as { shopify_order_id: unknown }).shopify_order_id);
    let fresh: unknown;
    try { fresh = await fetchShopifyOrder(env, shopifyOrderId); }
    catch (e) {
      captureError("reconcile.all.fetch", e);
      // Durable record of WHICH order failed and why — captureError only reaches
      // an ephemeral tail log, so without this the nine-ish failures a full sweep
      // logs each run are unrecoverable: no id to retry, no reason to act on.
      // logExternalOp is itself best-effort (never throws), so a Supabase outage
      // mid-log can't take down the sweep it's trying to record a failure for.
      await logExternalOp(sb, {
        provider: "shopify", operation: "reconcile_all", direction: "out",
        orderId: rowId, ref: shopifyOrderId, ok: false,
        error: e instanceof Error ? e.message : String(e), meta: { cause: "fetch" },
      });
      stats.errors += 1;
      continue;
    }
    stats.swept += 1;

    if (mode === "dry") {
      // Same decision, no writes: the point of a dry run is to be provably the
      // same rule as the real pass, so this calls the identical pure functions
      // refreshFromShopify calls and simply stops there.
      const { count } = await sb
        .from("order_assignments")
        .select("id", { count: "exact", head: true })
        .eq("order_id", (row as { id: string }).id)
        .in("status", ["accepted", "delivered"]);
      const action = orderClosure(
        shopifyLifecycle(fresh),
        String((row as { status: unknown }).status),
        (count ?? 0) > 0,
        // Mirrors refreshFromShopify's 4th argument. Omitting it here would make
        // the dry run report a conflict for every accepted florist order while
        // the real pass reported none — exactly the drift this branch exists to
        // avoid.
        await weFulfilledOrder(sb, (row as { id: string }).id)
      );
      if (action.kind === "close") stats.closed += 1;
      else if (action.kind === "conflict") stats.conflicts += 1;
      else stats.noChange += 1;
      continue;
    }

    const result = await refreshFromShopify(sb, row as unknown as ParkedOrderRow, fresh, criteria, env)
      .catch(async (e) => {
        captureError("reconcile.all.write", e);
        await logExternalOp(sb, {
          provider: "shopify", operation: "reconcile_all", direction: "out",
          orderId: rowId, ref: shopifyOrderId, ok: false,
          error: e instanceof Error ? e.message : String(e), meta: { cause: "write" },
        });
        stats.errors += 1;
        return "noop" as const;
      });
    if (result === "closed") stats.closed += 1;
    else if (result === "conflict") stats.conflicts += 1;
    else stats.noChange += 1;
  }

  const last = batch[batch.length - 1] as { id: string; created_at: string };
  const done = batch.length < FULL_SWEEP_CAP;
  await sb.from("app_settings").update({
    reconcile_all_mode: done ? null : mode,
    reconcile_all_after_created_at: last.created_at,
    reconcile_all_after_id: last.id,
    reconcile_all_stats: done ? { ...stats, finishedAt: new Date().toISOString() } : stats,
  }).eq("id", 1);
  return { ran: true, mode, stats, done };
}

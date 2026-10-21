import { captureError } from "./monitor";
import { createServiceClient } from "./supabaseAdmin";
import { logExternalOp } from "./externalOps";
import { unionTags, formatPayoutTotal } from "./shopifyTags";
import type { GateResult } from "./effectGate";

const API = "2024-07";
function base() { return `https://${process.env.SHOPIFY_SHOP}/admin/api/${API}`; }
function headers() { return { "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN!, "Content-Type": "application/json" }; }

const NOTE: Record<string, string> = {
  in_production: "Facundo: assigned to a florist — in production.",
  delivered: "Facundo: delivered (photo on file).",
  issue: "Facundo: needs attention — see the ops queue.",
};

export interface WritebackResult { ok: boolean; skipped?: boolean; error?: string }

// Shared "extra" shape across writeBackStatus / deliverWriteback / gateWriteback.
// `floristNumber` and `totalPayout` are both optional. Florist number is set
// once at accept and never re-sent (it doesn't change). Total payout is sent
// at accept too (the quoted `order_assignments.payout_price` — known
// immediately, doesn't wait on the delivery leg existing) and re-sent at
// delivery ONLY if the real total (accept + delivery legs actually issued)
// ends up different — e.g. a held delivery leg or a post-accept order edit.
// Same value at delivery → omitted, the accept-time write stands. See the
// call sites (app/api/florist/respond, app/api/orders/reachout, app/api/florist/photo)
// for exactly where each is computed.
export interface WritebackExtra {
  florist?: string | null;
  orderId?: string;
  // Our Florist ID (florists.florist_number) — see the mapping block below for
  // where this becomes a Shopify metafield name.
  floristNumber?: number | null;
  totalPayout?: { amount: number; currency: string } | null;
}

// ============================================================================
// THE ONE PLACE OUR NAMES MAP TO SHOPIFY'S NAMES.
// Nothing outside this file should reference the Shopify metafield names below
// — everywhere else (types, routes, executors) uses our own plain names
// (`florist_number` / total payout).
//
//   our florist_number (Facundo-minted Florist ID) -> custom.tookan_florist_id
//     ("Tookan Florist Id")
//   our computed total payout (accept + delivery legs) -> custom.tookan_cost_of_order
//     ("Tookan Cost Of Order")
//
// Confirmed live against production Shopify admin on 2026-08-21 (GraphQL
// metafieldDefinitions(ownerType: ORDER) + real order metafield values).
// NOT custom.odoo_florist_order_id, despite the name: real orders show that
// field's value tracking the ORDER's own odoo_order_id (e.g. order
// odoo_order_id 1544032 -> odoo_florist_order_id 1544447 — climbing in
// lockstep, allocated around order-creation time), not the florist. It's an
// Odoo order-florist-assignment record id, not florist identity, so this
// feature deliberately does not write it. tookan_florist_id, by contrast, was
// found unpopulated on every one of 66 sampled real orders — there was no
// live value to confirm a format against, only the field's existence.
// ============================================================================

// formatPayoutTotal lives in lib/shopifyTags.ts (imported above) so it
// unit-tests under plain `node --test` without pulling in this file's
// runtime imports — see that file's header.

// The order-tags PUT used to send a bare `tags: "facundo"`, which Shopify
// treats as last-writer-wins — it replaces the *entire* tag list, clobbering
// any tags staff or other apps had set. This GETs the order's current tags +
// note in one round trip (note is read here too so a metafield correction
// below can APPEND its old -> new change line onto whatever's already there,
// instead of clobbering it the way the note PUT otherwise would). Best-effort:
// any failure here (network, non-OK response, malformed body) falls back to
// "facundo" tags / no existing note — the caller's writeback still
// proceeds; the only cost is the rare failure case still clobbering the note,
// same as before this existed.
async function currentTagsAndNote(shopifyOrderId: string): Promise<{ tags: string; note: string | null }> {
  try {
    const res = await fetch(`${base()}/orders/${shopifyOrderId}.json?fields=tags,note`, { headers: headers() });
    if (!res.ok) return { tags: "facundo", note: null };
    const data = (await res.json()) as { order?: { tags?: string; note?: string | null } };
    return { tags: unionTags(data.order?.tags, "facundo"), note: data.order?.note ?? null };
  } catch (e) {
    captureError("shopify.writeback.tags", e); // best-effort — never blocks the writeback
    return { tags: "facundo", note: null };
  }
}

// Reads back the two metafields writeBackStatus writes, so it can tell a
// first-time set (nothing to compare against) apart from a CORRECTION — and
// note the old -> new value straight on the Shopify order (see writeBackStatus)
// now that writeback no longer waits on a CX approval preview to show that
// diff. Best-effort, same shape as currentTagsAndNote: a fetch failure means
// we can't prove anything changed, so no change line gets written — it never
// blocks the metafield write itself.
async function currentTookanMetafields(shopifyOrderId: string): Promise<{ floristId: string | null; costOfOrder: string | null }> {
  try {
    const res = await fetch(`${base()}/orders/${shopifyOrderId}/metafields.json`, { headers: headers() });
    if (!res.ok) return { floristId: null, costOfOrder: null };
    const data = (await res.json()) as { metafields?: Array<{ namespace: string; key: string; value: string }> };
    const find = (key: string) => data.metafields?.find((m) => m.namespace === "custom" && m.key === key)?.value ?? null;
    return { floristId: find("tookan_florist_id"), costOfOrder: find("tookan_cost_of_order") };
  } catch (e) {
    captureError("shopify.writeback.metafields_read", e); // best-effort — never blocks the writeback
    return { floristId: null, costOfOrder: null };
  }
}

// Is the Shopify write-back safeguard on? Defaults CLOSED (no writes) — a read
// failure or an unset flag means "don't touch Shopify", so we can never mutate a
// real order just because the settings read hiccuped.
export async function writebackEnabled(): Promise<boolean> {
  try {
    const admin = createServiceClient();
    const { data } = await admin.from("app_settings").select("shopify_writeback_enabled").eq("id", 1).single();
    return !!data?.shopify_writeback_enabled;
  } catch {
    return false;
  }
}

// Staff-facing only: metafields + order note + tag. Never touches customer-visible
// fulfilment status. Gated by the `shopify_writeback_enabled` safeguard so we can
// run against a live shop while testing without mutating real orders. Every call
// (sent, skipped, or failed) is recorded in the external-operations log.
export async function writeBackStatus(
  shopifyOrderId: string,
  state: "in_production" | "delivered" | "issue",
  extra?: WritebackExtra,
): Promise<WritebackResult> {
  const logBase = { provider: "shopify", operation: "writeback_status", direction: "out" as const, orderId: extra?.orderId ?? null, ref: shopifyOrderId };

  if (!(await writebackEnabled())) {
    // Record the intent, but don't hit Shopify — the safeguard is on.
    await logExternalOp({ ...logBase, ok: null, skipped: true, meta: { state, reason: "writeback_disabled" } });
    return { ok: false, skipped: true };
  }

  const start = Date.now();
  try {
    // fc.status / fc.florist metafields used to be written here (namespace
    // "fc", holding `state` and `extra.florist`) but were dropped: unlike
    // custom.tookan_florist_id/tookan_cost_of_order below, NEITHER showed up
    // in the real metafieldDefinitions(ownerType: ORDER) list confirmed live
    // on 2026-08-21 (see the mapping block above) — there's no evidence this
    // "fc" namespace is a real, defined Shopify field anyone downstream reads.
    // A write would likely still succeed (Shopify allows undefined metafields),
    // just into a namespace nothing shows or consumes. Re-add only once that's
    // confirmed against Shopify admin (Settings → Custom data → Orders) or a
    // real downstream consumer is identified.
    //
    // Real Shopify custom-data fields, confirmed live 2026-08-21 — see the
    // mapping block above this function for how/why these two map here.
    const custom = (key: string, value: string) => fetch(`${base()}/orders/${shopifyOrderId}/metafields.json`, {
      method: "POST", headers: headers(),
      body: JSON.stringify({ metafield: { namespace: "custom", key, type: "single_line_text_field", value } }),
    });
    // Read the OLD value before overwriting it, so a correction (staff fixing a
    // wrong Florist ID, a payout total that ended up different) can be told apart
    // from a first-time set — only a real change gets a note line. Writeback fires
    // immediately now (no CX approval preview in front of it — see gateWriteback),
    // so this is how staff see the diff: on the order itself, in Shopify.
    const needsOldValues = extra?.floristNumber != null || !!extra?.totalPayout;
    const before = needsOldValues ? await currentTookanMetafields(shopifyOrderId) : { floristId: null, costOfOrder: null };
    const changeNotes: string[] = [];
    if (extra?.floristNumber != null) {
      const value = String(extra.floristNumber);
      if (before.floristId != null && before.floristId !== value) {
        changeNotes.push(`Facundo: Florist ID changed ${before.floristId} → ${value}.`);
      }
      await custom("tookan_florist_id", value);
    }
    if (extra?.totalPayout) {
      const value = formatPayoutTotal(extra.totalPayout.amount);
      if (before.costOfOrder != null && before.costOfOrder !== value) {
        changeNotes.push(`Facundo: Payout total changed ${before.costOfOrder} → ${value}.`);
      }
      await custom("tookan_cost_of_order", value);
    }
    // tags: merged (not clobbered). note: overwritten with the plain status line as
    // before UNLESS there's a correction to report, in which case the change line(s)
    // are APPENDED onto whatever note is on the order right now (not just our own
    // last status line) so Shopify keeps the change history instead of it being
    // silently overwritten on the next writeback.
    const { tags, note: existingNote } = await currentTagsAndNote(shopifyOrderId);
    const note = changeNotes.length
      ? [existingNote, ...changeNotes].filter((line) => !!line && line.trim().length > 0).join("\n")
      : NOTE[state];
    const res = await fetch(`${base()}/orders/${shopifyOrderId}.json`, {
      method: "PUT", headers: headers(),
      body: JSON.stringify({ order: { id: Number(shopifyOrderId), note, tags } }),
    });
    await logExternalOp({ ...logBase, ok: res.ok, statusCode: res.status, durationMs: Date.now() - start, meta: { state, florist: extra?.florist, floristNumber: extra?.floristNumber ?? null, totalPayout: extra?.totalPayout ?? null, changeNotes: changeNotes.length ? changeNotes : undefined } });
    if (!res.ok) return { ok: false, error: `Shopify ${res.status}` };
    return { ok: true };
  } catch (e) {
    captureError("shopify.writeback", e); // best-effort — never block the flow
    const error = e instanceof Error ? e.message : "shopify error";
    await logExternalOp({ ...logBase, ok: false, error, durationMs: Date.now() - start, meta: { state } });
    return { ok: false, error };
  }
}

// Do the writeback AND stamp the order timeline event. Both the direct path
// (manual/auto) and the executor's approved path go through here so the
// `shopify_writeback` order_event is written exactly once, when it actually fires.
export async function deliverWriteback(
  shopifyOrderId: string,
  state: "in_production" | "delivered" | "issue",
  extra: WritebackExtra & { orderId: string },
  actor = "system",
): Promise<WritebackResult> {
  const res = await writeBackStatus(shopifyOrderId, state, {
    florist: extra.florist ?? undefined,
    orderId: extra.orderId,
    floristNumber: extra.floristNumber ?? undefined,
    totalPayout: extra.totalPayout ?? undefined,
  });
  try {
    const admin = createServiceClient();
    await admin.from("order_events").insert({ order_id: extra.orderId, type: "shopify_writeback", payload: { state, ok: res.ok, skipped: res.skipped ?? false }, actor });
  } catch { /* best-effort — the external-ops log already recorded the call */ }
  return res;
}

// Writeback is intentionally NOT staff-approval-gated (unlike match/offer/
// reassign/escalate/client_* — see effectGate.ts's `kind`s), even in
// workflow_mode='semi': a status/metafield sync to Shopify's backoffice-only
// fields is low-risk and should land immediately rather than wait on a human
// in the approval queue. A value CHANGING (a correction, not a first-time
// set) is instead recorded straight on the Shopify order's own note — see
// writeBackStatus's old -> new change-note logic — so staff see the diff on
// the order itself instead of in a pre-send preview. Still routes through
// GateResult for the call sites that expect that shape; `pending` is always
// false here. (Historical `kind: "writeback"` rows already filed in
// `order_approvals`, from before this changed, stay approvable as-is —
// approvalExecutors.ts's writeback branch calls deliverWriteback directly,
// independent of this function.)
export async function gateWriteback(
  shopifyOrderId: string,
  state: "in_production" | "delivered" | "issue",
  extra: WritebackExtra & { orderId: string },
): Promise<GateResult<WritebackResult>> {
  return { pending: false, result: await deliverWriteback(shopifyOrderId, state, extra) };
}

// Florist number used to be immutable once minted, so accept-time (see
// app/api/florist/respond/route.ts) was the only place it was ever sent —
// "set once, never re-sent" stopped being true the moment staff could hand-edit
// it (dashboard/app/api/florists/operational/route.ts). Called from there,
// best-effort, right after an edit that actually changes the stored value:
// re-fires the writeback for every order this florist currently holds PAST
// accept (assignment status 'accepted' or 'delivered' — meaning a writeback
// with the OLD number already went out) so Shopify's metafield doesn't keep
// showing a number staff just corrected. Skips a closed/cancelled order —
// nothing left there worth writing back to; an edit made after an order fully
// closes is a known, accepted gap rather than something this chases down.
export async function resendFloristNumberForActiveOrders(floristId: string, floristNumber: number | null): Promise<void> {
  const admin = createServiceClient();
  const { data: rows } = await admin
    .from("order_assignments")
    .select("order_id, status, orders(shopify_order_id, status)")
    .eq("florist_id", floristId)
    .in("status", ["accepted", "delivered"]);
  for (const row of (rows ?? []) as Array<{
    order_id: string;
    status: string;
    // to-one via order_assignments.order_id -> orders.id, but the untyped
    // client can't statically promise object-vs-array — normalize below
    // (same idiom as ingest-worker/src/db.ts::extractDeliveryAt).
    orders: { shopify_order_id: string | null; status: string } | { shopify_order_id: string | null; status: string }[] | null;
  }>) {
    const ord = Array.isArray(row.orders) ? row.orders[0] : row.orders;
    if (!ord?.shopify_order_id || ord.status === "closed" || ord.status === "cancelled") continue;
    const state = row.status === "delivered" ? "delivered" : "in_production";
    await gateWriteback(ord.shopify_order_id, state, { orderId: row.order_id, floristNumber }).catch(() => {});
  }
}

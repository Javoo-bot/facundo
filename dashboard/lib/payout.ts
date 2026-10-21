import { createServiceClient } from "./supabaseAdmin";
import { computeSplit, floorPayout, effectivePaymentsLive, sumPayoutLegs, type PayoutLegRow } from "./payoutMath";
import { getRail } from "./rails";
import { testShopLiveAllowed } from "./railGate.ts";
import { captureError } from "./monitor";
import { getWalletBalances } from "./airwallex/balance";
import { hasSufficientFunds } from "./airwallex/funds";
import { closeCard, updateCardLimit } from "./airwallex/cards";
import { enqueueEffect } from "./outbox";
import { outstandingExposure, type ExposureRow } from "./payoutExposure";
import { shouldHoldAcceptLeg } from "./coldOffer.ts";
import { payoutHoldReason, shouldSweepReleaseHeldPayout, resolvePaymentsPaused } from "./payoutHold.ts";

// What a payout attempt did — returned so the caller (florist accept/deliver
// routes) can celebrate a balance increase. `added` is true only when a payout
// row that increases the balance was actually created (issued). `held` is true
// when the leg was parked for CX approval instead (no money yet).
export interface PayoutOutcome {
  added: boolean;
  amount: number;
  currency: string;
  payoutId: string | null;
  leg: "accept" | "delivery" | "manual";
  hasCard: boolean; // a real (revealable) card was issued
  held?: boolean; // parked pending CX approval
  /** This florist's tier pays in a SINGLE leg on accept, so the delivery leg
   *  legitimately does not exist (reason `zero-split`). Distinct from every
   *  other `added:false` — nothing failed, and nothing is owed. The photo
   *  upload route reads this to confirm the delivery instead of going quiet.
   *  See lib/payoutMath.ts::isSinglePayment. */
  singlePayment?: boolean;
  reason?: string; // why nothing was added, when added=false
  detail?: string; // raw rail error text, when reason is "rail-failed" — safe to show staff (no card data)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase-js admin client is loosely typed
type Admin = any;

async function settings(admin: Admin) {
  const { data, error } = await admin.from("app_settings").select("payments_live, payments_paused, hold_delivery_payouts").eq("id", 1).single();
  if (error) captureError("payout.settings_read_failed", error);
  return {
    live: data?.payments_live ?? false,
    // Fails CLOSED on a read error (DB blip, outage, missing row) — see
    // lib/payoutHold.ts::resolvePaymentsPaused for why `paused` can't use the
    // same "default to false" shape as every other field here.
    paused: resolvePaymentsPaused(data?.payments_paused, !!error),
    // Defaults to FALSE, unlike every other guard here. The 30% waits on the
    // delivered photo and the AI check of it, both of which now exist; this
    // switch is the operator's manual override, not the resting state.
    //
    // `workflow_mode` is deliberately no longer read. It gates system-initiated
    // steps, not paying a florist who has accepted or delivered — see
    // lib/payoutHold.ts for the policy and why it changed.
    holdDelivery: data?.hold_delivery_payouts ?? false,
  };
}

/** The cold-offer payout knobs. Read separately from settings() so the
 * provisional hold can be added without widening a helper every payout already
 * depends on. Fails to `null`, which shouldHoldAcceptLeg reads as "use the
 * defaults" — never as "don't hold". */
async function coldOfferSettings(admin: Admin) {
  const { data } = await admin
    .from("app_settings")
    .select("cold_offer_auto_payout_cap_eur")
    .eq("id", 1)
    .single();
  return data ?? null;
}

// Exposure-cap + (live) funds guards. Shared by the immediate-issue path and the
// held-release path so a held leg re-checks exposure/funds at approval time.
async function guardExposureAndFunds(
  admin: Admin,
  o: { floristId: string; amount: number; currency: string; tier: { exposure_cap_eur: number | null }; live: boolean; assignmentId: string; leg: string; excludePayoutId?: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { floristId, amount, currency, tier, live, assignmentId, leg, excludePayoutId } = o;
  if (tier.exposure_cap_eur != null) {
    // Count issued AND in-flight `pending` legs (a concurrent release parks its
    // row at `pending` before it settles) so simultaneous approvals can't each
    // slip under the cap. Exclude the row we're currently releasing.
    //
    // Two florist-filtered queries, not one unfiltered scan: manual legs carry
    // the florist on the direct column, order legs only through the assignment
    // embed, and PostgREST can't OR across a column and an embedded filter in
    // one request. Filtering server-side keeps this correct past Supabase's
    // 1000-row cap (an unfiltered fetch silently truncated, undercounting the
    // sum) — see payoutExposure.ts for how the two row shapes are summed.
    const [{ data: manualRows }, { data: orderRows }] = await Promise.all([
      admin.from("payouts").select("id, amount, florist_id").eq("florist_id", floristId).in("status", ["issued", "pending"]),
      admin.from("payouts").select("id, amount, order_assignments!inner(florist_id)").eq("order_assignments.florist_id", floristId).in("status", ["issued", "pending"]),
    ]);
    const out: ExposureRow[] = [
      ...(manualRows ?? []).map((r: Admin) => ({ id: r.id, amount: r.amount, florist_id: r.florist_id, order_assignments: null })),
      ...(orderRows ?? []).map((r: Admin) => ({ id: r.id, amount: r.amount, florist_id: null, order_assignments: r.order_assignments })),
    ];
    const outstanding = outstandingExposure(out, floristId, excludePayoutId);
    if (outstanding + amount > tier.exposure_cap_eur) {
      await admin.from("payment_events").insert({ payout_id: null, type: "exposure_capped", payload: { assignmentId, leg, amount, cap: tier.exposure_cap_eur } });
      captureError("payout.exposure_capped", new Error(`exposure cap reached for ${assignmentId}:${leg} (amount ${amount}, cap ${tier.exposure_cap_eur})`));
      return { ok: false, reason: "exposure_capped" };
    }
  }
  if (live) {
    try {
      const funds = hasSufficientFunds(await getWalletBalances(), currency, Math.round(amount * 100));
      if (!funds.ok) {
        await admin.from("payment_events").insert({ payout_id: null, type: "insufficient_funds", payload: { assignmentId, leg, amount, currency, available: funds.available } });
        captureError("payout.insufficient_funds", new Error(`insufficient Airwallex funds for ${assignmentId}:${leg} (need ${amount} ${currency}, have ${funds.available})`));
        return { ok: false, reason: "insufficient_funds" };
      }
    } catch (e) {
      captureError("payout.funds_check_failed", e); // fail-open but paged
    }
  }
  return { ok: true };
}

// Issue an amount on the rail for an EXISTING payout row + finalize atomically.
// Used both by the immediate-issue path and the held-release path.
async function issueAndFinalize(
  admin: Admin,
  o: { payoutId: string; assignmentId: string | null; orderId: string | null; leg: "accept" | "delivery" | "manual"; amount: number; currency: string; live: boolean },
): Promise<PayoutOutcome> {
  const { payoutId, assignmentId, orderId, leg, amount, currency, live } = o;
  const rail = getRail(live);
  const ref = assignmentId ? `${assignmentId}:${leg}` : `manual:${payoutId}`;
  const result = await rail.issue(Math.round(amount * 100), currency, ref);
  const { error: finErr } = await admin.rpc("finalize_payout", {
    p_payout_id: payoutId,
    p_ok: result.ok,
    p_provider_ref: result.ok ? result.providerRef : null,
    p_event_payload: result.ok ? { last4: result.last4, expiry: result.expiry } : { error: result.error },
    p_order_id: orderId,
    p_leg: leg,
    p_amount: amount,
  });
  if (finErr) captureError("payout.finalize_failed", finErr);
  if (!result.ok) {
    captureError("payout.failed", new Error(`payout ${assignmentId ?? `manual:${payoutId}`}:${leg} failed — ${result.error}`));
    if (assignmentId) {
      // Durable retry: the outbox re-attempts this failed leg with backoff, then
      // surfaces it in the CX hub if it stays dead. Manual legs have no order to
      // surface against and no clawback path, so an unattended background retry
      // could double-issue — a human retries them by hand instead, via the
      // "Retry issue" button on /payments/[id].
      await enqueueEffect("payout", { payoutId }, { orderId, dedupeKey: `payout:${payoutId}` });
    }
  }
  const hasCard = result.ok && live && typeof result.providerRef === "string" && !result.providerRef.startsWith("ledger:");
  return { added: result.ok, amount: result.ok ? amount : 0, currency, payoutId, leg, hasCard, reason: result.ok ? undefined : "rail-failed", detail: result.ok ? undefined : result.error };
}

// `verdict` (delivery leg only) is the AI photo-verification outcome. As of
// 2026-08-20 it no longer affects whether the leg holds — the AI check's
// calibration isn't trustworthy enough yet to gate real payouts on (see
// lib/payoutHold.ts's header comment for the finding that drove this) — it is
// only recorded (`payment_events.payload.verdict`, and separately to
// `photo_verifications` by the caller) for visibility while the agent is
// re-tuned. `force` skips every gate, and is used only by the explicit staff
// "release without photo" override (a human is authorising it by hand). See
// lib/payoutHold.ts for the full hold rule.
async function issueLeg(assignmentId: string, leg: "accept" | "delivery", verdict?: "pass" | "review" | "fail", force = false): Promise<PayoutOutcome> {
  const admin = createServiceClient();
  const none = (reason: string, currency = "EUR"): PayoutOutcome => ({
    added: false, amount: 0, currency, payoutId: null, leg, hasCard: false, reason,
  });

  const { data: a } = await admin.from("order_assignments").select("id, order_id, florist_id, payout_price, orders(currency, is_demo), florists(trust_tier, is_test_shop)").eq("id", assignmentId).single();
  if (!a) return none("no-assignment");
  const isTestShop = (a as Admin).florists?.is_test_shop === true;
  const isDemoOrder = (a as Admin).orders?.is_demo === true;
  const tierCode = (a as Admin).florists?.trust_tier;
  if (!tierCode) return none("no-tier"); // unassigned tier → can't pay yet (CX assigns manually)
  const { data: tier } = await admin.from("trust_tiers").select("*").eq("code", tierCode).single();
  if (!tier) return none("no-tier");

  // payout_price is the florist's share of the order total (admin-configurable
  // percent, e.g. 55%), locked in at match time — see insertCandidates /
  // /api/orders/rematch. The accept/delivery tier split then divides THIS amount,
  // not the raw order total.
  const total = (a as Admin).payout_price ?? 0;
  const currency = (a as Admin).orders?.currency ?? "EUR";
  const orderId = (a as Admin).order_id;
  const split = computeSplit(total, tier);
  const amount = leg === "accept" ? split.accept : split.delivery;
  if (amount <= 0) {
    // Two different things land here and the caller has to tell them apart:
    //   - a tier with a 0% leg BY DESIGN (tier 4's accept leg, tier 1's
    //     delivery leg) — nothing is owed and nothing has gone wrong;
    //   - a genuinely zero payout_price, which is a data problem.
    // `singlePayment` marks the first case for the delivery leg specifically,
    // so the photo upload route can confirm the delivery to the florist rather
    // than silently returning "no money, no explanation".
    return { ...none("zero-split", currency), singlePayment: leg === "delivery" && split.singlePayment };
  }

  const { live: rawLive, paused, holdDelivery } = await settings(admin);
  // A shop we own never gets a real card on production, whatever the global
  // toggle says — see payoutMath.ts. On the Airwallex sandbox, staff can opt an
  // ordinary (non-demo) test-shop order into a real sandbox card; a /testing
  // demo-sandbox order is excluded from that override. See railGate.ts.
  const live = effectivePaymentsLive(rawLive, isTestShop, testShopLiveAllowed(isDemoOrder));

  // Accepting an order and uploading a delivered photo are SELF-APPROVING — the
  // florist has done the work, so the leg releases without waiting for a human,
  // including in `semi` mode. Only a substantive finding about this florist
  // parks the leg as `held` for CX — the AI photo check's verdict is NOT one of
  // those findings right now (photo-verdict holding is disabled, 2026-08-20).
  // The whole rule, and why it changed, is in lib/payoutHold.ts.
  //
  // A held row is created even when payments are PAUSED: it reserves no money on
  // the rail, and dropping it would silently lose the delivery (the florist
  // can't re-trigger). The kill switch only blocks release.
  const holdReason = payoutHoldReason({
    leg,
    force,
    tierHold: split.hold,
    // A cold-offer shop that joined by accepting has passed no checks at all —
    // no history, a self-declared address, a listing we scraped. Below the auto
    // cap the 70% still moves instantly (that is the promise the recruiting copy
    // makes, and breaking it would be a lie); above it, CX releases by hand.
    provisionalHold: shouldHoldAcceptLeg(tierCode, amount, await coldOfferSettings(admin)),
    holdDelivery,
    // `verdict` is deliberately NOT passed here — payoutHoldReason() no longer
    // accepts it. Photo-verdict holding is disabled (2026-08-20); the verdict
    // is still recorded below (`held_for_review`'s payload) whenever some
    // OTHER reason parks the leg, but it never causes the hold itself.
  });
  if (holdReason) {
    const { data: heldRow, error: hErr } = await admin.from("payouts")
      .insert({ assignment_id: assignmentId, leg, amount, currency, rail: live ? "card" : "sepa", status: "held" })
      .select("id").single();
    if (hErr) {
      if ((hErr as Admin)?.code === "23505") return none("already-issued", currency); // idempotent no-op
      captureError("payout.hold_insert_failed", hErr);
      return none("insert-failed", currency);
    }
    await admin.from("payment_events").insert({ payout_id: heldRow.id, type: "held_for_review", payload: { assignmentId, leg, tier: tierCode, reason: holdReason, verdict: verdict ?? null } });
    await admin.from("order_events").insert({ order_id: orderId, type: "payout_held", payload: { leg, amount } });
    return { added: false, amount: 0, currency, payoutId: heldRow.id, leg, hasCard: false, held: true, reason: "held" };
  }

  // Immediate-issue path (accept leg, or delivery with the hold gate off).
  // Kill switch: pause blocks actual issuance.
  if (paused) {
    await admin.from("payment_events").insert({ payout_id: null, type: "payments_paused", payload: { assignmentId, leg, amount } });
    return none("paused", currency);
  }

  const guard = await guardExposureAndFunds(admin, { floristId: (a as Admin).florist_id, amount, currency, tier, live, assignmentId, leg });
  if (!guard.ok) return none(guard.reason, currency);

  // INSERT-FIRST idempotency: the partial unique index
  // (assignment_id, leg) WHERE status<>'clawed_back' makes a concurrent/duplicate
  // issue fail here (23505) instead of double-issuing.
  const { data: payout, error: insErr } = await admin
    .from("payouts")
    .insert({ assignment_id: assignmentId, leg, amount, currency, rail: live ? "card" : "sepa", status: "pending" })
    .select("id").single();
  if (insErr || !payout) {
    if ((insErr as Admin)?.code === "23505") return none("already-issued", currency);
    captureError("payout.insert_failed", insErr);
    return none("insert-failed", currency);
  }
  return issueAndFinalize(admin, { payoutId: payout.id, assignmentId, orderId, leg, amount, currency, live });
}

export const payoutOnAccept = (id: string) => issueLeg(id, "accept");
export const payoutOnDelivered = (id: string, verdict?: "pass" | "review" | "fail") => issueLeg(id, "delivery", verdict);


// --- Total payout for one order/assignment (accept leg + delivery leg) -------
//
// Used to write "Tookan Cost Of Order" back to Shopify at delivery (both legs
// exist by then — see lib/shopifyWriteback.ts). The pure sum (`sumPayoutLegs`,
// which statuses count and why) lives in lib/payoutMath.ts — see that file's
// header for why it moved there rather than staying in this file.

// Thin DB wrapper around sumPayoutLegs: reads both legs for one assignment and
// sums them. Returns null when there is nothing to report yet (no rows at
// all) rather than a misleading `{ amount: 0 }` — callers treat null as "don't
// write the metafield". Best-effort: a read error is captured and reported as
// null, never thrown — this must never block the delivery-photo flow that
// calls it.
export async function getTotalPayoutForAssignment(
  assignmentId: string,
): Promise<{ amount: number; currency: string } | null> {
  const admin = createServiceClient();
  const { data, error } = await admin
    .from("payouts")
    .select("leg, amount, currency, status")
    .eq("assignment_id", assignmentId)
    .in("leg", ["accept", "delivery"]);
  if (error) {
    captureError("payout.total_read_failed", error);
    return null;
  }
  const rows = (data ?? []) as { leg: PayoutLegRow["leg"]; amount: number | null; currency: string | null; status: string }[];
  if (!rows.length) return null;
  const amount = sumPayoutLegs(rows);
  // Both legs are issued in the same currency (the order's currency, locked in
  // at match time) — take it off whichever row has it rather than assuming a
  // fixed index.
  const currency = rows.find((r) => r.currency)?.currency ?? "EUR";
  return { amount, currency };
}

// Admin ad-hoc payout: a single-use card issued to a florist with no order behind
// it (goodwill, correction, one-off). Same guards as an order-driven leg (kill
// switch, exposure cap, live-funds) via the same guardExposureAndFunds — the
// only difference is there's no order_assignment to derive the florist/tier from,
// so they're looked up directly. `reason` is recorded on payment_events before
// the issue attempt so it's captured even if issuance then fails.
export async function issueManualPayout(o: { floristId: string; amount: number; currency: string; reason: string; actor: string }): Promise<PayoutOutcome> {
  const admin = createServiceClient();
  const none = (reason: string): PayoutOutcome => ({ added: false, amount: 0, currency: o.currency, payoutId: null, leg: "manual", hasCard: false, reason });

  const { data: f } = await admin.from("florists").select("trust_tier, is_test_shop").eq("id", o.floristId).single();
  const tierCode = (f as Admin)?.trust_tier;
  if (!tierCode) return none("no-tier"); // same rule as order payouts — no tier, no exposure math, no pay
  const { data: tier } = await admin.from("trust_tiers").select("*").eq("code", tierCode).single();
  if (!tier) return none("no-tier");

  const { live: rawLive, paused } = await settings(admin);
  // No order behind a manual payout, so it's never a /testing demo order.
  const live = effectivePaymentsLive(rawLive, (f as Admin)?.is_test_shop === true, testShopLiveAllowed(false));
  if (paused) {
    await admin.from("payment_events").insert({ payout_id: null, type: "payments_paused", payload: { floristId: o.floristId, leg: "manual", amount: o.amount } });
    return none("paused");
  }

  const guard = await guardExposureAndFunds(admin, { floristId: o.floristId, amount: o.amount, currency: o.currency, tier, live, assignmentId: `manual:${o.floristId}`, leg: "manual" });
  if (!guard.ok) return none(guard.reason);

  const { data: payout, error: insErr } = await admin
    .from("payouts")
    .insert({ florist_id: o.floristId, leg: "manual", amount: o.amount, currency: o.currency, rail: live ? "card" : "sepa", status: "pending" })
    .select("id").single();
  if (insErr || !payout) {
    captureError("payout.manual_insert_failed", insErr);
    return none("insert-failed");
  }

  await admin.from("payment_events").insert({ payout_id: payout.id, type: "manual_issue_requested", payload: { floristId: o.floristId, reason: o.reason, actor: o.actor } });

  return issueAndFinalize(admin, { payoutId: payout.id, assignmentId: null, orderId: null, leg: "manual", amount: o.amount, currency: o.currency, live });
}

// CX approves a HELD payout → release it (re-checks kill switch + exposure/funds).
// CAS held→pending so two approvers can't double-issue.
export async function releaseHeldPayout(payoutId: string, actor: string): Promise<PayoutOutcome> {
  const admin = createServiceClient();
  const none = (reason: string, currency = "EUR"): PayoutOutcome => ({ added: false, amount: 0, currency, payoutId, leg: "delivery", hasCard: false, reason });

  const { data: claimed } = await admin.from("payouts")
    .update({ status: "pending" }).eq("id", payoutId).eq("status", "held")
    .select("id, assignment_id, leg, amount, currency").single();
  if (!claimed) return none("not-held");
  const leg = claimed.leg as "accept" | "delivery";
  const amount = claimed.amount ?? 0;
  const currency = claimed.currency ?? "EUR";

  const { live: rawLive, paused } = await settings(admin);
  if (paused) {
    await admin.from("payouts").update({ status: "held" }).eq("id", payoutId).eq("status", "pending"); // roll back
    return none("paused", currency);
  }

  const { data: a } = await admin.from("order_assignments").select("id, order_id, florist_id, florists(trust_tier, is_test_shop), orders(is_demo)").eq("id", claimed.assignment_id).single();
  if (!a) { await admin.from("payouts").update({ status: "held" }).eq("id", payoutId).eq("status", "pending"); return none("no-assignment", currency); }
  const live = effectivePaymentsLive(
    rawLive,
    (a as Admin).florists?.is_test_shop === true,
    testShopLiveAllowed((a as Admin).orders?.is_demo === true),
  );
  const tierCode = (a as Admin).florists?.trust_tier;
  const { data: tier } = tierCode ? await admin.from("trust_tiers").select("*").eq("code", tierCode).single() : { data: null };

  if (tier) {
    const guard = await guardExposureAndFunds(admin, { floristId: (a as Admin).florist_id, amount, currency, tier, live, assignmentId: claimed.assignment_id, leg, excludePayoutId: payoutId });
    if (!guard.ok) { await admin.from("payouts").update({ status: "held" }).eq("id", payoutId).eq("status", "pending"); return none(guard.reason, currency); }
  }

  await admin.from("order_events").insert({ order_id: (a as Admin).order_id, type: "payout_approved", actor, payload: { payoutId, leg } });
  return issueAndFinalize(admin, { payoutId, assignmentId: claimed.assignment_id, orderId: (a as Admin).order_id, leg, amount, currency, live });
}

// Unattended release sweep — called on a cron tick (POST /api/payouts/held-sweep),
// same wiring as the outbox drain. Held payouts have no UI release surface today
// (see lib/payoutHold.ts and /lifecycle, payout-accept), so a genuinely stale
// hold — the operator's delivery-gate switch was on, and has since been turned
// back off — would otherwise sit forever. Every other hold reason (tier-hold,
// provisional-shop, plus the legacy `photo-verdict` on rows parked before that
// hold was disabled 2026-08-20) is a substantive finding and is left alone;
// shouldSweepReleaseHeldPayout is the one place that decides which is which.
export async function sweepHeldPayouts(): Promise<{ checked: number; released: number; paused: boolean }> {
  const admin = createServiceClient();
  const { paused, holdDelivery } = await settings(admin);
  if (paused) return { checked: 0, released: 0, paused: true };

  const { data: held } = await admin.from("payouts").select("id, leg").eq("status", "held").eq("leg", "delivery");
  const rows = (held ?? []) as { id: string; leg: "accept" | "delivery" | "manual" }[];
  if (!rows.length) return { checked: 0, released: 0, paused: false };

  // One batch read of the hold reason recorded at park time — the DECISION that
  // matters was already made once by issueLeg; this sweep only re-checks whether
  // it has since expired, never re-derives a new one.
  const ids = rows.map((r) => r.id);
  const { data: events } = await admin
    .from("payment_events")
    .select("payout_id, payload, created_at")
    .eq("type", "held_for_review")
    .in("payout_id", ids)
    .order("created_at", { ascending: false });
  const reasonByPayout = new Map<string, string | null>();
  for (const e of (events ?? []) as Admin[]) {
    if (!reasonByPayout.has(e.payout_id)) reasonByPayout.set(e.payout_id, e.payload?.reason ?? null);
  }

  let released = 0;
  for (const row of rows) {
    const storedReason = reasonByPayout.get(row.id) ?? null;
    if (!shouldSweepReleaseHeldPayout({ leg: row.leg, storedReason, paused, holdDelivery })) continue;
    const outcome = await releaseHeldPayout(row.id, "system:auto-release-sweep");
    if (outcome.added) released++;
  }
  return { checked: rows.length, released, paused: false };
}

// CX rejects a HELD payout (bad proof) → void it (CAS held→failed) + record why.
export async function rejectHeldPayout(payoutId: string, actor: string, reason: string): Promise<{ ok: boolean }> {
  const admin = createServiceClient();
  const { data: rejected } = await admin.from("payouts")
    .update({ status: "failed" }).eq("id", payoutId).eq("status", "held")
    .select("id, assignment_id, order_assignments(order_id)").single();
  if (!rejected) return { ok: false };
  const orderId = (rejected as Admin).order_assignments?.order_id;
  await admin.from("payment_events").insert({ payout_id: payoutId, type: "payout_rejected", payload: { reason, actor } });
  if (orderId) await admin.from("order_events").insert({ order_id: orderId, type: "payout_rejected", actor, payload: { payoutId, reason } });
  return { ok: true };
}

// Staff override: release the 30% when the florist delivered but no proof photo
// exists (CX confirmed delivery out-of-band). Two cases: (1) a held row already
// exists (photo was uploaded but held) → record the override reason + release it
// via the normal path; (2) no delivery row exists at all (proof never uploaded,
// so `issueLeg` was never called) → force-issue the leg, bypassing the hold gate.
// A `reason` is mandatory and recorded on both the payout and the order timeline.
export async function releaseWithoutPhoto(assignmentId: string, actor: string, reason: string): Promise<PayoutOutcome> {
  const admin = createServiceClient();
  // Look only at the ACTIONABLE row. The partial unique index excludes
  // failed/clawed_back, so a rejected leg (failed) can coexist with a fresh
  // held/issued one — filtering those out guarantees maybeSingle() sees ≤1 row
  // and we act on the live leg (not error out on 2 rows and mis-fall-through).
  const { data: existing } = await admin.from("payouts").select("id, status").eq("assignment_id", assignmentId).eq("leg", "delivery").not("status", "in", "(failed,clawed_back)").maybeSingle();
  if (existing) {
    if (existing.status === "held") {
      await admin.from("payment_events").insert({ payout_id: existing.id, type: "released_without_photo", payload: { actor, reason } });
      return releaseHeldPayout(existing.id, actor);
    }
    // Already issued / pending / failed — nothing to force from here.
    return { added: false, amount: 0, currency: "EUR", payoutId: existing.id, leg: "delivery", hasCard: false, reason: `already-${existing.status}` };
  }
  const { data: a } = await admin.from("order_assignments").select("order_id").eq("id", assignmentId).single();
  if ((a as Admin)?.order_id) {
    await admin.from("order_events").insert({ order_id: (a as Admin).order_id, type: "released_without_photo", actor, payload: { reason } });
  }
  return issueLeg(assignmentId, "delivery", "pass", true); // force past the hold gate
}

// Re-attempt a FAILED payout row (called by the outbox drainer, or by staff via
// POST /api/payouts/[id]/retry). CAS failed→pending so a concurrent drain/retry
// can't double-issue; re-checks the kill switch + exposure/funds; then
// issue+finalize. Handles BOTH an order-driven leg (assignment_id set — florist
// comes from the assignment) and a manual leg (assignment_id null, florist_id
// set directly). `actor` is only present for a manual (staff-triggered) retry —
// the outbox drainer calls this with no actor, same as before.
export async function retryPayoutRow(payoutId: string, actor?: string): Promise<PayoutOutcome> {
  const admin = createServiceClient();
  const none = (reason: string, currency = "EUR", leg: "accept" | "delivery" | "manual" = "delivery"): PayoutOutcome => ({ added: false, amount: 0, currency, payoutId, leg, hasCard: false, reason });

  const { data: claimed } = await admin.from("payouts")
    .update({ status: "pending" }).eq("id", payoutId).eq("status", "failed")
    .select("id, assignment_id, florist_id, leg, amount, currency").single();
  if (!claimed) return none("not-failed"); // already resolved / not retryable
  const leg = claimed.leg as "accept" | "delivery" | "manual";
  const amount = claimed.amount ?? 0;
  const currency = claimed.currency ?? "EUR";

  const rollback = async () => { await admin.from("payouts").update({ status: "failed" }).eq("id", payoutId).eq("status", "pending"); };

  const { live: rawLive, paused } = await settings(admin);
  if (paused) { await rollback(); return none("paused", currency, leg); }

  let floristId: string | null;
  let orderId: string | null = null;
  let isDemoOrder = false;
  if (claimed.assignment_id) {
    const { data: a } = await admin.from("order_assignments").select("id, order_id, florist_id, orders(is_demo)").eq("id", claimed.assignment_id).single();
    if (!a) { await rollback(); return none("no-assignment", currency, leg); }
    floristId = (a as Admin).florist_id;
    orderId = (a as Admin).order_id;
    isDemoOrder = (a as Admin).orders?.is_demo === true;
  } else {
    floristId = claimed.florist_id;
  }
  if (!floristId) { await rollback(); return none("no-assignment", currency, leg); }

  const { data: florist } = await admin.from("florists").select("trust_tier, is_test_shop").eq("id", floristId).single();
  const live = effectivePaymentsLive(rawLive, (florist as Admin)?.is_test_shop === true, testShopLiveAllowed(isDemoOrder));
  const tierCode = (florist as Admin)?.trust_tier;
  const { data: tier } = tierCode ? await admin.from("trust_tiers").select("*").eq("code", tierCode).single() : { data: null };
  // No tier → no exposure math, so block the retry rather than issue unguarded.
  // Same rule as issueLeg / issueManualPayout ("no tier, no pay").
  if (!tier) { await rollback(); return none("no-tier", currency, leg); }
  const guard = await guardExposureAndFunds(admin, { floristId, amount, currency, tier, live, assignmentId: claimed.assignment_id ?? `manual:${floristId}`, leg, excludePayoutId: payoutId });
  if (!guard.ok) { await rollback(); return none(guard.reason, currency, leg); }
  if (actor) {
    await admin.from("payment_events").insert({ payout_id: payoutId, type: "manual_retry_requested", payload: { actor } });
  }
  return issueAndFinalize(admin, { payoutId, assignmentId: claimed.assignment_id ?? null, orderId, leg, amount, currency, live });
}

// Staff/Finance action: raise a still-open single-use payout card's spend
// limit IN PLACE (same card, no reissue) — see lib/airwallex/cards.ts's
// updateCardLimit for the FX-conversion scenario this exists for. `reason` is
// mandatory and always recorded on payment_events, same convention as
// issueManualPayout/releaseWithoutPhoto — this action replaces what was, on
// the two orders that motivated it, a raw Airwallex-dashboard edit with no
// record on our side at all.
export async function adjustCardLimit(
  payoutId: string,
  newAmount: number,
  reason: string,
  actor: string,
): Promise<{ ok: true; newAmount: number } | { ok: false; reason: string }> {
  const admin = createServiceClient();
  const { data: p } = await admin
    .from("payouts")
    .select("id, amount, currency, rail, provider_ref, status, card_status, assignment_id, florist_id")
    .eq("id", payoutId)
    .single();
  if (!p) return { ok: false, reason: "not-found" };
  const isRealCard = p.rail === "card" && typeof p.provider_ref === "string" && !(p.provider_ref as string).startsWith("ledger:");
  if (!isRealCard) return { ok: false, reason: "no-card" };
  // "paid"/`card_status: "USED"` means the card's one allowed transaction
  // already succeeded — updateCardLimit's own doc comment says raising the
  // limit only helps BEFORE that happens, so a stale-looking "issued" row
  // isn't enough; block on every terminal/spent state we know about. This is
  // still only as good as `payouts.card_status`, which has exactly one writer
  // (the Airwallex webhook — see the `pay-state-stale` lifecycle branch) and
  // can lag reality if a webhook was missed; updateCardLimit re-checks the
  // LIVE card status from Airwallex itself as the authoritative backstop.
  if (p.status === "paid" || p.status === "clawed_back" || p.status === "failed") return { ok: false, reason: "card-inactive" };
  if (p.card_status === "USED" || p.card_status === "CLOSED") return { ok: false, reason: "card-inactive" };
  // A lower/equal "adjustment" isn't this action's job (shrinking a florist's
  // already-quoted limit belongs to clawback, which also closes the card) —
  // guard here rather than trusting every caller to check. Compares against
  // the row's CURRENT amount, which this function keeps in sync below (a
  // second raise on the same card compares against the first raise's result,
  // not the original quote).
  if (!(newAmount > (p.amount ?? 0))) return { ok: false, reason: "not-an-increase" };

  // Same exposure-cap re-check every other money-moving path in this file
  // does (issueLeg, releaseHeldPayout, retryPayoutRow) — a raised limit is
  // real additional liability against this florist, not a freebie. Resolve
  // the florist the same way retryPayoutRow does: assignment_id for an
  // order-driven leg, the direct column for a manual one.
  let floristId: string | null = p.florist_id ?? null;
  if (!floristId && p.assignment_id) {
    const { data: a } = await admin.from("order_assignments").select("florist_id").eq("id", p.assignment_id).single();
    floristId = a?.florist_id ?? null;
  }
  if (!floristId) return { ok: false, reason: "no-assignment" };
  const { data: florist } = await admin.from("florists").select("trust_tier").eq("id", floristId).single();
  const tierCode = florist?.trust_tier;
  if (!tierCode) return { ok: false, reason: "no-tier" }; // no tier, no exposure math — same rule as every other issuance path
  const { data: tier } = await admin.from("trust_tiers").select("*").eq("code", tierCode).single();
  if (!tier) return { ok: false, reason: "no-tier" };
  // Exclude this row from the outstanding sum (it's about to be re-counted at
  // its NEW amount) — same shape as releaseHeldPayout's own guard call.
  const guard = await guardExposureAndFunds(admin, {
    floristId,
    amount: newAmount,
    currency: p.currency ?? "EUR",
    tier,
    live: true, // isRealCard already established this is a live Airwallex card, never a ledger sentinel
    assignmentId: p.assignment_id ?? `manual:${floristId}`,
    leg: "limit-adjust", // not the accept/delivery/manual leg union — just a readable tag on the exposure_capped event, if one fires
    excludePayoutId: payoutId,
  });
  if (!guard.ok) return { ok: false, reason: guard.reason };

  const res = await updateCardLimit(p.provider_ref as string, Math.round(newAmount * 100), p.currency ?? "EUR");
  if (!res.ok) {
    captureError("payout.card_limit_adjust_failed", new Error(`limit adjust failed for payout ${payoutId}: ${res.error}`));
    return { ok: false, reason: res.error };
  }
  // Keep the ledger in sync with the card that's now actually live — without
  // this, outstandingExposure() (read by every other guardExposureAndFunds
  // call for this florist) keeps summing the pre-raise amount, and a second
  // adjustCardLimit call would compare its new value against the stale one.
  await admin.from("payouts").update({ amount: newAmount }).eq("id", payoutId);
  await admin.from("payment_events").insert({
    payout_id: payoutId,
    type: "card_limit_adjusted",
    payload: { oldAmount: p.amount, newAmount, currency: p.currency, reason, actor },
  });
  return { ok: true, newAmount };
}

// Reclaim overpaid legs on cancel/refund/edit-lower via the atomic, idempotent,
// race-safe `clawback_order` RPC (nets prior clawbacks, serialized per order).
export async function clawbackForOrder(orderId: string, newTotal: number | null): Promise<void> {
  const admin = createServiceClient();

  // Void any HELD (not-yet-issued) payouts for this order first — they're not
  // money out, but a held row on a cancelled order would linger in the CX queue.
  const { data: orderAssignments } = await admin.from("order_assignments").select("id, payout_percent").eq("order_id", orderId);
  const aIds = (orderAssignments ?? []).map((r: Admin) => r.id);
  if (aIds.length) {
    const { data: voided } = await admin.from("payouts").update({ status: "failed" }).in("assignment_id", aIds).eq("status", "held").select("id");
    for (const v of voided ?? []) {
      await admin.from("payment_events").insert({ payout_id: (v as Admin).id, type: "payout_voided", payload: { orderId, reason: "order-unwound" } });
    }
  }

  // paid legs were computed off payout_price (order total × the percent locked in
  // at match time), NOT the raw order total — so an edited-total reclaim must
  // apply that SAME stored percent, not whatever the admin setting is today.
  // Floors to a whole unit, like computePayoutPrice: anything softer here would
  // reclaim less than the same order would have been paid from scratch.
  const payoutPercent = (orderAssignments ?? []).find((r: Admin) => r.payout_percent != null)?.payout_percent ?? null;
  const newFloristTotal = newTotal != null && payoutPercent != null ? floorPayout((newTotal * payoutPercent) / 100) : newTotal;

  const { data: recovered, error } = await admin.rpc("clawback_order", { p_order_id: orderId, p_new_total: newFloristTotal });
  if (error) {
    captureError("payout.clawback_failed", error);
    return;
  }
  if (!recovered || Number(recovered) <= 0) return; // nothing reclaimed

  // Close each still-live card for this order's issued legs so it can't be spent.
  const { data: cards } = await admin.from("payouts").select("id, rail, provider_ref").eq("status", "issued").in("assignment_id", aIds);
  for (const row of cards ?? []) {
    const r = row as Admin;
    const isRealCard = r.rail === "card" && typeof r.provider_ref === "string" && !r.provider_ref.startsWith("ledger:");
    if (!isRealCard) continue;
    const res = await closeCard(r.provider_ref).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : "close error" }));
    if (res.ok) await admin.from("payouts").update({ card_status: "CLOSED" }).eq("id", r.id);
    await admin.from("payment_events").insert({
      payout_id: r.id,
      type: res.ok ? "card_closed" : "card_close_failed",
      payload: res.ok ? { orderId, cardId: r.provider_ref } : { orderId, cardId: r.provider_ref, error: (res as { error: string }).error },
    });
    if (!res.ok) captureError("payout.card_close_failed", new Error(`clawback could not close card ${r.provider_ref} for order ${orderId}`));
  }
}

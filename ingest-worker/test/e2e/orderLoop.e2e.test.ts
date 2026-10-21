// REAL E2E harness for the automatic working-set order loop: Shopify order ->
// working-set selection -> match -> offer -> accept/70% -> photo/30% ->
// writeback, plus a negative (no-match -> central attention) case.
//
// This replaces "the smallest thing that could plausibly stand in for an E2E
// test" with something that actually drives production modules against real
// state transitions, recorded in an in-memory fake Supabase (see
// fakeSupabase.ts) rather than only asserting on lifecycle metadata the way
// dashboard/lib/orderLoopContract.test.mjs does (that file stays — it is a
// structural guard on lib/lifecycle.ts, a different job from this one).
//
// WHY IT LIVES HERE (ingest-worker/test/e2e/, run by `npm test` -> vitest):
// vitest already has real module-mocking (vi.mock/vi.stubGlobal) and is the
// tool this repo already uses to drive real modules against a stubbed
// Supabase client (see reconcile.test.ts). The dashboard has neither — its
// `npm test` is plain `node --test`, chosen deliberately so lib/*.test.mjs
// files need no build step, but that means NO path-alias resolution
// (`@/lib/...`) and NO module-mocking. Most of the order loop's intake+match
// half lives in ingest-worker with only relative imports, so it can be driven
// here unmodified. The dashboard-side pieces of the loop (the offer-wave
// cron, real Airwallex issuance, the real Shopify writeback HTTP calls) all
// go through `@/lib/supabaseAdmin`'s no-argument singleton and a chain of
// alias imports (waves.ts -> reachoutSend.ts / coldOffer.ts / ..., payout.ts
// -> rails.ts / airwallex/*, shopifyWriteback.ts -> externalOps.ts ->
// @/lib/supabaseAdmin) that plain `node --test` cannot mock and that vitest
// here cannot reach without adding cross-package alias config. That is real,
// separate follow-up work (see "STILL MOCKED" below) — out of scope for this
// first pass, per the brief that commissioned this harness.
//
// WHAT'S ACTUALLY REAL in this file (production modules, unmodified imports):
//   - ingest-worker/src/shopify.ts          parseShopifyOrder
//   - ingest-worker/src/workingSet.ts       isInWorkingSet (the working-set gate)
//   - ingest-worker/src/workingSetServer.ts workingSetConfig
//   - ingest-worker/src/db.ts               upsertOrder, replaceLineItems,
//                                            appendOrderEvent, findCityIdForOrder,
//                                            setOrderStatus, insertCandidates,
//                                            loadMatchableFlorists, countAcceptedForDay,
//                                            loadMatchConfig, loadTestShopMatching
//   - ingest-worker/src/match.ts             matchFlorists (the canonical ranking
//                                            algorithm), capKm
//   - ingest-worker/src/lateMatch.ts         matchAndWriteCandidates — the SAME
//                                            match+write orchestration the real
//                                            webhook path (orderWorkflow.ts) and
//                                            the late-tag path both call
//   - ingest-worker/src/autoIngest.ts        deliveryArea, queueIngestForArea
//   - dashboard/lib/payoutMath.ts            computePayoutPrice, computeSplit
//   - dashboard/lib/payoutHold.ts            payoutHoldReason
//   - dashboard/lib/shopifyTags.ts           unionTags
//   - dashboard/lib/orderStatus.ts           canTransition (validates every
//                                            simulated status move against the
//                                            real state machine)
//   - dashboard/lib/cxAttentionRules.ts      placementAttentionReason — the
//                                            pure classification rule central
//                                            CX attention (cxAttention.ts)
//                                            uses to decide an escalated order
//                                            needs a human; the negative-case
//                                            test below feeds it the REAL
//                                            escalated row matchAndWriteCandidates
//                                            just produced (see "STILL MOCKED"
//                                            below for why gatherAttention
//                                            itself still isn't invoked)
// The last four are dashboard files imported by RELATIVE path across the
// package boundary — safe only because all four are verified dependency-free
// (no imports at all, or only local pure siblings), so nothing in dashboard's
// node_modules (which ingest-worker doesn't have installed) needs resolving.
//
// STILL MOCKED / SIMULATED (the concrete next-task list):
//   - The Cloudflare Workflow runtime itself (WorkflowEntrypoint/step.do) is
//     never instantiated — `orderWorkflow.ts` needs `cloudflare:workers`,
//     which this Node/vitest process doesn't have. STEP 1 below calls the
//     same functions orderWorkflow.ts's steps call, in the same order,
//     instead of booting the Workflow.
//   - Postgres itself: fakeSupabase.ts is an in-memory query-builder stand-in,
//     not a real database (no transactions, constraints, or real joins).
//   - The offer-wave cron (dashboard/lib/waves.ts) and the actual offer
//     send (reachoutSend.ts, Resend/Telnyx) — STEP 3 advances the REAL
//     order_assignments row waves.ts would have produced (status
//     candidate -> sent -> accepted) directly, rather than running the cron.
//   - Real Airwallex issuance (dashboard/lib/payout.ts::issueLeg and
//     everything under dashboard/lib/airwallex/) — STEPS 3 & 4 use the real
//     amount/hold DECISION (computeSplit + payoutHoldReason) and then record
//     the payouts/order_events rows issueLeg would write, rather than calling
//     a payment rail.
//   - The AI photo-provider calls (dashboard/lib/photoVerify/{claude,gemini,
//     openrouter}.ts) and their pure consensus fold, combineVerdicts
//     (dashboard/lib/photoVerify/combine.ts) — combineVerdicts itself is pure
//     and normally would be driven here too, but it imports ./types.ts, which
//     imports the `zod` package; zod is a dashboard dependency not installed
//     under ingest-worker/node_modules, so pulling it in would mean adding a
//     cross-package dependency for one function. As of 2026-08-20 the photo
//     verdict no longer gates the delivery leg at all (see
//     dashboard/lib/payoutHold.ts's header comment) — the AI check's
//     calibration isn't trustworthy enough yet to hold real money on. STEP 4
//     calls the real payoutHoldReason with only the tier-hold input, which is
//     what still actually gates the money; the vote-combining step and the
//     (now-irrelevant to the hold decision) verdict are both skipped.
//   - The real Shopify writeback HTTP calls (dashboard/lib/shopifyWriteback.ts)
//     — STEP 5 uses the real unionTags() tag-merge helper against a stubbed
//     "Shopify remote" object, mirroring deliverWriteback's shape (an
//     order_events "shopify_writeback" row), instead of importing the module
//     (which would pull in externalOps.ts -> @/lib/supabaseAdmin and needs
//     alias resolution this test run doesn't have).
//   - Central CX attention (dashboard/lib/cxAttention.ts::gatherAttention) is
//     still not invoked directly — it pulls in @/lib/workingSet,
//     @/lib/workingSetServer, @/lib/i18n/issueLabels and @/lib/shopifyConflict
//     via the tsconfig `@/*` alias, which neither this vitest config nor the
//     dashboard's own `node --test` runner resolves (see scripts/tests.mjs's
//     EXCLUDED list for the identical failure mode on lib/apiAuth.test.mjs).
//     What IS now real: gatherAttention's rule-1 classification (unplaceable/
//     escalated vs. awaiting reach-out) was pulled out into a dependency-free
//     sibling, dashboard/lib/cxAttentionRules.ts::placementAttentionReason,
//     specifically so it has no `@/...` imports to trip over. The negative-case
//     test below feeds that REAL function the REAL escalated order row
//     matchAndWriteCandidates just wrote, and asserts it comes back exactly
//     as the "no florist found — escalated" attention row a human would see —
//     proving the classification, not just the DB signal it reads. Everything
//     else gatherAttention does (querying order_assignments/order_issues/
//     payouts/outbox/order_approvals/conversations, working-set filtering,
//     multi-reason sorting) is still unexercised here — see cxAttentionRules.ts's
//     header for why a full gatherAttention() call is a separate follow-up.
//
// NEXT TASK, if someone wants this fully full-stack: add a `resolve.alias`
// for `@/lib` -> `<repo>/dashboard/lib` to a NEW vitest config scoped to this
// e2e directory (don't touch the unit-test config — it should stay
// alias-free, matching the Workers bundler it mirrors), then vi.mock just the
// I/O edges (`@/lib/supabaseAdmin`, `fetch`, the Airwallex client, the email/
// SMS senders) so waves.ts, payout.ts and shopifyWriteback.ts run for real.

import { describe, it, expect } from "vitest";
import { createFakeDb, type Row } from "./fakeSupabase";
import { parseShopifyOrder } from "../../src/shopify";
import { isInWorkingSet, type WorkingSetOrder } from "../../src/workingSet";
import { workingSetConfig } from "../../src/workingSetServer";
import {
  upsertOrder,
  replaceLineItems,
  appendOrderEvent,
  findCityIdForOrder,
} from "../../src/db";
import { matchAndWriteCandidates } from "../../src/lateMatch";
import { deliveryArea } from "../../src/autoIngest";
import { computePayoutPrice, computeSplit, type TierSplit } from "../../../dashboard/lib/payoutMath";
import { payoutHoldReason } from "../../../dashboard/lib/payoutHold";
import { unionTags } from "../../../dashboard/lib/shopifyTags";
import { canTransition, type OrderStatus } from "../../../dashboard/lib/orderStatus";
import { placementAttentionReason } from "../../../dashboard/lib/cxAttentionRules";

// A florist inside the 20km default match cap of the delivery point used
// below (41.9861, 2.8250 — Girona), onboarded and payable.
const FLORIST_IN_RANGE: Row = {
  id: "florist-in-range",
  place_id: "place-in-range",
  lat: 41.99,
  lng: 2.83,
  rating: 4.7,
  review_count: 80,
  lifecycle_stage: "production",
  excluded_at: null,
  deleted_at: null,
  source: "existing",
  trust_tier: "1",
  delivery_radius_km: null,
  capacity_per_day: null,
  email: "shop@example.com",
  network_id: null,
  email_shared_count: 1,
  email_bounced_at: null,
  is_test_shop: false,
};

const APP_SETTINGS: Row = {
  id: 1,
  workflow_mode: "auto",
  default_payout_percent: 60,
  active_order_tags: ["fc-active"],
  test_shop_matching: "exclude",
};

// A real tier-1 split (accept/deliver 70/30), driven through the real
// computeSplit/payoutHoldReason below rather than reimplemented inline.
const TIER_1_SPLIT: TierSplit = { split_on_accept: 70, split_on_delivery: 30, photo_required: true, hold_payout: false };

function rawShopifyOrder(over: Record<string, unknown>): unknown {
  return {
    id: 9000000,
    name: "#9000",
    order_number: 9000,
    created_at: "2026-08-01T09:00:00+02:00",
    currency: "EUR",
    total_price: "80.00",
    financial_status: "paid",
    fulfillment_status: null,
    customer: { first_name: "Test", last_name: "Buyer", email: "buyer@example.com", phone: "+34 600 000 000" },
    shipping_address: {
      name: "Recipient", phone: "+34 600 111 111",
      address1: "Carrer Test 1", address2: "", city: "Girona",
      zip: "17001", province: "Girona", country: "Spain", country_code: "ES",
      latitude: 41.9861, longitude: 2.8250,
    },
    line_items: [
      { title: "Test Bouquet", variant_title: "Standard", sku: "FC-TEST-STD", product_id: 1, quantity: 1, price: "80.00", properties: [] },
    ],
    note_attributes: [
      { name: "delivery_date_iso", value: "2026-08-02" },
      { name: "delivery_window", value: "10:00-14:00" },
    ],
    tags: "birthday, girona",
    locale: "es",
    ...over,
  };
}

/** Mirrors orderWorkflow.ts's "upsert-order" step exactly (same functions, same
 *  order), minus the WorkflowEntrypoint/step.do scaffolding — see the file
 *  header for why the real Workflow isn't booted here. Returns what that step
 *  returns: the row id and the best-effort city id. */
async function intake(sb: ReturnType<typeof createFakeDb>, raw: unknown) {
  const parsed = parseShopifyOrder(raw);
  const cityId = await findCityIdForOrder(sb as never, parsed.order);
  const orderId = await upsertOrder(sb as never, { ...parsed.order, city_id: cityId });
  await replaceLineItems(sb as never, orderId, parsed.items);
  await appendOrderEvent(sb as never, orderId, "received");
  return { orderId, cityId, parsed };
}

/** Mirrors orderWorkflow.ts's "load-working-set" step: re-read worklist_at off
 *  the row we just upserted (a brand-new order can't have been hand-picked
 *  before we ingested it) and decide against the current gate config. */
async function passesWorkingSetGate(sb: ReturnType<typeof createFakeDb>, orderId: string, tags: string | null): Promise<boolean> {
  const [cfg, row] = await Promise.all([
    workingSetConfig(sb as never),
    Promise.resolve(sb.from("orders").select("worklist_at").eq("id", orderId).maybeSingle()) as Promise<{ data: Row | null }>,
  ]);
  const wsOrder: WorkingSetOrder = { tags, worklist_at: (row.data?.worklist_at as string | null) ?? null };
  return isInWorkingSet(wsOrder, cfg);
}

function orderRow(sb: ReturnType<typeof createFakeDb>, orderId: string): Row {
  const row = sb.table("orders").find((r) => r.id === orderId);
  if (!row) throw new Error(`order ${orderId} not found in fake db`);
  return row;
}

function eventTypes(sb: ReturnType<typeof createFakeDb>, orderId: string): string[] {
  return sb
    .table("order_events")
    .filter((e) => e.order_id === orderId)
    .map((e) => e.type as string);
}

/** Advance orders.status, asserting every hop is legal on the REAL state
 *  machine (dashboard/lib/orderStatus.ts::canTransition) — a typo'd status
 *  string here fails the test instead of silently writing garbage. */
function advanceOrderStatus(sb: ReturnType<typeof createFakeDb>, orderId: string, to: OrderStatus) {
  const row = orderRow(sb, orderId);
  const from = row.status as OrderStatus;
  expect(canTransition(from, to), `orders.status ${from} -> ${to} is not on the real happy-path/escalation graph`).toBe(true);
  row.status = to;
}

describe("automatic working-set order loop (E2E harness)", () => {
  it("a freshly-imported order is NOT auto-worked until it enters the working set", async () => {
    const sb = createFakeDb({ app_settings: [APP_SETTINGS], florists: [FLORIST_IN_RANGE] });

    // Tags deliberately don't carry the active tag, and nobody has picked it —
    // this is "arrives continuously and is not automatically worked" from
    // CLAUDE.md's working-set boundary, exercised for real.
    const { orderId, parsed } = await intake(sb, rawShopifyOrder({}));

    expect(orderRow(sb, orderId).status).toBe("received");
    expect(await passesWorkingSetGate(sb, orderId, parsed.order.tags)).toBe(false);

    // The real gate having said "no", mirror what orderWorkflow.ts does next:
    // record why and stop. No match runs, no candidates are written.
    await appendOrderEvent(sb as never, orderId, "match_skipped", { reason: "not in working set", tags: parsed.order.tags });

    expect(orderRow(sb, orderId).status).toBe("received");
    expect(sb.table("order_assignments").filter((a) => a.order_id === orderId)).toHaveLength(0);
    expect(eventTypes(sb, orderId)).toEqual(["received", "match_skipped"]);
  });

  it("the full happy path: selection -> match -> accept/70% -> photo/30% -> writeback, no attention needed", async () => {
    const sb = createFakeDb({ app_settings: [APP_SETTINGS], florists: [FLORIST_IN_RANGE] });

    // --- STEP 1: intake (real parseShopifyOrder + db.ts writes) -----------
    const { orderId, parsed } = await intake(sb, rawShopifyOrder({}));
    expect(orderRow(sb, orderId).status).toBe("received");

    // Gate still says no at first (no pick, no matching tag) — same as the
    // other test, proving this order really did start outside the working set.
    expect(await passesWorkingSetGate(sb, orderId, parsed.order.tags)).toBe(false);

    // --- STEP 2: working-set selection (staff picks it) --------------------
    // This is literally what /orders' "Add orders by number" does at the data
    // layer: stamp worklist_at. Everything downstream of this line is real
    // code reacting to that stamp, not more test setup.
    await sb.from("orders").update({ worklist_at: "2026-08-01T09:05:00Z" }).eq("id", orderId);
    expect(await passesWorkingSetGate(sb, orderId, parsed.order.tags)).toBe(true);

    // --- match (real matchAndWriteCandidates: config, geography, ranking) --
    const candidateCount = await matchAndWriteCandidates(sb as never, {
      orderId,
      cityId: null,
      deliveryLat: parsed.order.delivery_lat,
      deliveryLng: parsed.order.delivery_lng,
      deliveryAt: parsed.order.delivery_at,
      orderTotal: parsed.order.total ?? 0,
      deliveryAddress: parsed.order.delivery_address,
    });

    expect(candidateCount).toBe(1);
    expect(orderRow(sb, orderId).status).toBe("matched");
    expect(eventTypes(sb, orderId)).toContain("matched");
    expect(canTransition("received", "matched")).toBe(true);

    const assignment = sb.table("order_assignments").find((a) => a.order_id === orderId)!;
    expect(assignment.florist_id).toBe("florist-in-range");
    expect(assignment.status).toBe("candidate");
    expect(assignment.rank).toBe(1);

    // insertCandidates imports computePayoutPrice from its own local
    // ./payoutMath.ts (a byte-identical copy of dashboard/lib/payoutMath.ts —
    // see that file's own byte-equality test), so this isn't asserting two
    // independently-maintained formulas happen to agree — it's asserting the
    // worker actually used the shared function, not a stale inline copy.
    const expectedPayoutPrice = computePayoutPrice(parsed.order.total ?? 0, APP_SETTINGS.default_payout_percent as number);
    expect(assignment.payout_price).toBe(expectedPayoutPrice);

    // --- STEP 3: offer wave + accept + 70% ---------------------------------
    // Simulated (see file header: waves.ts/reachoutSend.ts aren't driven) —
    // advances the SAME real order_assignments row the real cron would have.
    advanceOrderStatus(sb, orderId, "reaching_out");
    assignment.status = "sent";
    assignment.offer_expires_at = "2026-08-01T12:00:00Z";

    assignment.status = "accepted";
    advanceOrderStatus(sb, orderId, "accepted");

    const split = computeSplit(assignment.payout_price as number, TIER_1_SPLIT);
    const acceptHold = payoutHoldReason({ leg: "accept", tierHold: TIER_1_SPLIT.hold_payout });
    expect(acceptHold).toBeNull(); // real decision: an untrusted-tier hold would have been reported here

    await sb.from("payouts").insert({ assignment_id: assignment.id, leg: "accept", amount: split.accept, currency: "EUR", status: "issued" });
    await appendOrderEvent(sb as never, orderId, "payout_issued", { leg: "accept", amount: split.accept });

    // --- writeback: "in production" (simulated Shopify PUT, real tag-union) -
    const shopifyRemote = { tags: parsed.order.tags ?? "" };
    shopifyRemote.tags = unionTags(shopifyRemote.tags, "facundo");
    await appendOrderEvent(sb as never, orderId, "shopify_writeback", { state: "in_production", ok: true });
    advanceOrderStatus(sb, orderId, "in_production");

    // --- STEP 4: fulfilment progress + photo/30% ----------------------------
    advanceOrderStatus(sb, orderId, "ready");
    advanceOrderStatus(sb, orderId, "out_for_delivery");

    // A real photo-verify call would run combineVerdicts() over N provider
    // results (see file header for why that fold isn't driven here). Whatever
    // verdict it produced wouldn't matter to the hold decision any more — see
    // file header, 2026-08-20 — so payoutHoldReason no longer takes one.
    assignment.status = "delivered";
    advanceOrderStatus(sb, orderId, "delivered");

    const deliveryHold = payoutHoldReason({ leg: "delivery", tierHold: TIER_1_SPLIT.hold_payout });
    expect(deliveryHold).toBeNull(); // real decision: this tier -> release, never held

    await sb.from("payouts").insert({ assignment_id: assignment.id, leg: "delivery", amount: split.delivery, currency: "EUR", status: "issued" });
    await appendOrderEvent(sb as never, orderId, "payout_issued", { leg: "delivery", amount: split.delivery });

    // --- STEP 5: writeback "delivered" + settle -----------------------------
    shopifyRemote.tags = unionTags(shopifyRemote.tags, "facundo"); // idempotent — already unioned above
    await appendOrderEvent(sb as never, orderId, "shopify_writeback", { state: "delivered", ok: true });
    advanceOrderStatus(sb, orderId, "paid");
    advanceOrderStatus(sb, orderId, "closed");

    // --- assert the happy path really needed no human attention -------------
    expect(orderRow(sb, orderId).status).toBe("closed");
    const payouts = sb.table("payouts").filter((p) => p.assignment_id === assignment.id);
    expect(payouts).toHaveLength(2);
    expect(payouts.every((p) => p.status === "issued")).toBe(true); // none held, none failed
    expect(payouts.reduce((s, p) => s + (p.amount as number), 0)).toBeCloseTo(assignment.payout_price as number, 2);
    expect(eventTypes(sb, orderId)).not.toContain("escalated");
    expect(shopifyRemote.tags).toContain("facundo");
  });

  it("negative case: no florist in range escalates to central attention, pays nobody", async () => {
    // Same active-tag gate as the happy path, but this order carries the tag
    // from the start — isolating "nobody was in range" from "not in the
    // working set", which the first test already covers on its own.
    const sb = createFakeDb({ app_settings: [APP_SETTINGS], florists: [FLORIST_IN_RANGE] });

    const raw = rawShopifyOrder({
      id: 9000001,
      name: "#9001",
      tags: "fc-active",
      shipping_address: {
        name: "Recipient", phone: "+34 600 222 222",
        address1: "Rue Isolee 5", address2: "", city: "Nowhereville",
        zip: "00000", province: "", country: "Farland", country_code: "XX",
        latitude: 10.0, longitude: 10.0, // thousands of km from FLORIST_IN_RANGE
      },
    });
    const { orderId, parsed } = await intake(sb, raw);
    expect(await passesWorkingSetGate(sb, orderId, parsed.order.tags)).toBe(true);

    const candidateCount = await matchAndWriteCandidates(sb as never, {
      orderId,
      cityId: null,
      deliveryLat: parsed.order.delivery_lat,
      deliveryLng: parsed.order.delivery_lng,
      deliveryAt: parsed.order.delivery_at,
      orderTotal: parsed.order.total ?? 0,
      deliveryAddress: parsed.order.delivery_address,
    });

    expect(candidateCount).toBe(0);
    expect(orderRow(sb, orderId).status).toBe("escalated");
    expect(eventTypes(sb, orderId)).toContain("awaiting_ingest");
    expect(sb.table("order_assignments").filter((a) => a.order_id === orderId)).toHaveLength(0);
    expect(sb.table("payouts")).toHaveLength(0); // nobody got paid for an order nobody could place

    // --- central attention: this really does surface to a human -----------
    // gatherAttention() itself can't be invoked here (it pulls in `@/lib/...`
    // aliased imports that neither this vitest config nor the dashboard's
    // plain `node --test` resolve — see the file header and
    // dashboard/lib/cxAttentionRules.ts's header for the full reasoning). But
    // its rule-1 classification (unplaceable/escalated vs. awaiting reach-out)
    // was extracted to that dependency-free file specifically so it could be
    // driven here for real, against the REAL escalated row the match step
    // above just produced — not a hand-typed status string.
    const finalOrder = orderRow(sb, orderId);
    const attentionReason = placementAttentionReason(finalOrder.status as string, finalOrder.delivery_at as string | null);
    expect(attentionReason).toEqual({
      category: "place",
      label: "No florist found — escalated",
      urgency: 90,
      slaAt: finalOrder.delivery_at,
    });

    // deliveryArea (real) found an area worth scraping, and — since mode is
    // "auto" and this is the FIRST time we've seen it — queueIngestForArea
    // (real) actually queued a job, exactly as matchAndWriteCandidates does
    // internally. Confirm the side effect landed, not just that the function
    // was "called".
    const area = deliveryArea(parsed.order.delivery_address, 20);
    expect(area).toEqual({ country: "XX", city: "Nowhereville", radiusKm: 20, region: null });
    const jobs = sb.table("ingest_jobs").filter((j) => j.city === "Nowhereville");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("queued");
  });
});

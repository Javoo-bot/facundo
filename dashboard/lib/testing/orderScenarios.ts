// Demo order-loop scenarios: the states a PRODUCTION order can be in that the
// order-loop UI/automation care about, as data — the Production-side sibling of
// lib/testing/scenarios.ts (which covers the Recruiting funnel).
//
// Pure and alias-free so `node --test` reaches it — dashboard/lib/testing/
// demoSandbox.ts turns one of these into rows against demo shops; this file only
// says what each state IS.
//
// WHY A FIXED SET OF PRESETS: the interesting order-loop states are a handful of
// specific combinations of (does a demo shop exist in range, was an offer sent,
// did it lapse, was it accepted, did the photo pass) — getting one wrong produces
// an order that looks right and silently exercises a different branch of
// lib/lifecycle.ts than the one you meant to demonstrate.

export type OrderScenarioId =
  | "happy_path_nearby_demo_shop"
  | "no_nearby_shop_escalates"
  | "offer_sent_not_accepted_timeout"
  | "accepted_waiting_photo"
  | "photo_passed_paid"
  | "photo_review_attention";

export interface OrderScenario {
  id: OrderScenarioId;
  label: string;
  /** What this order is, in one line, on the card. */
  blurb: string;
  /** What running the scenario should demonstrate. */
  expect: string;
  /** Does this scenario need a demo shop in range of the delivery point? False
   *  only for the escalation scenario, which is the point of that one. */
  needsDemoShop: boolean;
  /** The order_assignments.status to leave the top demo-shop candidate in.
   *  Null when there is no assignment at all (the escalation scenario). */
  assignmentStatus: "candidate" | "sent" | "accepted" | "delivered" | null;
  /** Send a REAL offer (lib/reachoutSend.ts::sendOffer) to the demo shop before
   *  seeding the rest of the state — always lands on the configured test sink,
   *  never a real address, because the demo shop's own stored email/phone IS
   *  that sink. Scenarios past "sent" all need this to have actually happened. */
  sendsRealOffer: boolean;
  /** Once sent, immediately back-date offer_expires_at into the past so the
   *  offer reads as lapsed (a live wave tick would expire it next). */
  backdateExpiry: boolean;
  /** Issue the accept-leg payout via the REAL lib/payout.ts::payoutOnAccept
   *  (ledger rail — demo shops never touch a real card, see lib/payout.ts). */
  issueAcceptPayout: boolean;
  /** Seed a delivered-photo delivery_event and issue the delivery leg via the
   *  REAL lib/payout.ts::payoutOnDelivered with this verdict. Null = skip. */
  deliveryVerdict: "pass" | "review" | null;
  /** The orders.status the scenario leaves the order in. */
  orderStatus: "matched" | "escalated" | "reaching_out" | "accepted" | "delivered" | "paid";
}

export const ORDER_SCENARIOS: OrderScenario[] = [
  {
    id: "happy_path_nearby_demo_shop",
    label: "Happy path — nearby demo shop",
    blurb: "A demo shop is in range and matched as a candidate. Nothing sent yet.",
    expect: "The order sits at `matched` with the demo shop as a fresh candidate — proof matching finds a nearby test shop, ready for staff to send/accept/deliver by hand.",
    needsDemoShop: true,
    assignmentStatus: "candidate",
    sendsRealOffer: false,
    backdateExpiry: false,
    issueAcceptPayout: false,
    deliveryVerdict: null,
    orderStatus: "matched",
  },
  {
    id: "no_nearby_shop_escalates",
    label: "No nearby shop — escalates",
    blurb: "Delivery point far from every demo shop. Matching finds nobody.",
    expect: "The order has zero candidates and status `escalated` — the same branch a real order takes when nothing matches within range.",
    needsDemoShop: false,
    assignmentStatus: null,
    sendsRealOffer: false,
    backdateExpiry: false,
    issueAcceptPayout: false,
    deliveryVerdict: null,
    orderStatus: "escalated",
  },
  {
    id: "offer_sent_not_accepted_timeout",
    label: "Offer sent, not accepted — timed out",
    blurb: "A real offer went out to the demo shop's test sink and lapsed unanswered.",
    expect: "The assignment is `sent` with offer_expires_at in the past — exactly what lib/waves.ts's expiry step looks for on its next tick.",
    needsDemoShop: true,
    assignmentStatus: "sent",
    sendsRealOffer: true,
    backdateExpiry: true,
    issueAcceptPayout: false,
    deliveryVerdict: null,
    orderStatus: "reaching_out",
  },
  {
    id: "accepted_waiting_photo",
    label: "Accepted, waiting on photo",
    blurb: "The demo shop accepted; the accept-leg payout issued on the ledger rail.",
    expect: "The assignment is `accepted` and a `payouts` row exists for the accept leg (status issued/held per the demo shop's tier) — no delivery photo yet.",
    needsDemoShop: true,
    assignmentStatus: "accepted",
    sendsRealOffer: true,
    backdateExpiry: false,
    issueAcceptPayout: true,
    deliveryVerdict: null,
    orderStatus: "accepted",
  },
  {
    id: "photo_passed_paid",
    label: "Photo passed — paid",
    blurb: "A delivered photo came back with a passing AI verdict; both legs paid.",
    expect: "Both payout legs are issued (ledger rail) and the order reads `paid` — the full happy path, end to end, against a shop we own.",
    needsDemoShop: true,
    assignmentStatus: "delivered",
    sendsRealOffer: true,
    backdateExpiry: false,
    issueAcceptPayout: true,
    deliveryVerdict: "pass",
    orderStatus: "paid",
  },
  {
    id: "photo_review_attention",
    label: "Photo flagged — paid anyway (hold disabled)",
    // Kept distinct from photo_passed_paid (both `deliveryVerdict` and
    // `orderStatus`, see the class comment above) even though — as of
    // 2026-08-20, see lib/payoutHold.ts's header comment — a `review` verdict
    // no longer holds the delivery leg: this scenario still seeds a `review`
    // photo_verifications row via the REAL payoutOnDelivered call, it just no
    // longer produces a `held` payout. It's kept (rather than deleted) because
    // it's still the only preset that exercises the AI check's non-`pass`
    // path end to end; `orderStatus` stays `delivered` (not `paid`, which
    // would collide with photo_passed_paid) purely as a distinguishing label
    // for demoQaCheck.ts, not because the leg is actually held.
    blurb: "The delivered photo comes back flagged (`review`), but the payout hold on that verdict is currently disabled — the delivery leg pays out anyway.",
    expect: "The photo_verifications row records `review`, but — because photo-verdict holding is disabled — BOTH payout legs are issued (ledger rail), same as the happy path. Nothing shows up in dashboard/lib/cxAttention.ts's held-payout queue for this leg.",
    needsDemoShop: true,
    assignmentStatus: "delivered",
    sendsRealOffer: true,
    backdateExpiry: false,
    issueAcceptPayout: true,
    deliveryVerdict: "review",
    orderStatus: "delivered",
  },
];

export function orderScenarioById(id: string): OrderScenario | undefined {
  return ORDER_SCENARIOS.find((s) => s.id === id);
}

export function isOrderScenarioId(x: unknown): x is OrderScenarioId {
  return typeof x === "string" && ORDER_SCENARIOS.some((s) => s.id === x);
}

/** A delivery point guaranteed to be outside every demo shop's range, whatever
 *  demo shops happen to exist: the middle of the Gulf of Guinea, thousands of
 *  km from any city this system ingests. Used only by no_nearby_shop_escalates —
 *  never a real delivery address. */
export const UNREACHABLE_DELIVERY_POINT = { lat: 0, lng: 0 } as const;

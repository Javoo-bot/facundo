// What the support agent is allowed to know about one florist's one order.
//
// This is the support-side equivalent of lib/cxAgent.ts::APPROVED_FACTS, with
// one difference that is the whole point: those facts are a constant, and these
// are computed per conversation from live rows. The model is handed a finite
// list of sentences and told it may state nothing else. Every figure in those
// sentences is also returned in `allowedAmounts`, and
// lib/cxAgentGuard.ts::moneyClaimOutsideFacts refuses any money the reply
// states that is not in that set.
//
// So the guarantee is not "the model is careful with numbers". It is: a number
// can only leave this system if this file read it out of the database first.
//
// WHAT IS DELIBERATELY NOT IN HERE:
//   - The order total, or anything about what the customer paid. The florist's
//     payout is their business; our margin is not, and the fastest way to lose
//     a florist is to let them compute it.
//   - The customer's name, email or phone. A support answer never needs it, and
//     it would be sitting in a prompt to a third-party model.
//   - Any other florist's data. The loader is scoped by assignment, so the
//     shape of the query is the guarantee.
//
// The shaping is pure so it can be unit-tested against fixture rows; the single
// query it needs is at the bottom. Alias-free so plain `node --test` reaches it.

export type PayoutLeg = "accept" | "delivery";

export interface PayoutRow {
  leg: PayoutLeg | string;
  amount: number | string | null;
  currency: string | null;
  status: string | null;
  updated_at?: string | null;
}

export interface OrderRow {
  order_name: string | null;
  delivery_at: string | null;
  delivery_window: string | null;
  status: string | null;
  /** Who and where. PII: only ever put in front of the florist who ACCEPTED
   * this order — the same rule the order page enforces server-side, where
   * address and recipient are nulled until accept
   * (app/florist/(app)/orders/[id]/page.tsx). */
  recipient_name: string | null;
  recipient_phone: string | null;
  delivery_address: unknown;
}

export interface AssignmentRow {
  status: string | null;
  accepted_at: string | null;
  delivered_at: string | null;
}

export interface FactsInput {
  order: OrderRow | null;
  assignment: AssignmentRow | null;
  payouts: PayoutRow[];
  /** Latest AI photo check for this assignment, if one has run. */
  photoVerdict: "pass" | "review" | "fail" | null;
  /** Whether the florist already has a problem open on this order. If they do,
   * a human is already involved and the agent should not talk over them. */
  openIssues: number;
  /** This florist's tier pays the WHOLE payout on accept (a 0% delivery leg —
   * lib/payoutMath.ts::isSinglePayment). Changes what is TRUE here, not just
   * how it is worded: there is one leg rather than two, no second payment is
   * ever coming, and the delivery photo releases nothing. Left false and the
   * agent would tell a paid-in-full florist their 30% is still on the way, which is
   * both wrong and exactly the sort of confident-sounding money claim the
   * guard cannot catch (30% is an always-allowed percentage). */
  singlePayment: boolean;
}

export interface SupportFacts {
  /** Rendered into the prompt verbatim, one per line. */
  lines: string[];
  /** Every figure the lines contain, for the guard's allow-list. */
  allowedAmounts: number[];
  /** True when there is nothing solid to answer from — no order, no payouts.
   * The caller escalates rather than letting a model improvise from an empty
   * fact list, which is the one input that reliably produces confident
   * nonsense. */
  empty: boolean;
  /** Mirrors `input.openIssues > 0`. A deterministic signal for the caller to
   * bail on before drafting at all, alongside the "hand the conversation
   * over" line already folded into `lines` for when a draft is attempted
   * anyway (see lib/cxAgentGuard.ts's GuardContext.openIssue, which the
   * caller should also set as a backstop). */
  hasOpenIssue: boolean;
}

/** One line of address out of the stored JSON, tolerating the key variants the
 * two ingest paths produce (address1/line1/street, zip/postal/postal_code).
 * Mirrors components/florist/FloristOrderDetail.tsx::formatAddress — the
 * florist should hear the same address the page shows them. */
function formatAddress(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const line1 = str(o.address1) ?? str(o.line1) ?? str(o.street);
  const cityZip = [str(o.zip) ?? str(o.postal_code) ?? str(o.postal), str(o.city)].filter(Boolean).join(" ");
  const parts = [line1, str(o.line2), cityZip || null, str(o.country_code) ?? str(o.country)].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/** Money for a prompt: two decimals, dot separator, no symbol. The model writes
 * the amount in the florist's own convention; the guard compares by value, so
 * the two never have to agree on spelling. */
function money(amount: number, currency: string | null): string {
  return `${amount.toFixed(2)} ${(currency ?? "EUR").toUpperCase()}`;
}

function num(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(n) ? n : null;
}

/** A date the model can restate without us having to parse its output back.
 * ISO, because it is unambiguous in every market — the model renders it into
 * the florist's language. */
function day(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Plain English for a payout leg's state, and why, when the answer is "not
 * yet". Every branch says what happens NEXT, because "held" on its own is the
 * thing that makes a florist write in again. */
function payoutLine(p: PayoutRow, singlePayment = false): string | null {
  const amount = num(p.amount);
  if (amount === null) return null;
  // On a single-payment tier the accept leg IS the whole payout, so calling it
  // "the 70% payment" would invite the obvious follow-up about the other 30%,
  // which does not exist. (A delivery row cannot occur on that tier — the leg
  // is never created — but the label stays correct if one ever did.)
  const which = p.leg === "accept"
    ? (singlePayment ? "full payment, due on acceptance" : "70% payment, due on acceptance")
    : "30% payment, due on the delivery photo";
  const sum = money(amount, p.currency);

  switch (p.status) {
    case "paid":
    case "issued":
      return `The ${which} is ${sum}, and it has been sent to the florist's card.`;
    case "held":
      // Not attributed to the photo verdict any more: as of 2026-08-20 a
      // `review`/`fail` AI verdict does not hold the delivery leg (see
      // lib/payoutHold.ts's header comment), so a "held" row's actual reason
      // is now independent of `photoVerdict` — naming the photo here would
      // often be wrong (e.g. a tier-hold or the operator's delivery-gate
      // switch). The photo check still runs and is described separately,
      // below, purely as "did we get one / did it pass" — never as the reason
      // for a hold.
      return `The ${which} is ${sum}. It is waiting on a check by a colleague. Nothing is needed from the florist.`;
    case "pending":
      return p.leg === "delivery"
        ? `The ${which} is ${sum}. It has not been sent yet because we have not had the delivery photo.`
        : `The ${which} is ${sum}. It has not been sent yet.`;
    case "failed":
      return `The ${which} is ${sum}, and the payment did not go through. A colleague is dealing with it.`;
    case "clawed_back":
      return `The ${which} of ${sum} was reversed.`;
    default:
      return `The ${which} is ${sum}.`;
  }
}

/**
 * Build the fact list for one conversation. Pure.
 *
 * A null field never becomes a sentence. Saying nothing about the delivery date
 * is honest; "your delivery is due on null" is not, and neither is quietly
 * substituting today.
 */
export function buildSupportFacts(input: FactsInput): SupportFacts {
  const lines: string[] = [];
  const amounts: number[] = [];

  const orderName = input.order?.order_name;
  if (orderName) lines.push(`This conversation is about order ${orderName}.`);

  const due = day(input.order?.delivery_at);
  if (due) {
    const window = input.order?.delivery_window;
    lines.push(
      window
        ? `The order is due to be delivered on ${due}, in the window ${window}.`
        : `The order is due to be delivered on ${due}.`
    );
  }

  const accepted = day(input.assignment?.accepted_at);
  if (accepted) lines.push(`The florist accepted this order on ${accepted}.`);

  // Who and where, for the florist who has accepted and is about to deliver.
  //
  // Added after a florist asked "what's the phone number of the recipient?" and
  // was escalated to a human for it. We hold that number, and the order page
  // already shows them the recipient's name and full address once they accept —
  // so escalating was not caution, it was the fact list being narrower than the
  // screen the question was asked from.
  //
  // Gated on `accepted` regardless: same rule as the page, so a pre-accept
  // thread can never read out a customer's details.
  if (accepted) {
    const address = formatAddress(input.order?.delivery_address);
    if (address) lines.push(`The delivery address is ${address}.`);
    const recipient = input.order?.recipient_name?.trim();
    if (recipient) lines.push(`The recipient is ${recipient}.`);
    const phone = input.order?.recipient_phone?.trim();
    if (phone) {
      lines.push(`The recipient's phone number is ${phone}.`);
    } else if (recipient || address) {
      // Say so explicitly. Silence here reads to the model as "don't mention
      // it", and the florist gets an answer about everything except the thing
      // they asked.
      lines.push("We have no phone number for the recipient on this order.");
    }
  }

  const delivered = day(input.assignment?.delivered_at);
  if (delivered) {
    lines.push(`The florist marked this order delivered on ${delivered}.`);
  } else if (accepted) {
    lines.push("The order has not been marked delivered yet.");
  }

  for (const leg of ["accept", "delivery"] as const) {
    const p = input.payouts.find((x) => x.leg === leg);
    if (!p) continue;
    const line = payoutLine(p, input.singlePayment);
    if (!line) continue;
    lines.push(line);
    const amount = num(p.amount);
    if (amount !== null) amounts.push(amount);
  }

  const hasDeliveryPayout = input.payouts.some((p) => p.leg === "delivery");

  // The 30% BEFORE it exists as a row, which is most of the time a florist asks
  // about it: the delivery leg is only created later in the flow, so between
  // accepting and the photo being approved there was no payout row, no fact,
  // and therefore nothing the agent could say.
  //
  // That silence was expensive. Asked "when will I get paid in full", the model
  // answered the rest of the message correctly and then flagged the whole turn
  // as beyond it — so a good reply, phone number and all, became a draft nobody
  // sent. The rule is knowable without a row, and stating it is not a promise
  // about timing: it is how the split works.
  //
  // No amount, because we genuinely do not have one yet. "30%" is safe to write
  // (cxAgentGuard's ALLOWED_PERCENTAGES); a figure would not be.
  if (accepted && !hasDeliveryPayout) {
    // ...unless this florist is on a single-payment tier, where there IS no
    // remaining 30%. Saying so plainly matters more than staying quiet: "when
    // will I be paid in full" is the same question either way, and the honest
    // answer here is "you already were". The photo sentence is kept and
    // re-pointed, because the risk that replaces it is a florist concluding the
    // photo is optional now that no money hangs on it.
    lines.push(
      input.singlePayment
        ? "This florist is paid the full amount on acceptance, in a single payment. There is no second payment and no remaining percentage; nothing further is owed for this order. The delivery photo is still required as proof that the delivery happened, and it releases no money."
        : "The remaining 30% has not been scheduled yet. It is released once the florist's delivery photo has been received and approved, which happens before the delivery itself."
    );
  }

  // The photo, which is the single most common thing a florist is waiting on.
  // NOT gated on the delivery payout row any more, for the same reason: the row
  // arrives after the photo, so requiring it hid the instruction from exactly
  // the florists who still had to act on it.
  if (input.photoVerdict === null && accepted && !delivered) {
    lines.push("We have not received a delivery photo for this order yet.");
    lines.push(
      "The next step for the florist is to open the order in the Facundo app and upload one clear photo of the finished bouquet."
    );
  } else if (input.photoVerdict === "pass") {
    lines.push("The delivery photo was received and passed our check.");
  }

  if (input.openIssues > 0) {
    // Said out loud so the agent does not offer to chase something a colleague
    // is already holding. The prompt turns this into a handover.
    lines.push(
      "A problem has already been reported on this order and a colleague is working on it. Do not answer about the problem; hand the conversation over."
    );
  }

  return {
    lines,
    allowedAmounts: amounts,
    // An order name alone is not enough to answer from. Requiring a second fact
    // means "we found the order row and nothing else" escalates rather than
    // producing a confident sentence about an order we know nothing about.
    empty: lines.length < 2,
    hasOpenIssue: input.openIssues > 0,
  };
}

// ---------------------------------------------------------------------- IO --

/** The service-role client, structurally.
 *
 * Typed loosely on purpose. This module is alias-free so plain `node --test`
 * can reach the pure functions above, which rules out importing the real
 * SupabaseClient type — that import would drag the client into the test
 * process. Modelling PostgREST's builder by hand was worse: it does not type
 * check against the real thing, and a hand-written approximation that disagrees
 * with reality is a liability rather than a safety net. The call sites below
 * are three fixed queries, and the compiler still checks the SHAPES they
 * return via the row interfaces. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Queryable = { from: (table: string) => any };

/**
 * Load the rows for one assignment and shape them.
 *
 * Scoped by assignment id throughout — there is no query here that could return
 * another florist's row even if the caller passed the wrong id, because every
 * table is reached THROUGH the assignment rather than by florist.
 */
export async function loadSupportFacts(
  admin: Queryable,
  assignmentId: string,
  orderId: string | null
): Promise<SupportFacts> {
  const [assignmentRes, payoutsRes, photoRes, issuesRes] = await Promise.all([
    admin.from("order_assignments").select("status, accepted_at, delivered_at, florist_id").eq("id", assignmentId).maybeSingle(),
    admin.from("payouts").select("leg, amount, currency, status, updated_at").eq("assignment_id", assignmentId),
    admin
      .from("photo_verifications")
      .select("verdict, created_at")
      .eq("assignment_id", assignmentId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin.from("order_issues").select("id").eq("assignment_id", assignmentId).eq("status", "open"),
  ]);

  const orderRes = orderId
    ? await admin
        .from("orders")
        .select("order_name, delivery_at, delivery_window, status, recipient_name, recipient_phone, delivery_address")
        .eq("id", orderId)
        .maybeSingle()
    : { data: null };

  // How this florist gets paid, read from their tier row rather than a tier
  // code (lib/payoutMath.ts::isSinglePayment). Two extra reads, and they have to
  // be sequential because the tier code comes off the florist. Fails toward the
  // SPLIT wording on any gap — an unassigned tier, a missing row — which keeps
  // the agent describing the deal almost every florist is actually on.
  let singlePayment = false;
  const floristId = (assignmentRes.data as { florist_id?: string } | null)?.florist_id ?? null;
  if (floristId) {
    const floristRes = await admin.from("florists").select("trust_tier").eq("id", floristId).maybeSingle();
    const tierCode = (floristRes.data as { trust_tier?: string | null } | null)?.trust_tier ?? null;
    if (tierCode) {
      const tierRes = await admin.from("trust_tiers").select("split_on_delivery").eq("code", tierCode).maybeSingle();
      const split = (tierRes.data as { split_on_delivery?: number | null } | null)?.split_on_delivery;
      singlePayment = split != null && Number(split) === 0;
    }
  }

  return buildSupportFacts({
    order: (orderRes.data as OrderRow) ?? null,
    assignment: (assignmentRes.data as AssignmentRow) ?? null,
    payouts: ((payoutsRes.data as PayoutRow[]) ?? []),
    photoVerdict: ((photoRes.data as { verdict?: string } | null)?.verdict as FactsInput["photoVerdict"]) ?? null,
    openIssues: ((issuesRes.data as unknown[]) ?? []).length,
    singlePayment,
  });
}

// Pure normalization + drift detection for a live Airwallex card read.
//
// WHY THIS EXISTS. `payouts.spent_amount` / `last_txn_id` / `card_status` are
// written in exactly ONE place — webhookMap.ts, driven by the Airwallex
// webhook. Nothing polls or reconciles. So when a webhook is not delivered, the
// row silently keeps the state it had at issue time forever, and /payments/[id]
// renders that stale state with total confidence. On 2026-08-11 all three
// payouts checked by hand were stale, including one card that had been fully
// drawn down and still displayed "Spent —".
//
// This module compares what Airwallex says against what we stored, so a human
// looking at a payment sees the disagreement instead of the lie. It writes
// nothing; the caller only displays the result.
//
// Two normalizations are load-bearing, because the two sides do NOT speak the
// same language:
//
//   1. SIGN. Airwallex reports card spend as a NEGATIVE billing_amount
//      (-31.50 for a EUR 31.50 purchase). Summing raw values and showing that
//      to a human reads as a refund. Everything here is normalized to a
//      positive magnitude. (Note that webhookMap stores the raw negative value,
//      so a *working* webhook would also have stored spent_amount = -31.50 —
//      hence the abs() when comparing against stored.)
//   2. VOCABULARY. Our webhook writes card_status "USED"; Airwallex's card
//      object returns "ACTIVE" / "CLOSED". Diffing those strings directly
//      would report drift on every settled payout. Both sides are collapsed to
//      OPEN / CLOSED / UNKNOWN before comparing.

/** Stored payout columns, as the page already has them. */
export interface StoredPayout {
  status: string | null;
  card_status: string | null;
  spent_amount: number | null;
  last_txn_id: string | null;
}

/** Raw Airwallex payloads, exactly as the three endpoints return them. */
export interface LiveInput {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Airwallex JSON is untyped
  card: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Airwallex JSON is untyped
  authorizations: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Airwallex JSON is untyped
  transactions: any[];
}

export interface TxnRow {
  id: string | null;
  type: string | null;
  status: string | null;
  amount: number | null;
  currency: string | null;
  merchant: string | null;
  authCode: string | null;
  postedAt: string | null;
}

export interface AuthRow {
  id: string | null;
  status: string | null;
  amount: number | null;
  currency: string | null;
  merchant: string | null;
  authCode: string | null;
  createdAt: string | null;
}

export interface DriftEntry {
  field: string;
  stored: string;
  live: string;
  /** Plain-language consequence, shown to the human reading the payment. */
  note: string;
}

export interface LiveSummary {
  cardStatus: string | null;
  currency: string | null;
  /** Net cleared spend, positive. null when there are no clearing rows. */
  clearedTotal: number | null;
  /** Authorizations holding funds but not yet cleared, positive. */
  pendingTotal: number | null;
  spent: boolean;
  transactions: TxnRow[];
  authorizations: AuthRow[];
  drift: DriftEntry[];
}

const DEAD_AUTH = new Set(["CLEARED", "DECLINED", "EXPIRED", "REVERSED", "CANCELLED"]);

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Airwallex sends spend as negative; callers want a positive magnitude. */
function magnitude(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.abs(n);
}

/**
 * Float noise guard — money compared and summed at 2dp. The `+ 0` collapses
 * -0, which the sign flip produces whenever a total nets to exactly zero (a
 * fully reversed card) and which would otherwise render as "-0.00".
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100 + 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Airwallex JSON is untyped
function merchantName(x: any): string | null {
  const n = x?.merchant?.name;
  return typeof n === "string" && n.trim() ? n.trim() : null;
}

/** Collapse either side's card vocabulary to a comparable state. */
function closedness(v: string | null | undefined): "OPEN" | "CLOSED" | "UNKNOWN" {
  const s = String(v ?? "").toUpperCase();
  if (!s) return "UNKNOWN";
  if (s === "ACTIVE") return "OPEN";
  if (s === "CLOSED" || s === "INACTIVE" || s === "USED") return "CLOSED";
  return "UNKNOWN";
}

function money(n: number | null, ccy: string | null): string {
  if (n === null) return "—";
  return ccy ? `${n.toFixed(2)} ${ccy}` : n.toFixed(2);
}

export function summarizeLive(live: LiveInput, stored: StoredPayout): LiveSummary {
  const txns = Array.isArray(live.transactions) ? live.transactions : [];
  const auths = Array.isArray(live.authorizations) ? live.authorizations : [];

  const currency =
    txns.find((t) => t?.billing_currency)?.billing_currency ??
    auths.find((a) => a?.billing_currency)?.billing_currency ??
    null;

  // Clearing rows carry the real money movement. A reversal arrives as its own
  // row with the opposite sign, so summing signed values and flipping at the
  // end nets refunds out correctly. DECLINED rows never moved money.
  const clearing = txns.filter(
    (t) => String(t?.transaction_type ?? "").toUpperCase() === "CLEARING" && String(t?.status ?? "").toUpperCase() !== "DECLINED",
  );
  const clearedTotal = clearing.length
    ? round2(-clearing.reduce((s, t) => s + (num(t?.billing_amount) ?? 0), 0))
    : null;

  // Only authorizations still holding funds — a CLEARED one already appears
  // above as a transaction, and counting both would double the total.
  const openAuths = auths.filter((a) => !DEAD_AUTH.has(String(a?.status ?? "").toUpperCase()));
  const pendingTotal = openAuths.length
    ? round2(-openAuths.reduce((s, a) => s + (num(a?.billing_amount) ?? 0), 0))
    : null;

  const transactions: TxnRow[] = txns.map((t) => ({
    id: t?.transaction_id ?? null,
    type: t?.transaction_type ?? null,
    status: t?.status ?? null,
    amount: magnitude(t?.billing_amount),
    currency: t?.billing_currency ?? null,
    merchant: merchantName(t),
    authCode: t?.auth_code ?? null,
    postedAt: t?.posted_date ?? t?.transaction_date ?? null,
  }));

  const authorizations: AuthRow[] = auths.map((a) => ({
    id: a?.transaction_id ?? null,
    status: a?.status ?? null,
    amount: magnitude(a?.billing_amount),
    currency: a?.billing_currency ?? null,
    merchant: merchantName(a),
    authCode: a?.auth_code ?? null,
    createdAt: a?.create_time ?? null,
  }));

  const cardStatus: string | null = live.card?.card_status ?? null;
  const spent = (clearedTotal ?? 0) > 0 || openAuths.length > 0;

  // ---- drift -------------------------------------------------------------
  const drift: DriftEntry[] = [];

  // The headline: does the stored row know money moved at all?
  const storedSpent = stored.spent_amount !== null || stored.status === "paid";
  if (spent !== storedSpent) {
    drift.push({
      field: "spend",
      stored: storedSpent ? "spent" : "not spent",
      live: spent ? `spent ${money(clearedTotal ?? pendingTotal, currency)}` : "not spent",
      note: spent
        ? "This card HAS been used, but the stored record doesn't know. The payment page is showing the wrong thing."
        : "The stored record claims spend that Airwallex has no record of.",
    });
  } else if (spent && clearedTotal !== null) {
    // Both agree money moved — check they agree on how much.
    const storedAbs = stored.spent_amount === null ? null : Math.abs(stored.spent_amount);
    if (storedAbs !== null && Math.abs(storedAbs - clearedTotal) > 0.01) {
      drift.push({
        field: "spent_amount",
        stored: money(storedAbs, currency),
        live: money(clearedTotal, currency),
        note: "Stored spend disagrees with the cleared total at Airwallex.",
      });
    }
  }

  const latestCleared = clearing.length ? clearing[clearing.length - 1]?.transaction_id ?? null : null;
  if (latestCleared && stored.last_txn_id !== latestCleared) {
    drift.push({
      field: "last_txn_id",
      stored: stored.last_txn_id ?? "—",
      live: latestCleared,
      note: "The settled transaction was never recorded against this payout.",
    });
  }

  const liveClosed = closedness(cardStatus);
  const storedClosed = closedness(stored.card_status);
  if (liveClosed !== "UNKNOWN" && liveClosed !== storedClosed) {
    drift.push({
      field: "card_status",
      stored: stored.card_status ?? "—",
      live: cardStatus ?? "—",
      note:
        storedClosed === "UNKNOWN"
          ? "Card state was never recorded — the webhook that writes it hasn't landed."
          : "Stored card state disagrees with Airwallex.",
    });
  }

  return { cardStatus, currency, clearedTotal, pendingTotal, spent, transactions, authorizations, drift };
}

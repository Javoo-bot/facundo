// Airwallex Issuing — card operations. Composes the low-level client + the pure
// controls builder. Issues single-use payout cards, reads status, retrieves
// sensitive details (PAN/CVV) for the owning florist, and closes a card on
// clawback.
//
// Cards are issued directly to Facundo — issue_to: "ORGANISATION", no
// cardholder_id (Airwallex rejects a cardholder_id when issue_to is
// ORGANISATION: "cardholder_id must be null when issue_to is set to
// ORGANISATION"). This is deliberate, confirmed against this account: an
// earlier version issued to a DELEGATE cardholder representing a named
// individual (issue_to: "INDIVIDUAL"), which (a) required a full
// individual.* KYC block on that person just to create the cardholder, and
// (b) put that person's name on the card and gated getSensitiveCardDetails
// behind PCI compliance. Non-personalized ORGANISATION cards need neither —
// matches Airwallex's "Choose your issuing solution" doc, "Pay for business
// expenses" row: business name on the card, direct sensitive-details
// retrieval with no PCI requirement.
//
// Card env (in addition to client.ts auth env):
//   AIRWALLEX_CREATED_BY       (name recorded on the card; default "Facundo")
//   AIRWALLEX_PROGRAM_PURPOSE  (default "COMMERCIAL")   AIRWALLEX_PROGRAM_TYPE (optional)
//   AIRWALLEX_ALLOWED_MCC      (optional comma/space list of allowed MCCs)

import { awxGet, awxPost } from "./client";
import { buildAuthorizationControls, centsToMajor, parseMccAllowlist } from "./controls";

export type IssueResult =
  | { ok: true; providerRef: string; last4?: string; expiry?: string }
  | { ok: false; error: string };

export interface SensitiveCardDetails {
  card_number: string;
  cvv: string;
  expiry_month: number | string;
  expiry_year: number | string;
  name_on_card?: string;
}

// Single-use virtual card funded from the FLQ wallet, spend limit = the payout,
// optionally scoped to an MCC allow-list. Returns a normalized ok/error union
// so the payout path never throws.
export async function issueSingleUseCard(amountCents: number, currency: string, ref: string): Promise<IssueResult> {
  try {
    const program: Record<string, string> = { purpose: process.env.AIRWALLEX_PROGRAM_PURPOSE || "COMMERCIAL" };
    if (process.env.AIRWALLEX_PROGRAM_TYPE) program.type = process.env.AIRWALLEX_PROGRAM_TYPE;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Airwallex JSON is untyped
    const c = await awxPost<any>("/api/v1/issuing/cards/create", {
      request_id: ref,
      created_by: process.env.AIRWALLEX_CREATED_BY || "Facundo",
      issue_to: "ORGANISATION", // card belongs to Facundo, not a named individual — no cardholder_id
      is_personalized: false,
      form_factor: "VIRTUAL",
      program,
      authorization_controls: buildAuthorizationControls({
        amountCents,
        currency,
        mccAllowlist: parseMccAllowlist(process.env.AIRWALLEX_ALLOWED_MCC),
      }),
    });
    // The create response returns card_id + a MASKED card_number only; full
    // PAN/CVV require getSensitiveCardDetails (never persisted).
    const digits = typeof c.card_number === "string" ? c.card_number.replace(/\D/g, "") : "";
    return {
      ok: true,
      providerRef: c.card_id ?? ref,
      last4: digits ? digits.slice(-4) : undefined,
      expiry: c.expiry_month ? `${c.expiry_month}/${c.expiry_year}` : undefined,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "airwallex error" };
  }
}

// Card status + metadata (not sensitive). Used by the webhook/reconcile paths.
export interface CardStatus {
  card_id: string;
  card_status?: string;
  expiry_month?: number;
  expiry_year?: number;
}
export function getCard(cardId: string): Promise<CardStatus> {
  return awxGet<CardStatus>(`/api/v1/issuing/cards/${encodeURIComponent(cardId)}`);
}

// Live spend reads for a card — what Airwallex itself believes happened, as
// opposed to what our webhook managed to record. Both are used by the staff
// "query live" panel on /payments/[id]; neither returns sensitive card data.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Airwallex JSON is untyped
export function getCardAuthorizations(cardId: string): Promise<{ items?: any[] }> {
  return awxGet(`/api/v1/issuing/authorizations?card_id=${encodeURIComponent(cardId)}`);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Airwallex JSON is untyped
export function getCardTransactions(cardId: string): Promise<{ items?: any[] }> {
  return awxGet(`/api/v1/issuing/transactions?card_id=${encodeURIComponent(cardId)}`);
}

// SENSITIVE: full PAN/CVV/expiry. Non-personalized cards (ours) return this
// directly — no PCI compliance needed (that's only for personalized cards,
// or the secure-iframes alternative). The caller (the auth-gated florist
// route) must NOT persist or log this.
export function getSensitiveCardDetails(cardId: string): Promise<SensitiveCardDetails> {
  return awxGet<SensitiveCardDetails>(`/api/v1/issuing/cards/${encodeURIComponent(cardId)}/details`);
}

// Raise (or otherwise change) a still-open single-use card's ALL_TIME spend
// limit IN PLACE — no reissue, same PAN the florist already has. Exists for
// the case where the florist's payment processor bills in a different
// currency than the card, and Airwallex's FX conversion at swipe time lands a
// little over the original EUR limit, declining every retry with
// LIMIT_EXCEEDED (confirmed against two real orders, 2026-08-30/31 — both
// fixed by hand directly in the Airwallex dashboard before this existed,
// leaving no record on our side). Only helps BEFORE the card's one allowed
// transaction succeeds — Airwallex auto-closes a SINGLE-use card on its first
// successful/pending authorization, and a raised limit can't reopen that.
//
// Reads the card first so every OTHER control (PER_TRANSACTION limit, MCC
// allow-list, the single-use flag itself) survives untouched — only the
// ALL_TIME entry is replaced.
export async function updateCardLimit(cardId: string, newAmountCents: number, currency: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Airwallex JSON is untyped
    const card = await awxGet<any>(`/api/v1/issuing/cards/${encodeURIComponent(cardId)}`);
    // The authoritative version of the "only before the one allowed
    // transaction succeeds" precondition above — checked against Airwallex
    // itself, not our `payouts.card_status` column, which has exactly one
    // writer (the webhook) and can be stale if a delivery was missed. A
    // SINGLE-use card auto-closes to something other than ACTIVE the moment
    // its one transaction succeeds or goes pending, so this alone is enough.
    if (card?.card_status !== "ACTIVE") {
      return { ok: false, error: `card is not open for adjustment (live status: ${card?.card_status ?? "unknown"})` };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Airwallex JSON is untyped
    const existing = (card?.authorization_controls ?? {}) as any;
    const existingLimits: Array<{ interval: string; amount: number }> = existing?.transaction_limits?.limits ?? [];
    const otherLimits = existingLimits.filter((l) => l.interval !== "ALL_TIME");
    await awxPost(`/api/v1/issuing/cards/${encodeURIComponent(cardId)}/update`, {
      authorization_controls: {
        allowed_transaction_count: existing.allowed_transaction_count ?? "SINGLE",
        ...(existing.allowed_merchant_categories?.length ? { allowed_merchant_categories: existing.allowed_merchant_categories } : {}),
        transaction_limits: {
          currency,
          limits: [...otherLimits, { interval: "ALL_TIME", amount: centsToMajor(newAmountCents) }],
        },
      },
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "airwallex error" };
  }
}

// Permanently close a card so it can no longer be spent — used on clawback.
// Returns ok/error so clawback stays best-effort.
export async function closeCard(cardId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await awxPost(`/api/v1/issuing/cards/${encodeURIComponent(cardId)}/update`, { card_status: "CLOSED" });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "airwallex error" };
  }
}

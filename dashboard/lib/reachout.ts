import type { OrderAssignment } from "./types";
import type { OrderStatus } from "./orderStatus";

const SENDABLE: OrderAssignment["status"][] = ["candidate", "queued"];
const LIVE: OrderAssignment["status"][] = ["sent", "opened"];

export function nextSendableCandidate(assignments: OrderAssignment[]): OrderAssignment | null {
  const sendable = assignments
    .filter((a) => SENDABLE.includes(a.status))
    .sort((x, y) => (x.rank ?? 99) - (y.rank ?? 99));
  return sendable[0] ?? null;
}

export function canSend(assignment: OrderAssignment | null, _workflowMode: string): boolean {
  if (!assignment) return false;
  return SENDABLE.includes(assignment.status);
}

export function liveOfferExists(assignments: OrderAssignment[]): boolean {
  return assignments.some((a) => LIVE.includes(a.status));
}

/** How long a florist gets to answer an offer, per delivery-urgency tier
 *  (minutes). Editable in Settings → Offers; stored as the
 *  `offer_window_*_min` columns on `app_settings` and read at send time by
 *  lib/offerVars.ts. */
export interface OfferWindows {
  rushMin: number;      // delivery <= 6h
  samedayMin: number;   // <= 24h
  standardMin: number;  // <= 72h
  farMin: number;       // beyond 72h
  noDateMin: number;    // order has no delivery_at
}

/** The ladder this module shipped with, and the defaults of the columns that
 *  replaced it (supabase/migrations/2026-08-03-late-accept-and-offer-window.sql).
 *  Kept as the fallback so a caller without settings — or a settings row
 *  predating the migration — behaves exactly as before. */
export const DEFAULT_OFFER_WINDOWS: OfferWindows = {
  rushMin: 15, samedayMin: 30, standardMin: 60, farMin: 120, noDateMin: 60,
};

// Shorter deadline ⇒ shorter suggested wait before trying the next florist.
export function suggestedTimeoutMinutes(
  deliveryAt: string | null,
  windows: OfferWindows = DEFAULT_OFFER_WINDOWS
): number {
  if (!deliveryAt) return windows.noDateMin;
  const hours = (new Date(deliveryAt).getTime() - Date.now()) / 3600e3;
  if (hours <= 6) return windows.rushMin;
  if (hours <= 24) return windows.samedayMin;
  if (hours <= 72) return windows.standardMin;
  return windows.farMin;
}

// ---------------------------------------------------------------------------
// Staff "Re-send offer" — pure state-machine predicates. Alias-free (relative
// imports only) so plain `node --test` can exercise them directly (see
// lib/reachout.test.mjs); the exact same rule is enforced server-side by the
// two-statement CAS in lib/reachoutSend.ts::sendOffer's `resend` claim (the
// SOLE authority — this predicate is advisory: a route-level pre-check and
// the client's Re-send button visibility, both of which can race and lose).
// ---------------------------------------------------------------------------

// Assignment statuses a staff resend can act on AT ALL, before the sent/opened
// expiry check below. candidate/queued are deliberately excluded — those
// already go through the plain "send" action's own CAS.
export const RESENDABLE_STATUSES: OrderAssignment["status"][] = ["declined", "expired", "sent", "opened"];

// Order statuses from which a resend is allowed — a DIFFERENT florist hasn't
// already taken or fulfilled the order. `escalated` is included deliberately:
// a live offer sitting on a stale decline/expiry while the order shows
// escalated is exactly the motivating case for this feature. See
// dashboard/app/api/orders/reachout/route.ts's escalated→reaching_out
// demotion on a successful resend (sendOffer's own orders CAS excludes
// escalated on purpose, so the route does it instead, after success).
const ORDER_RESENDABLE_STATUSES: OrderStatus[] = ["received", "matched", "reaching_out", "escalated"];

export function orderResendable(status: OrderStatus, deletedAt: string | null): boolean {
  return deletedAt == null && ORDER_RESENDABLE_STATUSES.includes(status);
}

// Discriminated reason a resend is currently blocked by assignment/order
// STATE (as opposed to email configuration, e.g. no-test-email — that's
// surfaced separately via lib/offerVars.ts's `blockingError`). Both the
// resend route's 409 messages and the preview route's `block_reason` field
// are built from this single function so the two responses can never
// disagree about why a given assignment isn't resendable right now.
export type ResendBlockReason =
  | "not-sent-yet" // candidate / queued — use the plain Send action
  | "already-accepted"
  | "assignment-closed" // reassigned / released / delivered
  | "still-live" // sent/opened, offer_expires_at in the future or NULL (fail closed)
  | "order-not-open" // order status outside {received, matched, reaching_out, escalated}
  | "order-cancelled"
  | "order-deleted";

// `withdrawn_at` is REQUIRED (not optional) on purpose: making it optional
// would let a call site silently omit it and fail open — a withdrawn offer
// would stay re-notifiable, which is exactly the bug this field exists to
// close. Required means the typechecker finds every caller.
type ResendableAssignment = {
  status: OrderAssignment["status"];
  offer_expires_at: string | null;
  withdrawn_at: string | null;
};

export function resendBlockReason(
  a: ResendableAssignment,
  orderStatus: OrderStatus,
  orderDeletedAt: string | null,
  nowMs: number = Date.now()
): ResendBlockReason | null {
  if (orderDeletedAt != null) return "order-deleted";
  if (orderStatus === "cancelled") return "order-cancelled";
  if (!ORDER_RESENDABLE_STATUSES.includes(orderStatus)) return "order-not-open";

  if (a.status === "candidate" || a.status === "queued") return "not-sent-yet";
  if (a.status === "accepted") return "already-accepted";
  if (a.status === "reassigned" || a.status === "released" || a.status === "delivered") return "assignment-closed";
  if (a.status === "sent" || a.status === "opened") {
    // A WITHDRAWN offer is never "still-live", whatever its expiry says. Staff
    // Withdraw normally drops the row to `expired`, but a re-notify with
    // `resetWindow` pushes `offer_expires_at` back into the future on a row
    // that still carries the stamp — and `lateAccept` refuses on the stamp, so
    // the florist sees an offer they cannot accept. Treating it as resendable
    // is what makes it recoverable: Re-send is the action that clears the
    // withdrawal (lib/reachoutSend.ts's claim), and it must stay reachable.
    if (a.withdrawn_at) return null;
    const lapsed = a.offer_expires_at != null && Date.parse(a.offer_expires_at) < nowMs;
    return lapsed ? null : "still-live"; // NULL expiry also falls here (fail closed)
  }
  // declined / expired — always resendable at the assignment level.
  return null;
}

/**
 * Canonical resend predicate — mirrors the CAS in
 * lib/reachoutSend.ts::sendOffer's `resend` claim exactly (see the two
 * sequential CAS UPDATEs there). Used by the route's advisory pre-check, the
 * preview route's `resendable` field, and (client-side, UX-only) the Re-send
 * button's visibility in ReachoutPanel.tsx.
 */
export function isResendable(
  a: ResendableAssignment,
  orderStatus: OrderStatus,
  orderDeletedAt: string | null,
  nowMs: number = Date.now()
): boolean {
  return resendBlockReason(a, orderStatus, orderDeletedAt, nowMs) === null;
}

// ---------------------------------------------------------------------------
// Staff "Re-send email/SMS/push" on a LIVE offer — pure state-machine
// predicates, the exact COMPLEMENT of the resend rules above.
//
// Re-delivering a live offer is a different operation from reopening a dead
// one, and they deliberately do not share a code path:
//
//   declined / expired / lapsed sent|opened  -> sendOffer(resend:true)  (reopen)
//   live sent|opened (unexpired)             -> renotifyOffer           (re-deliver)
//   candidate / queued                       -> sendOffer               (first send)
//
// Reopening claims the assignment via CAS and rewrites its status, expiry and
// decline fields. Re-delivering changes NO state at all — same offer, same
// deadline, the mail simply goes out again — so it needs no claim and has
// nothing to roll back. Folding the live case into the CAS ladder would add a
// fourth way to mutate assignment status purely to reuse code.
//
// The two predicates partition the space: for `sent`/`opened`, exactly one of
// resendBlockReason and renotifyBlockReason returns null. lib/reachout.test.mjs
// asserts that complement directly.
// ---------------------------------------------------------------------------

/** Validate a client-supplied channel list. Returns null for anything that
 *  isn't a non-empty array of known channels — callers treat null as "all
 *  channels", so an all-garbage list is rejected rather than silently widened
 *  to everything. Shared by every route that accepts a channel choice from the
 *  send-confirm dialog. */
export function parseChannels(v: unknown): OfferChannel[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter((c): c is OfferChannel => OFFER_CHANNELS.includes(c as OfferChannel));
  return out.length ? out : null;
}

/** Channels an offer can go out on. Order is display order in the UI. */
export const OFFER_CHANNELS = ["email", "sms", "push"] as const;
export type OfferChannel = (typeof OFFER_CHANNELS)[number];

/** How long before the same channel may be re-sent to the same assignment.
 *  Nothing else stops CX clicking re-send ten times while a florist is slow to
 *  answer; per-channel (not global) so re-sending the email doesn't also lock
 *  out a push. */
export const RENOTIFY_COOLDOWN_MS = 2 * 60 * 1000;

export type RenotifyBlockReason =
  | "not-live" // candidate/queued (use Send), or dead/lapsed (use Re-send), or closed
  | "cooling-down" // this channel was sent to less than RENOTIFY_COOLDOWN_MS ago
  | "order-not-open"
  | "order-cancelled"
  | "order-deleted";

/**
 * Canonical re-notify predicate. Returns null only when the order is still open,
 * the assignment is a LIVE (unexpired) `sent`/`opened` — precisely the
 * `"still-live"` case resendBlockReason rejects — and this channel's cooldown
 * has elapsed.
 *
 * `lastSentAt` is the ISO timestamp of the last successful send on THIS channel
 * for THIS assignment (null = never sent on it, which never blocks).
 */
export function renotifyBlockReason(
  a: ResendableAssignment,
  orderStatus: OrderStatus,
  orderDeletedAt: string | null,
  lastSentAt: string | null,
  nowMs: number = Date.now()
): RenotifyBlockReason | null {
  if (orderDeletedAt != null) return "order-deleted";
  if (orderStatus === "cancelled") return "order-cancelled";
  if (!ORDER_RESENDABLE_STATUSES.includes(orderStatus)) return "order-not-open";

  // Only a live offer can be re-delivered. Everything else is either the plain
  // Send action's job (candidate/queued), the Re-send action's job
  // (declined/expired/lapsed), or closed (accepted/reassigned/released/
  // delivered) — all reported as the same "not-live", since the UI shows the
  // right OTHER action in each of those states.
  if (a.status !== "sent" && a.status !== "opened") return "not-live";
  // Withdrawn ⇒ not live, so re-delivering it is never right: the florist
  // cannot accept what they'd be sent (lib/lateAccept.ts refuses on the stamp).
  // Mirrors resendBlockReason's withdrawn branch above, preserving the
  // partition — Re-send is the one action a withdrawn offer offers, and taking
  // it clears the withdrawal.
  if (a.withdrawn_at) return "not-live";
  // A NULL expiry fails closed for resend ("still-live"); it must therefore be
  // treated as LIVE here, or a null-expiry row would be rejected by both
  // predicates and become unreachable by any action.
  const lapsed = a.offer_expires_at != null && Date.parse(a.offer_expires_at) < nowMs;
  if (lapsed) return "not-live";

  if (lastSentAt != null) {
    const since = nowMs - Date.parse(lastSentAt);
    // Guard NaN (unparseable timestamp) — treat as "no recent send" rather than
    // blocking forever on bad data.
    if (Number.isFinite(since) && since < RENOTIFY_COOLDOWN_MS) return "cooling-down";
  }
  return null;
}

export function isRenotifiable(
  a: ResendableAssignment,
  orderStatus: OrderStatus,
  orderDeletedAt: string | null,
  lastSentAt: string | null,
  nowMs: number = Date.now()
): boolean {
  return renotifyBlockReason(a, orderStatus, orderDeletedAt, lastSentAt, nowMs) === null;
}

/** Requested channels ∩ what settings actually allow. Push has no settings
 *  gate today (it is best-effort and carries no cost), so only email and SMS
 *  are filtered. Pure so it can be table-tested. */
export function allowedChannels(
  requested: readonly OfferChannel[],
  gates: { emailEnabled: boolean; smsEnabled: boolean }
): OfferChannel[] {
  return requested.filter((c) => {
    if (c === "email") return gates.emailEnabled;
    if (c === "sms") return gates.smsEnabled;
    return true;
  });
}

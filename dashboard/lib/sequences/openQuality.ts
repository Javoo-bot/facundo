// Telling a human's open apart from a mail client's prefetch.
//
// The sibling of clickQuality.ts, and it FAILS THE OTHER WAY ROUND — read the
// asymmetry below before changing anything here.
//
// ---- Why an open needs filtering at all
//
// Apple Mail Privacy Protection, Gmail's image proxy and most corporate
// gateways fetch every remote image in a message the moment it arrives,
// including the tracking pixel, whether or not a person ever looks at it. The
// measured result on this system, taken from prod the day this shipped:
//
//     delivered  1,068        opened  1,560
//
// More opens than deliveries. On a day-0/3/7 funnel that inflation was cosmetic
// — nothing branched on opens. The one-day funnel branches on them at 3½ hours,
// where prefetch fires within seconds of delivery and would therefore be the
// MAJORITY of the signal. Ungated, almost every shop would be classified
// "opened", t2 (the email for people who did not open) would go to nearly
// nobody, and t3 would go to nearly everyone — the exact inverse of the intent.
//
// ---- Why this fails CLOSED where clickQuality fails open
//
// clickQuality treats ambiguous evidence as human, because discarding a real
// click abandons an interested prospect. Here the asymmetry runs the other way.
// A false "opened" sends the wrong email — t3's "we know you looked" to a shop
// that never saw the first one, which is a claim about them they can tell is
// false. A false "not opened" merely sends t2, the honest cold follow-up they
// would have received anyway. So an open must EARN the label; the doubtful case
// is "not opened".
//
// The one thing that overrides all of it is a click: a machine may open, but a
// human clicking is what clickQuality already adjudicates, and if that gate says
// human then the message was unquestionably seen.

/** Below this gap after delivery, an open is treated as a client prefetch.
 *
 * 90 seconds, against clickQuality's 5. A click needs someone to read enough to
 * decide and then tap; an open needs only that a mail app be in the foreground,
 * so the honest human floor is much higher. It is also the window in which
 * Apple/Gmail prefetch overwhelmingly lands — it is triggered BY delivery, so it
 * clusters in the first seconds, while a person has to be notified and choose
 * to look. Ninety seconds keeps essentially all of the prefetch out while
 * costing only the rare shop that happened to be staring at its inbox. */
export const MIN_HUMAN_OPEN_DELAY_MS = 90_000;

export interface OpenSignals {
  /** When the `opened` event fired. */
  openedAt?: string | number | null;
  /** When the message was delivered, if a `delivered` event exists for it. */
  deliveredAt?: string | number | null;
  /** How many `opened` events this message has. A prefetch fires once, at
   * delivery; a person who comes back to a mail generates more. Two or more
   * separated opens are therefore positive evidence of a reader even when the
   * first one is too early to trust on its own. */
  openCount?: number | null;
  /** Whether a click on this message already passed clickQuality. A human click
   * proves the message was seen, so it settles the question outright. */
  hasHumanClick?: boolean | null;
}

function ms(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * True when this open is good enough to brand the shop an opener.
 *
 * Order is the argument:
 *   1. A human click settles it — nothing below can overturn "they clicked".
 *   2. Two or more opens beat the timing rule, because prefetch fires once.
 *   3. Otherwise the open must be at least MIN_HUMAN_OPEN_DELAY_MS after
 *      delivery.
 *   4. With no delivery timestamp to compare against we have no evidence, and
 *      per the asymmetry above no evidence means NOT a genuine open. (This is
 *      not the same as having no events at all — that case never reaches here;
 *      it resolves to `unknown` in openState.ts, which refuses to gate.)
 */
export function isGenuineOpen(signals: OpenSignals): boolean {
  if (signals.hasHumanClick) return true;
  if ((signals.openCount ?? 0) >= 2) return true;

  const opened = ms(signals.openedAt);
  const delivered = ms(signals.deliveredAt);
  if (opened === null || delivered === null) return false; // no evidence → not genuine
  const delay = opened - delivered;
  // Negative delay is clock skew between provider event timestamps, not a
  // time traveller. It is also exactly what a prefetch looks like when the two
  // events race, so it does not earn the label.
  if (delay < 0) return false;
  return delay >= MIN_HUMAN_OPEN_DELAY_MS;
}

/** Pull the open signals out of a Resend `email.opened` webhook payload.
 * Mirrors clickSignalsFromResend: tolerates the shapes the field has taken and
 * returns nulls rather than throwing. */
export function openSignalsFromResend(body: unknown): OpenSignals {
  const data = (body as { data?: Record<string, unknown> })?.data ?? {};
  const open = (data.open ?? {}) as Record<string, unknown>;
  const at =
    (typeof open.timestamp === "string" && open.timestamp) ||
    (typeof data.created_at === "string" && (data.created_at as string)) ||
    null;
  return { openedAt: at };
}

// Who are we actually writing to?
//
// `florists` is keyed on (city_id, place_id) — one row per MAP LISTING, not per
// business. A chain, or one shop listed under several place ids, is several
// rows sharing one inbox. On live data that is not an edge case: 76 addresses
// are shared across listings and one appears on 33 of them. Enrolling each
// listing separately would put four emails × 33 into a single inbox, from a
// funnel whose entire pitch is that we are not a marketing list.
//
// So enrolment dedupes on the CONTACT, not the row: the identity is the thing
// a message is delivered to. Pure and alias-free for `node --test`.

/** Normalised email identity, or null when there is nothing to dedupe on.
 *
 * Case and surrounding whitespace are folded because they are display noise.
 * Gmail dots and +tags are deliberately NOT folded: for a business address the
 * local part is usually meaningful (`info.paris@` and `infoparis@` can be two
 * different mailboxes at the same company), and wrongly merging two real
 * inboxes silently drops a prospect — the more expensive mistake here. */
export function contactKey(email: string | null | undefined): string | null {
  if (typeof email !== "string") return null;
  const trimmed = email.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  // Must look like an address at all; a scraped junk value is not an identity.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) return null;
  return trimmed;
}

/** Should we enrol this shop, given who is already in a live run?
 *
 * `liveContactKeys` are the contact keys that already have a running sequence.
 * A shop with no usable address is allowed through — the tick will log its own
 * `no-email` skip with a reason, which is more useful than a silent refusal
 * here that leaves no trace. */
export function shouldEnrolContact(
  email: string | null | undefined,
  liveContactKeys: Iterable<string>
): boolean {
  const key = contactKey(email);
  if (key === null) return true;
  for (const k of liveContactKeys) if (k === key) return false;
  return true;
}

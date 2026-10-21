// Which number does this florist see, and hear from?
//
// Pure, alias-free, unit-tested. ONE mapping read by both call directions: a
// florist who is called from one "local" number and asked to call back on a
// different one has been shown the trick, and the whole point of a local DID is
// that it does not look like a call centre.

export interface PhoneNumberRow {
  id: string;
  e164: string;
  country: string;
  city_id: string | null;
  persona_id: string | null;
  status: string;
}

/** Only an assigned number is usable. `available` is bought-but-unallocated,
 * and calling from one would break the city↔number mapping the next assignment
 * is about to create. */
const USABLE = "assigned";

/**
 * The number to use for a florist in this city/country, or null.
 *
 * Falls back city → country → nothing, deliberately in that order:
 *  - the city's own number is the point;
 *  - any number in the same COUNTRY is still a local dialling code and still
 *    cheaper and more answerable than an international one;
 *  - null means DO NOT CALL. There is no "use whatever we have" tier, because
 *    a Spanish florist seeing a German number is worse than no call at all —
 *    it reads as a scam, which is the one impression that cannot be undone.
 */
export function resolveNumberForCity(
  cityId: string | null,
  country: string | null,
  numbers: PhoneNumberRow[]
): PhoneNumberRow | null {
  const usable = numbers.filter((n) => n.status === USABLE);

  if (cityId) {
    const exact = usable.find((n) => n.city_id === cityId);
    if (exact) return exact;
  }

  if (country) {
    const cc = country.trim().toUpperCase();
    // Prefer an unassigned-to-a-city number over one that belongs to a
    // different city: borrowing another city's line is more surprising to the
    // florist there than using a spare.
    const spare = usable.find((n) => n.country.toUpperCase() === cc && n.city_id === null);
    if (spare) return spare;
    const anyInCountry = usable.find((n) => n.country.toUpperCase() === cc);
    if (anyInCountry) return anyInCountry;
  }

  return null;
}

/** Can we place a voice touch to this florist at all? Separate from the number
 * lookup so a missing number and a missing consent read differently in logs. */
export function canCallFlorist(f: {
  phone_e164?: string | null;
  order_sms_opt_out?: boolean | null;
  excluded_at?: string | null;
  deleted_at?: string | null;
}): boolean {
  if (!f.phone_e164) return false;
  // The SMS opt-out is the closest thing we have to "do not contact me on this
  // phone". Treating a text opt-out as permission to CALL would be a reading
  // nobody would defend out loud.
  if (f.order_sms_opt_out) return false;
  if (f.excluded_at || f.deleted_at) return false;
  return true;
}

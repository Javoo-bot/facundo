/** The country list behind the join form's phone fields.
 *
 * SERVER-SIDE. This is built once on the server and passed to the client as
 * plain data, deliberately: libphonenumber-js plus i18n-iso-countries is a
 * couple of hundred KB, and shipping it to the browser to render a <select>
 * would cost every florist that download for a list that never changes within
 * a request. The client only ever concatenates `+<dial>` with what was typed.
 *
 * Relative imports only (no "@/..."), so plain `node --test` can reach it. */

import { getCountries, getCountryCallingCode, type CountryCode } from "libphonenumber-js";
import countries from "i18n-iso-countries";
import enLocale from "i18n-iso-countries/langs/en.json" with { type: "json" };

countries.registerLocale(enLocale);

export interface DialCountry {
  /** ISO-3166-1 alpha-2, e.g. "ES". */
  code: string;
  /** Calling code WITHOUT the plus, e.g. "34". */
  dial: string;
  /** English country name, e.g. "Spain". */
  name: string;
  /** Regional-indicator flag, e.g. "🇪🇸". */
  flag: string;
}

/** Alpha-2 → regional-indicator emoji. Two letters offset into the Unicode
 * regional-indicator block; no image assets, no lookup table. */
function flagFor(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return "";
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

let cached: DialCountry[] | null = null;

/** Every country libphonenumber can validate, with its dial code, sorted by
 * name. Cached per process — the list is static.
 *
 * Entries libphonenumber knows but i18n-iso-countries can't name (a handful of
 * territories) are dropped rather than shown as a bare code: a florist scanning
 * a dropdown can't act on "AC". Their numbers still validate fine if typed in
 * full international form. */
export function dialCountries(): DialCountry[] {
  if (cached) return cached;
  const built: DialCountry[] = [];
  for (const code of getCountries()) {
    const name = countries.getName(code, "en");
    if (!name) continue;
    built.push({
      code,
      dial: getCountryCallingCode(code as CountryCode),
      name,
      flag: flagFor(code),
    });
  }
  built.sort((a, b) => a.name.localeCompare(b.name, "en"));
  cached = built;
  return built;
}

/** Split a stored number into a country and the rest, for pre-filling the two
 * controls.
 *
 * `fallbackRegion` is the country of the city the florist was ingested under —
 * used when the value is empty, when it is a NATIONAL number with no "+" to
 * identify it, and to break ties.
 *
 * TIES ARE COMMON AND UNAVOIDABLE HERE. libphonenumber returns the plain
 * country calling code, so every NANP country reports "1" (US, CA, TT, …) and
 * Russia and Kazakhstan both report "7". A dial code alone therefore cannot
 * identify those countries — `fallbackRegion` decides, and failing that we pick
 * deterministically (first by name) and the florist can change the dropdown.
 * In practice the fallback is always present: it comes from the city the
 * florist was ingested under.
 *
 * Never throws and never guesses a country for a number that contradicts one:
 * a "+" value whose code matches nothing keeps the whole string in `national`,
 * so the florist sees exactly what is stored. */
export function splitPhone(
  value: string | null | undefined,
  fallbackRegion: string | null
): { code: string; national: string } {
  const fallback = fallbackRegion?.toUpperCase() ?? "";
  const list = dialCountries();
  const fallbackCode = list.some((c) => c.code === fallback) ? fallback : "";

  const raw = (value ?? "").trim();
  if (!raw) return { code: fallbackCode, national: "" };

  // Strip formatting BEFORE deciding whether this is international. Stored
  // numbers are scraped from websites and typed by hand, so "(+34) 612-34.56.78"
  // is a real shape — testing `raw.startsWith("+")` on it would misread a
  // perfectly good international number as a national one.
  const cleaned = raw.replace(/[^\d+]/g, "");
  if (!cleaned.startsWith("+")) {
    // A national number — the region it belongs to isn't in the string, so the
    // florist's own country is the only honest guess. Keep the ORIGINAL text,
    // not the stripped digits: it is theirs and it is still editable.
    return { code: fallbackCode, national: raw };
  }

  const digits = cleaned.slice(1).replace(/\D/g, "");
  let best: DialCountry | null = null;
  for (const c of list) {
    if (!digits.startsWith(c.dial)) continue;
    if (!best || c.dial.length > best.dial.length) best = c;
    // Prefer the florist's own country when several share a dial code (+1 is
    // the US and twenty others; +7 is Russia and Kazakhstan).
    else if (c.dial.length === best.dial.length && c.code === fallbackCode) best = c;
  }
  if (!best) return { code: fallbackCode, national: raw };
  return { code: best.code, national: digits.slice(best.dial.length) };
}

/** The two controls back into one string to submit. Returns "" when nothing was
 * typed, so an untouched optional field stays empty rather than submitting a
 * bare "+34" the server would have to reject. */
export function joinPhone(dial: string, national: string): string {
  const rest = national.trim();
  if (!rest) return "";
  if (rest.startsWith("+")) return rest; // florist pasted a full international number
  return `+${dial}${rest.replace(/\D/g, "")}`;
}

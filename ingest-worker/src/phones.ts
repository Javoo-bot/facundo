// Phone number normalization to E.164-style international format, using
// libphonenumber-js with the florist's country as the default parsing
// region.
//
// Ported from ingest/phones.py. `countryToRegion` resolves a country name
// or code (e.g. "Spain", "US", "United States") to an ISO-3166-1 alpha-2
// region string once per ingest run, which `normalizePhone` then uses as
// the default region for numbers that don't already carry a leading
// "+<country code>" (Maps phones usually do; scraped website phones often
// don't).
//
// Honest, no data loss: a number that can't be parsed or doesn't validate
// is returned unchanged rather than nulled out or guessed at.

import * as countries from "i18n-iso-countries";
import enLocale from "i18n-iso-countries/langs/en.json";
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

countries.registerLocale(enLocale);

/** Resolve `country` to an ISO-3166-1 alpha-2 region code that
 * libphonenumber-js understands (e.g. "Spain" -> "ES", "US" -> "US",
 * "United States" -> "US", "UK" -> "GB").
 *
 * Returns null when it can't be resolved — `normalizePhone` still works
 * without a region for numbers that already start with "+<country code>";
 * only region-less local numbers are left unnormalized in that case. */
export function countryToRegion(country: string | null): string | null {
  if (!country) return null;
  const trimmed = country.trim();
  if (!trimmed) return null;

  // Exact alpha-2 / alpha-3 code match first (cheap, unambiguous).
  const upper = trimmed.toUpperCase();
  if (upper.length === 2 && countries.isValid(upper)) {
    return upper;
  }
  if (upper.length === 3 && countries.isValid(upper)) {
    const alpha2 = countries.alpha3ToAlpha2(upper);
    if (alpha2) return alpha2;
  }

  // Name match ("Spain", "United States", "UK", and other common variants
  // i18n-iso-countries knows about).
  const byName = countries.getAlpha2Code(trimmed, "en");
  if (byName) return byName;

  return null;
}

/** Normalize `raw` to international format (e.g. "+34 612 34 56 78"),
 * using `region` as the default country for numbers without a leading
 * "+<country code>".
 *
 * Returns `raw` unchanged (not null) if it's falsy, unparseable, or fails
 * validation — never fabricates or drops data. */
export function normalizePhone(raw: string | null, region: string | null): string | null {
  if (!raw) return raw;

  let phone;
  try {
    phone = parsePhoneNumberFromString(raw, (region ?? undefined) as CountryCode | undefined);
  } catch {
    return raw;
  }
  if (!phone || !phone.isValid()) {
    return raw;
  }
  return phone.formatInternational();
}

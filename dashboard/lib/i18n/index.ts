// i18n core — pure string lookup/interpolation, no I/O, no React. Safe to
// call from a plain server async function (route handlers, lib/reachoutSend.ts)
// or a client component alike. Mirrors lib/emailTemplate.ts's "no I/O, unit
// test it directly" style (see i18n.test.mjs).

import { DEFAULT_LOCALE, isLocale, regionToLocale, regionImpliesEnglish, type Locale } from "./locales.ts";
import { en, type MessageTree } from "./messages/en.ts";
import { fr } from "./messages/fr.ts";
import { es } from "./messages/es.ts";
import { it } from "./messages/it.ts";
import { de } from "./messages/de.ts";
import { pt } from "./messages/pt.ts";

export type { Locale } from "./locales.ts";
export { LOCALES, DEFAULT_LOCALE, isLocale, regionToLocale, regionImpliesEnglish } from "./locales.ts";
export type { MessageTree } from "./messages/en.ts";

const CATALOG: Record<Locale, MessageTree> = { en, fr, es, it, de, pt };

// Walks a dot-path ("email.offer.subject") through a message tree. Returns
// undefined (never throws) on a missing branch, a non-string leaf, or an
// empty/partial locale object — every one of those is a legitimate "not
// translated here yet" state that the caller falls back past.
function lookup(tree: MessageTree, path: string[]): string | undefined {
  let node: string | MessageTree | undefined = tree;
  for (const segment of path) {
    if (typeof node !== "object" || node === null) return undefined;
    node = node[segment];
  }
  return typeof node === "string" ? node : undefined;
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

/** Looks up `key` (dot-path, e.g. "email.offer.subject") in `messages[locale]`,
 * falling back to `messages.en` per-key when the requested locale is missing
 * or hasn't translated that leaf yet. Interpolates `{var}` placeholders from
 * `vars`. Never throws — an entirely absent key (missing in EN too, i.e. a
 * typo) returns the key itself so a bad call site is visible in the rendered
 * output instead of crashing a send. */
export function t(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const path = key.split(".");
  const tree = CATALOG[locale] ?? CATALOG[DEFAULT_LOCALE];
  const resolved = lookup(tree, path) ?? lookup(CATALOG[DEFAULT_LOCALE], path);
  if (resolved === undefined) return key;
  return interpolate(resolved, vars);
}

/** Coerces an arbitrary (often DB- or request-sourced) value into a supported
 * Locale, defaulting to EN for anything unset or unrecognized. */
export function resolveLocale(raw: string | null | undefined): Locale {
  return isLocale(raw) ? raw : DEFAULT_LOCALE;
}

/** Resolves the locale to use for outbound copy to a florist.
 * `florists.locale` is derived from the florist's country at ingest and
 * persisted (ES → "es", …; see ingest/locales.py + ingest-worker/src/locale.ts),
 * and can be overridden manually via the self-service picker or the staff
 * per-florist control.
 *
 * `fallbackRegion` (the alpha-2 country of the florist's city) covers the case
 * where the column is still null even though the country DOES imply a language:
 * a florist ingested before that derivation landed, or by a stale ingest build.
 * Without it a Paris shop silently gets an English offer email — which is
 * exactly what happened to Paris (ingested 2026-08-03 by a build predating the
 * derivation) before `ingest/backfill_locales.py` filled those 200 rows in.
 * The stored value always wins; the region is consulted only when there isn't
 * one. Both absent (or an English/unmapped country) still resolves to EN. */
export function resolveFloristLocale(
  florist: { locale?: string | null },
  fallbackRegion?: string | null
): Locale {
  if (isLocale(florist.locale)) return florist.locale;
  return resolveLocale(regionToLocale(fallbackRegion));
}

/** True when `resolveFloristLocale` is about to return EN not because English
 * is right for this florist, but because nothing told us otherwise.
 *
 * WHY THIS EXISTS: EN is both a legitimate answer (a London shop) and the
 * failure mode (a Geneva shop whose country maps to nothing). Those two are
 * indistinguishable in the return value, so for as long as that was the only
 * signal, sending a French florist an English offer looked exactly like
 * working correctly. It cost us order #2000034 — see
 * docs/superpowers/specs/2026-09-16-florist-locale-and-reply-failures-design.md.
 *
 * Returns true only for the third case below:
 *   - a stored `locale` (including an explicit "en") — a choice, never flagged
 *   - no region to judge against — nothing to say, not flagged
 *   - a region that maps to a supported locale — resolved, not flagged
 *   - a region that maps to nothing AND isn't English-defaulting — FLAGGED
 *
 * It fires for two different gaps on purpose, because the observation is the
 * same and only the fix differs: a multilingual country we can't decide from
 * the code alone (CH/BE/LU), and a country whose language we have no catalog
 * for at all (PL, DK, SE, IL, …). Both mean "this shop is getting English and
 * its country is not an English-speaking one", which is the thing a human
 * needs to see. Pure — the caller decides whether to log, flag or block. */
export function isUnintendedEnglish(
  florist: { locale?: string | null },
  fallbackRegion?: string | null
): boolean {
  if (isLocale(florist.locale)) return false;
  if (!fallbackRegion || !fallbackRegion.trim()) return false;
  if (regionToLocale(fallbackRegion)) return false;
  return !regionImpliesEnglish(fallbackRegion);
}

// ---- Runtime DB-override layer (dashboard/app/(staff)/email-templates,
// supabase/migrations/2026-07-26-message-overrides.sql). Everything above
// this line is the original pure catalog lookup and stays untouched — these
// additions only ever WRAP `t()`, they never change its behavior. ----

/** Raw per-locale catalog lookup — unlike `t()`, this does NOT fall back to
 * EN when `locale` hasn't translated `key` yet; it returns undefined instead.
 * Used by the email-templates editor to tell apart "this locale has its own
 * copy" from "falling back to EN", which `t()` deliberately hides from every
 * other caller. Pure, no I/O. */
export function staticLookup(locale: Locale, key: string): string | undefined {
  return lookup(CATALOG[locale] ?? CATALOG[DEFAULT_LOCALE], key.split("."));
}

/** Override-aware `t()`: returns `overrides[key]` (interpolated with `vars`)
 * when present, else delegates to the plain `t()` (locale copy, then EN
 * fallback, exactly as before). `overrides` is a flat `{key: value}` map for
 * ONE locale — see lib/messageOverrides.ts::loadOverrides, the one I/O seam
 * that builds it. Passing `{}` (or omitting overrides entirely by not
 * threading them) is byte-for-byte identical to calling `t()` directly, so
 * every send site is provably unaffected until an override actually exists.
 * Pure — no I/O here either. */
export function tWithOverrides(
  overrides: Record<string, string>,
  locale: Locale,
  key: string,
  vars?: Record<string, string | number>
): string {
  const override = overrides[key];
  if (override !== undefined) return interpolate(override, vars);
  return t(locale, key, vars);
}

/** Recursively lists every leaf dot-path of a message tree (default: the EN
 * catalog, the canonical key set — every other locale is a subset). Pure, no
 * I/O. Used to (a) drive the email-templates editor's key list and (b)
 * validate that a proposed override's `key` is real before it's written. */
export function flattenKeys(tree: MessageTree = en): string[] {
  const keys: string[] = [];
  const walk = (node: MessageTree, prefix: string[]) => {
    for (const [segment, value] of Object.entries(node)) {
      const path = [...prefix, segment];
      if (typeof value === "string") keys.push(path.join("."));
      else walk(value, path);
    }
  };
  walk(tree, []);
  return keys;
}

// Single source for order-issue `type` → human label, consolidating what used
// to be three copy-pasted `ISSUE_LABEL` maps (lib/issueComms.ts,
// components/florist/FloristMessages.tsx, components/issues/IssueThread.tsx).
// Pure t() lookup — no I/O, no React — so both server code and client
// components can import it directly, same as lib/i18n/index.ts itself.

import { tWithOverrides, type Locale } from "./index.ts";

/** Human label for an order-issue `type` value, localized. Falls back to the
 * generic "other" label (matches the three inline maps this replaced, which
 * all fell back to a plain "Issue" for an unrecognized/legacy type).
 *
 * `overrides` is an optional flat `{key: value}` DB-override map (see
 * lib/messageOverrides.ts::loadOverrides) — pass one along when calling from
 * a send site so a staff-edited issueLabel.* string applies here too; omitted
 * (the default `{}`) is byte-identical to the old plain-t() behavior, which is
 * what every existing UI call site (FloristMessages, IssueThread) keeps
 * getting since they don't have a DB round-trip to spare. */
export function issueLabel(locale: Locale, type: string, overrides: Record<string, string> = {}): string {
  const key = `issueLabel.${type}`;
  const resolved = tWithOverrides(overrides, locale, key);
  return resolved === key ? tWithOverrides(overrides, locale, "issueLabel.other") : resolved;
}

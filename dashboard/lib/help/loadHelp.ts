import { createServiceClient } from "@/lib/supabaseAdmin";
import { loadOverrides } from "@/lib/messageOverrides";
import { tWithOverrides, type Locale } from "@/lib/i18n";
import { HELP_ARTICLES, helpKey } from "@/lib/help/content";

/** Fallback when `settings.florist_support_email` is unset. Mirrors
 * lib/offerVars.ts:182 — the same address the offer emails would quote. */
const DEFAULT_SUPPORT_EMAIL = "florists@fc.example.com";

/**
 * The single I/O seam behind both Q&A pages (`app/help`, `app/florist/(app)/help`).
 * Reads the runtime copy overrides for `locale` and the support address, and
 * hands back an override-aware `tt` bound to that locale — so an edit made in
 * the staff console's Email-templates editor lands on the Q&A with no deploy,
 * exactly as it does on /florist/how-it-works.
 *
 * Uses the service client because both `message_overrides` and `settings` are
 * staff-scoped under RLS and the public page has no session at all. It reads
 * two rows of our own published copy — no florist, order or customer data is
 * touched here.
 */
export async function loadHelpCopy(
  locale: Locale,
  opts: { singlePayment?: boolean } = {}
): Promise<{
  tt: (key: string, vars?: Record<string, string | number>) => string;
  supportEmail: string;
}> {
  const admin = createServiceClient();
  const [overrides, settings] = await Promise.all([
    loadOverrides(admin, locale),
    admin.from("settings").select("florist_support_email").eq("id", 1).maybeSingle(),
  ]);
  const key = opts.singlePayment ? swapForFullPayoutVariant : (k: string) => k;
  return {
    tt: (k, vars) => tWithOverrides(overrides, locale, key(k), vars),
    supportEmail: settings.data?.florist_support_email || DEFAULT_SUPPORT_EMAIL,
  };
}

/** Articles whose published ANSWER states the 70/30 split, and therefore need a
 * different answer for a florist paid in full on accept. The question, the
 * article id and the related-article graph are unchanged: only the body is
 * swapped, for a `bodyFull` sibling living in the same catalog node.
 *
 * Derived from `fullPayoutBody` on the article itself rather than restated
 * here, so the swap, the /faq editable-keys list and the translation-parity
 * guard can never disagree about which articles have a variant.
 *
 * Note this is a declared set, not a "try `${key}Full` and fall back" rule:
 * a silent fallback would let a half-translated variant ship and show English
 * to a shop in Bordeaux. */
const FULL_PAYOUT_BODY_VARIANTS: ReadonlySet<string> = new Set(
  HELP_ARTICLES.filter((a) => a.fullPayoutBody).map((a) => helpKey(a.id, "body"))
);

/** Remaps a help key to its full-payout variant, BEFORE the override lookup —
 * so staff editing `...bodyFull` in the console reaches these florists too. */
function swapForFullPayoutVariant(key: string): string {
  return FULL_PAYOUT_BODY_VARIANTS.has(key) ? `${key}Full` : key;
}

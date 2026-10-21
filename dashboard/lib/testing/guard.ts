import { createServiceClient } from "@/lib/supabaseAdmin";

type Admin = ReturnType<typeof createServiceClient>;

/**
 * The one gate every testing action passes through.
 *
 * This harness deletes florists, rewrites their history and fires real sends at
 * them. On a live database holding 6,481 real shops, "I'll be careful" is not a
 * safety property. So every mutating call re-reads the row and refuses unless
 * `is_test_shop` is true — the check is on the DATA, not on which button was
 * clicked, so a wrong id in a request body cannot reach a real florist.
 *
 * Deliberately re-read per action rather than trusted from the list the UI was
 * rendered from: that list could be minutes stale, and the whole point is that
 * this cannot be talked into touching production data.
 */
export async function assertTestShop(admin: Admin, floristId: string): Promise<
  { ok: true; florist: Record<string, unknown> } | { ok: false; reason: string }
> {
  if (typeof floristId !== "string" || floristId.length === 0) {
    return { ok: false, reason: "No florist id given." };
  }
  const { data, error } = await admin
    .from("florists")
    .select("id, name, email, is_test_shop, city_id, locale")
    .eq("id", floristId)
    .maybeSingle();
  if (error) return { ok: false, reason: `Lookup failed: ${error.message}` };
  if (!data) return { ok: false, reason: "No such florist." };
  if (data.is_test_shop !== true) {
    // The message names the rule rather than just refusing, because the only
    // way to see this is to have pointed the harness at a real shop.
    return { ok: false, reason: "That florist is not a test shop. The testing tools only ever touch shops flagged is_test_shop." };
  }
  return { ok: true, florist: data as Record<string, unknown> };
}

/** Prefix every harness-created shop's place_id carries. `is_test_shop` is the
 * authority; this is for finding and cleaning them up. */
export const TEST_PLACE_PREFIX = "TESTKIT_";

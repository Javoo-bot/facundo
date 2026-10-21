import { cache } from "react";
import { createServerClient } from "@/lib/supabase";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { gatherAttention, type CxAttentionRow } from "@/lib/cxAttention";
import type { StaffRole } from "@/lib/staffRoles";

/**
 * Request-scoped caching for the auth + attention checks every staff RSC
 * repeats (the layout, plus each page's own inline re-check — see
 * app/(staff)/layout.tsx's comment on why the re-check exists). Without this,
 * a single navigation fired 2-3x the same `auth.getUser()` network call, the
 * same `allowed_emails` lookup, and the same multi-query attention gather
 * (once for the layout badge, once for the Control panel's attention table).
 *
 * `cache()` dedupes by argument identity within one request/render pass — NOT
 * across requests. The crucial bit: each accessor below creates its OWN
 * Supabase client internally rather than taking one as a parameter, because
 * the layout and each page each construct their own client object. A cache()
 * fn keyed on a client argument would never hit (different object each time);
 * keying only on primitives (an email string, nothing for the user/attention
 * fetch) is what makes the dedup actually work.
 */

// One getUser() network call per request, shared by the layout + the page.
export const getSessionUser = cache(async () => {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

/**
 * ONE allowed_emails query returning BOTH allowed + role, request-cached by
 * email. Preserves the EXACT fail-closed contract of lib/allowlist.ts's
 * isAllowed/getStaffRole: any error/exception => { allowed: false, role:
 * null }, never throws. lib/allowlist.ts itself is untouched — API routes
 * still import isAllowed/getStaffRole directly — this is purely an
 * additional RSC-facing accessor.
 */
export const getStaffAccess = cache(
  async (email: string | null | undefined): Promise<{ allowed: boolean; role: StaffRole | null }> => {
    if (!email) return { allowed: false, role: null };
    try {
      const admin = createServiceClient();
      const { data, error } = await admin
        .from("allowed_emails")
        .select("email, role")
        .eq("email", email.toLowerCase())
        .limit(1);
      if (error) return { allowed: false, role: null }; // FAIL CLOSED
      const row = data?.[0];
      return { allowed: !!row, role: (row?.role as StaffRole | undefined) ?? null };
    } catch {
      return { allowed: false, role: null }; // FAIL CLOSED
    }
  }
);

/**
 * Request-cached attention gather — same prioritized list that feeds the
 * layout's sidebar badge and the Control panel's attention zone, now computed once
 * per request instead of 2-3x. Creates its own session client (RLS-scoped,
 * same as every other read) rather than accepting one, for the same dedup
 * reason as getSessionUser/getStaffAccess above.
 */
export const getAttentionCached = cache(async (): Promise<CxAttentionRow[]> => {
  const supabase = await createServerClient();
  return gatherAttention(supabase);
});

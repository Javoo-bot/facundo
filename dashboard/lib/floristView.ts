import "server-only";
import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerClient } from "./supabase";
import { createServiceClient } from "./supabaseAdmin";
import { currentFlorist } from "./floristAuth";
import { resolveViewAs } from "./viewAs";

/**
 * The florist whose app the current request should render, plus the Supabase
 * client to read their data with.
 *
 * - Real florist  → the RLS anon+JWT client; scoping is implicit via
 *   `current_florist_id()`, so `scope` is null and queries stay unchanged.
 * - Staff view-as → the service-role client (RLS won't surface a florist's rows
 *   to a staff JWT) plus an explicit `scope` of the ids this florist owns.
 *   Callers apply the scope to every florist-scoped read, faithfully
 *   replicating what RLS would have allowed. Getting a scope filter wrong can
 *   only ever LEAK ANOTHER FLORIST'S DATA TO STAFF — never widen a real
 *   florist's access — but it must still be applied to every read.
 *
 * Returns null when the request is neither a mapped florist nor a valid staff
 * view-as session (the layout redirects / shows NoFloristAccount in that case).
 */
export type FloristScope = {
  /** order_assignments.id owned by this florist (scope payouts, delivery_events,
   *  order_issues, issue_messages by `assignment_id in (...)`, and single-record
   *  pages by membership). */
  assignmentIds: string[];
  /** distinct orders.id this florist has an assignment for (scope orders +
   *  order_line_items by `order_id in (...)`). */
  orderIds: string[];
};

export type FloristReadCtx =
  | { floristId: string; viewingAsStaff: false; staffEmail: null; db: SupabaseClient; scope: null }
  | { floristId: string; viewingAsStaff: true; staffEmail: string; db: SupabaseClient; scope: FloristScope };

export const floristReadContext = cache(async (): Promise<FloristReadCtx | null> => {
  const va = await resolveViewAs();
  if (va) {
    const db = createServiceClient();
    // The full id-set this florist owns — the same rows RLS would have exposed.
    const { data } = await db.from("order_assignments").select("id, order_id").eq("florist_id", va.floristId);
    const rows = data ?? [];
    const scope: FloristScope = {
      assignmentIds: rows.map((r) => r.id as string),
      orderIds: Array.from(new Set(rows.map((r) => r.order_id as string).filter(Boolean))),
    };
    return { floristId: va.floristId, viewingAsStaff: true, staffEmail: va.staffEmail, db, scope };
  }

  const me = await currentFlorist();
  if (me) {
    const db = await createServerClient();
    return { floristId: me.floristId, viewingAsStaff: false, staffEmail: null, db, scope: null };
  }

  return null;
});

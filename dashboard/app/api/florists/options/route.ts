import { requireAllowedUser, jsonError } from "@/lib/apiAuth";
import { createServerClient } from "@/lib/supabase";
import { escapeLikeTerm, parseFloristOptionsParams } from "@/lib/floristOptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// On-demand florist picker options — the lazy replacement for the full rosters
// that several staff pages used to fetch eagerly on EVERY render:
//
//   /orders   → 1,189 florists (email not null), for the mock-order tool
//   /payments → the same roster, for the ad-hoc card picker
//   /orders/[id] (?detail=1) → the order page's "add any florist" picker,
//     which needs the fuller FloristDirectoryEntry column set (lib/types.ts)
//     rather than just id/name.
//
// Both are controls most page loads never touch, and both rosters grow with
// every ingest. Fetching them here means the cost is paid when the picker is
// actually opened, and `q` lets the search happen in Postgres rather than by
// shipping thousands of rows to the browser to filter in JS.
//
// Reads via the session client (anon key + user JWT) so RLS applies exactly as
// it does for every other florist read in the dashboard.
//
// Param parsing/clamping is pure and lives in lib/floristOptions.ts (tested
// there with plain `node --test`); this file is I/O only.

export async function GET(request: Request): Promise<Response> {
  const gate = await requireAllowedUser();
  if (!gate.ok) return gate.res;

  const url = new URL(request.url);
  const { q, limit, includeExcluded, withEmail, columns } = parseFloristOptionsParams(url.searchParams);

  const supabase = await createServerClient();
  let query = supabase
    .from("florists")
    .select(columns)
    .is("deleted_at", null)
    .order("name")
    .order("id") // unique tiebreak — `name` is not unique
    .limit(limit);

  if (!includeExcluded) query = query.is("excluded_at", null);
  if (withEmail) query = query.not("email", "is", null);
  if (q) {
    // `.ilike()` is parameterized (unlike `.or()`), so the value needs no
    // hand-escaping — but `%` and `_` are still wildcards, so escape those to
    // keep a literal search literal.
    query = query.ilike("name", `%${escapeLikeTerm(q)}%`);
  }

  const { data, error } = await query;
  if (error) return jsonError(`Failed to load florists: ${error.message}`, 500);

  return Response.json({ florists: data ?? [], limit, truncated: (data?.length ?? 0) >= limit });
}

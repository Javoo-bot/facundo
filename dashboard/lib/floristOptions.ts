/** Pure query-param parsing for GET /api/florists/options — the on-demand
 * florist picker endpoint. Split out from the route (which is the only place
 * doing I/O) so plain `node --test` can exercise it: this file imports
 * NOTHING, not even other lib/*.ts modules, let alone anything that resolves
 * through the "@/..." tsconfig alias (see lib/apiAuth.test.mjs's exclusion in
 * scripts/tests.mjs for why that matters).
 *
 * `detail=1` is the one behavioral knob this file adds beyond what the route
 * already did: swap the "id, name" picker column set for the fuller
 * FloristDirectoryEntry set (lib/types.ts) the order page's "add any florist"
 * panel needs. Every other param — q, limit, includeExcluded, withEmail —
 * keeps its exact prior default/clamping behavior; `detail` absent must
 * produce byte-identical params to before this file existed.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;

/** id, name — the original picker column set (mock-order tool, payments card picker). */
export const BASIC_COLUMNS = "id, name";

/** Full FloristDirectoryEntry set (dashboard/lib/types.ts:519) for the order
 * page's "add any florist" picker. */
export const DETAIL_COLUMNS = "id, name, lifecycle_stage, trust_tier, address, city_id, excluded_at";

/** Escapes `%` and `_` (ilike wildcards) so a search term is matched literally.
 * `.ilike()` is parameterized, so this is about wildcard semantics, not SQL
 * injection — the value still goes through the client as a bind param. */
export function escapeLikeTerm(q: string): string {
  return q.replace(/[%_]/g, "\\$&");
}

export interface FloristOptionsParams {
  q: string;
  limit: number;
  includeExcluded: boolean;
  withEmail: boolean;
  detail: boolean;
  columns: string;
}

/** Parses and clamps every query param the route accepts. Pure function of a
 * URLSearchParams — no request/response/env in sight. */
export function parseFloristOptionsParams(searchParams: URLSearchParams): FloristOptionsParams {
  const q = (searchParams.get("q") ?? "").trim();

  const withEmail = searchParams.get("withEmail") !== "0"; // default: offerable only
  // The card picker (/payments) has always listed permanently-excluded shops —
  // you can still owe one money — so it opts back in rather than silently
  // losing rows to this endpoint's stricter default.
  const includeExcluded = searchParams.get("includeExcluded") === "1";
  const detail = searchParams.get("detail") === "1";

  const rawLimit = parseInt(searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT) : DEFAULT_LIMIT;

  return {
    q,
    limit,
    includeExcluded,
    withEmail,
    detail,
    columns: detail ? DETAIL_COLUMNS : BASIC_COLUMNS,
  };
}

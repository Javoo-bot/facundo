import type { WorkingSetConfig } from "./workingSet";

/** Read the two working-set inputs in one parallel round trip:
 * `app_settings.active_order_tags` and whether ANY order is explicitly picked.
 *
 * The second is a `head: true` count against the partial index
 * `orders_worklist_idx` — it never scans the table, and it is fetched once per
 * sweep / workflow run, never per order.
 *
 * Mirrors dashboard/lib/workingSetServer.ts::workingSetConfig. Kept as its own
 * file (rather than folded into workingSet.ts) so the pure semantics module
 * stays dependency-free and byte-identical across the two builds. */
export async function workingSetConfig(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the worker's supabase client is loosely typed
  sb: any,
): Promise<WorkingSetConfig> {
  // Promise.resolve(...) rather than chaining .catch() straight onto the query:
  // PostgREST's builder is a THENABLE, not a real promise, so it has no
  // .catch() to chain. Promise.resolve adopts it correctly.
  const [settings, picks] = await Promise.all([
    Promise.resolve<{ data?: { active_order_tags?: unknown } | null }>(
      sb.from("app_settings").select("active_order_tags").eq("id", 1).maybeSingle()
    ).catch(() => ({ data: null })),
    // FAIL OPEN. A failed count must not be read as "picks exist" — that would
    // turn the gate on with an empty tag set and hide EVERY order, which is
    // precisely the 2026-08-04 failure this codebase already took once.
    // Falling back to "no picks" degrades to the tag-only gate instead.
    Promise.resolve<{ count?: number | null }>(
      sb
        .from("orders")
        .select("id", { count: "exact", head: true })
        .not("worklist_at", "is", null)
        .is("deleted_at", null)
    ).catch(() => ({ count: 0 })),
  ]);
  return {
    activeTags: (settings.data?.active_order_tags as string[] | null) ?? [],
    anyExplicitPicks: (picks.count ?? 0) > 0,
  };
}

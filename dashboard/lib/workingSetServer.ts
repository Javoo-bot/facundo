import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeCountryCode } from "@/lib/orderTags";

export interface WorkingSetConfig {
  /** app_settings.active_order_tags — automatic tag criterion. */
  activeTags: string[];
  /** app_settings.active_order_countries — automatic destination-country criterion. */
  activeCountries: string[];
  /** Explicit global automatic criterion; applies only to still-live orders. */
  runAllOrders: boolean;
  /** Whether ANY order currently carries a non-null worklist_at. */
  anyExplicitPicks: boolean;
}

/** Read the working-set inputs in one parallel round trip:
 * - app_settings.active_order_tags
 * - app_settings.active_order_countries
 * - app_settings.run_all_orders
 * - whether ANY order is explicitly picked via orders.worklist_at
 *
 * Explicit picks are first-class working-set membership. Automatic criteria
 * (run-all, countries, tags) are filtered by delivery_at in workingSetOrClause so
 * changing settings cannot revive stale/past-delivery orders into the control
 * panel. */
export async function workingSetConfig(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- both builds' clients are loosely typed
  sb: SupabaseClient<any, any, any>,
): Promise<WorkingSetConfig> {
  const [settings, picks] = await Promise.all([
    Promise.resolve<{ data?: { active_order_tags?: unknown; active_order_countries?: unknown; run_all_orders?: unknown } | null }>(
      sb.from("app_settings").select("active_order_tags, active_order_countries, run_all_orders").eq("id", 1).maybeSingle()
    ).catch(() => ({ data: null })),
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
    activeCountries: (settings.data?.active_order_countries as string[] | null) ?? [],
    runAllOrders: (settings.data?.run_all_orders as boolean | null) ?? false,
    anyExplicitPicks: (picks.count ?? 0) > 0,
  };
}

/** The PostgREST `.or()` clause that expresses the working set in SQL, or null
 * when the working set should not narrow the list.
 *
 * Semantics:
 * - explicit manual picks (`worklist_at`) are always included until a terminal
 *   state clears them;
 * - automatic picks (`run_all_orders`, country, tag) include only future/null
 *   delivery_at orders, so stale orders do not re-enter just because settings
 *   changed;
 * - empty tags + empty countries + run_all=false does not auto-include anything. */
export function workingSetOrClause(
  cfg: WorkingSetConfig,
  sanitize: (v: string) => string,
  nowIso: string = new Date().toISOString(),
): string | null {
  const parts: string[] = [];
  if (cfg.anyExplicitPicks) parts.push("worklist_at.not.is.null");

  const autoCriteria: string[] = [];
  if (cfg.runAllOrders) autoCriteria.push("id.not.is.null");
  autoCriteria.push(...cfg.activeTags.map(sanitize).filter(Boolean).map((t) => `tags.ilike.*${t}*`));
  autoCriteria.push(...cfg.activeCountries
    .map((c) => normalizeCountryCode(c))
    .filter((c): c is string => c != null)
    .map((c) => `delivery_address->>country.eq.${sanitize(c)}`));

  for (const criterion of autoCriteria) {
    parts.push(`and(delivery_at.gt."${nowIso}",${criterion})`);
  }

  return parts.length ? parts.join(",") : null;
}

import { extractDeliveryCountry, isInWorkingSet, type WorkingSetOrderInput } from "./orderTags.ts";
import type { WorkingSetConfig } from "./workingSetServer";

export type WorkingSetDecision = "in" | "out" | "fail-open";

export async function orderWorkingSetDecision(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- callers pass service-role Supabase clients from different typed builds
  sb: any,
  orderId: string,
  cfg: WorkingSetConfig,
  context: string,
  capture: (context: string, error: unknown) => void,
): Promise<WorkingSetDecision> {
  try {
    const { data, error } = await sb
      .from("orders")
      .select("tags, delivery_address, delivery_at, worklist_at")
      .eq("id", orderId)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) throw error;
    if (!data) return "out";
    const order: WorkingSetOrderInput = {
      tags: data.tags as string | null,
      deliveryCountry: extractDeliveryCountry(data.delivery_address as Record<string, unknown> | null),
      deliveryAt: data.delivery_at as string | null,
      hasExplicitPick: data.worklist_at != null,
    };
    return isInWorkingSet(order, {
      activeOrderTags: cfg.activeTags,
      activeOrderCountries: cfg.activeCountries,
      runAllOrders: cfg.runAllOrders,
    }) ? "in" : "out";
  } catch (e) {
    capture(context, e);
    return "fail-open";
  }
}

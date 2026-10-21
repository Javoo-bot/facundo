import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { Env } from "./types";
import { createServiceClient, upsertOrder, replaceLineItems, appendOrderEvent, findCityIdForOrder } from "./db";
import { parseShopifyOrder } from "./shopify";
import { fetchVariantDetails } from "./shopifyImages";
import { isInWorkingSet, extractDeliveryCountry } from "./tags";
import { matchAndWriteCandidates, loadWorkingSetCriteria } from "./lateMatch";
import { captureAutomationEvent, ORDER_WORKFLOW_STEP_FAILED } from "./analytics";

/** Runs `step.do`, and on a step's terminal failure (after Workflow's own
 * built-in per-step retries are exhausted) fires an ORDER_WORKFLOW_STEP_FAILED
 * event before rethrowing so the Workflow's failure/retry-instance handling is
 * unchanged — this is purely an observability tap. */
async function runStep<T extends Rpc.Serializable<T>>(
  env: Env,
  distinctId: string,
  step: WorkflowStep,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await step.do(name, fn);
  } catch (e) {
    await captureAutomationEvent(env, ORDER_WORKFLOW_STEP_FAILED, distinctId, {
      step: name,
      message: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}

export class OrderWorkflow extends WorkflowEntrypoint<Env, { raw: unknown }> {
  async run(event: WorkflowEvent<{ raw: unknown }>, step: WorkflowStep) {
    const sb = createServiceClient(this.env);
    // Also the Workflow instance id (see index.ts's queue consumer) — the
    // stablest per-order identifier available before the order is even upserted.
    const shopifyOrderId = String((event.payload.raw as { id?: unknown } | null)?.id ?? "unknown-order");
    const parsed = (await runStep(this.env, shopifyOrderId, step, "parse", async (): Promise<any> => parseShopifyOrder(event.payload.raw))) as ReturnType<typeof parseShopifyOrder>;

    // Carry cityId out of this step so the match step doesn't have to re-derive it.
    const { orderId, cityId } = await runStep(this.env, shopifyOrderId, step, "upsert-order", async () => {
      const cityId = await findCityIdForOrder(sb, parsed.order);           // by delivery city, best-effort
      const id = await upsertOrder(sb, { ...parsed.order, city_id: cityId });

      // The REST webhook payload never carries a line-item's image, recipe,
      // components/add-ons, or the customer-facing "Includes" blurb (see
      // shopify.ts's own header comment) — one extra GraphQL round trip backfills
      // all of it from each line item's variant/product data. Best-effort: skipped
      // entirely if the Admin API isn't configured for this environment (see
      // reconcile.ts).
      const rawLineItems = (event.payload.raw as { line_items?: Array<{ variant_id?: unknown }> } | null)?.line_items ?? [];
      if (this.env.SHOPIFY_SHOP && this.env.SHOPIFY_ADMIN_TOKEN) {
        const variantIds = rawLineItems.map((li) => li.variant_id).filter((v): v is number | string => v != null).map(String);
        const detailsByVariant = await fetchVariantDetails(this.env.SHOPIFY_SHOP, this.env.SHOPIFY_ADMIN_TOKEN, variantIds);
        parsed.items.forEach((item: (typeof parsed.items)[number], i: number) => {
          const variantId = rawLineItems[i]?.variant_id;
          const d = variantId != null ? detailsByVariant.get(String(variantId)) : undefined;
          if (!d) return;
          item.image_url = d.imageUrl ?? item.image_url;
          item.barcode = d.barcode;
          item.bouquet_spec = d.recipe;
          item.variant_text = d.variantText;
          item.variant_icon_url = d.variantIconUrl;
          item.components = d.components;
          item.addons = d.addons;
        });
      }

      await replaceLineItems(sb, id, parsed.items);
      await appendOrderEvent(sb, id, "received");
      return { orderId: id, cityId };
    });

    // Working-set gate: only orders in scope per app_settings' active tags /
    // active countries / run_all_orders get matched/worked — everything else
    // still gets ingested (upsert-order above already ran unconditionally, so
    // it's listed) but is left at status "received" rather than being matched
    // or escalated. See tags.ts::isInWorkingSet (duplicated in
    // dashboard/lib/orderTags.ts — the worker and dashboard are separate
    // builds) and Settings → Working set.
    const criteria = await runStep(this.env, shopifyOrderId, step, "load-working-set-criteria", () => loadWorkingSetCriteria(sb));
    const deliveryCountry = extractDeliveryCountry(parsed.order.delivery_address);
    if (!isInWorkingSet({ tags: parsed.order.tags, deliveryCountry, deliveryAt: parsed.order.delivery_at }, criteria)) {
      await runStep(this.env, shopifyOrderId, step, "skip-match", async () => {
        await appendOrderEvent(sb, orderId, "match_skipped", {
          reason: "not in working set", tags: parsed.order.tags, deliveryCountry, deliveryAt: parsed.order.delivery_at,
        });
      });
      return; // stays at "received" — no match, no candidates, no escalation
    }

    // Match + write candidates + advance status (or file a semi-mode approval).
    // Shared with the late-tag path (orders/updated + the reconcile sweep) so an
    // order matched late produces an identical result. See lib/lateMatch.ts.
    await runStep(this.env, shopifyOrderId, step, "match-and-write", async () => {
      await matchAndWriteCandidates(sb, {
        orderId,
        cityId,
        deliveryLat: parsed.order.delivery_lat,
        deliveryLng: parsed.order.delivery_lng,
        deliveryAt: parsed.order.delivery_at,
        orderTotal: parsed.order.total ?? 0,
        deliveryAddress: parsed.order.delivery_address,
      }, this.env);
    });
  }
}

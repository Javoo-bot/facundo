import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "../supabaseAdmin";
import { fetchShopifyTranslations } from "./shopify";
import { personaliseRecruitingEmail, DEFAULT_RECRUITING_MODEL } from "../recruitingPersonalise";
import {
  sourceHash, checkContent, buildContentPrompt, parseContentReply,
  type ContentRequest, type TranslatableField,
} from "./content";
import { DEFAULT_LOCALE, type Locale } from "../i18n";
import type { OrderLineItem } from "../types";
import { agentSpec } from "../agents/registry.generated";

/**
 * The line items of an order, rendered in the florist's own language.
 *
 * Three sources, in order, each only for what the one before it didn't answer:
 *
 *   1. `content_translations` — everything already resolved, keyed by a hash of
 *      the English source so a changed source can never hit a stale row.
 *   2. Shopify's own translations. They cover ~83% of the recipes on the
 *      products in our real orders and are written by the merchandising team,
 *      so they win over anything we could draft.
 *   3. One batched model call for the rest, cached back into (1) so it is paid
 *      for once per string per locale, ever.
 *
 * Anything that fails, times out, or fails checkContent() stays ENGLISH. That
 * is the whole safety story: a florist who reads English builds the right
 * bouquet slowly; a florist who reads a wrong number builds the wrong bouquet.
 * Never throws — a translation problem must not take down an offer page.
 */
export async function localiseLineItems(
  items: OrderLineItem[],
  locale: Locale,
  opts: { deadlineMs?: number; allowModel?: boolean } = {}
): Promise<OrderLineItem[]> {
  if (locale === DEFAULT_LOCALE || !items.length) return items;
  try {
    return await localise(items, locale, opts.deadlineMs ?? 6_000, opts.allowModel ?? false);
  } catch {
    return items;
  }
}

/**
 * Fill the cache for one order in one locale, model leg included.
 *
 * Called when an offer is SENT, not when it is opened, because the model leg
 * is genuinely slow — a measured 10.3s for one order's recipe, components and
 * add-ons — and a florist tapping a link from an SMS must not wait for it.
 * Doing it at send time means the page render is a cache hit by the time they
 * arrive, typically seconds to minutes later.
 *
 * Runs AFTER the offer's own email/SMS have gone out, so it delays nothing the
 * florist is waiting on. Never throws: a translation that didn't warm shows in
 * English, which is exactly what happened before any of this existed.
 */
export async function warmLineItemTranslations(
  admin: SupabaseClient,
  orderId: string,
  locale: Locale
): Promise<void> {
  if (locale === DEFAULT_LOCALE) return;
  try {
    const { data } = await admin.from("order_line_items").select("*").eq("order_id", orderId);
    const items = (data ?? []) as OrderLineItem[];
    if (items.length) await localise(items, locale, 45_000, true);
  } catch {
    // best-effort by design — see the doc comment
  }
}

/** Which line-item column each translatable field lives in. */
const FIELD_COLUMN: Record<TranslatableField, keyof OrderLineItem> = {
  title: "title",
  variant: "variant",
  recipe: "bouquet_spec",
  components: "components",
  addons: "addons",
};

type Need = { field: TranslatableField; source: string; hash: string; key: string };

const cacheKey = (field: TranslatableField, hash: string) => `${field}:${hash}`;

async function localise(
  items: OrderLineItem[], locale: Locale, deadlineMs: number, allowModel: boolean
): Promise<OrderLineItem[]> {
  const startedAt = Date.now();
  const left = () => deadlineMs - (Date.now() - startedAt);

  // 1. What this page needs, deduped. Two line items sharing a recipe (the
  //    Classic and Premium sizes of one bouquet often do) ask once.
  const needs = new Map<string, Need>();
  for (const item of items) {
    for (const field of Object.keys(FIELD_COLUMN) as TranslatableField[]) {
      const source = (item[FIELD_COLUMN[field]] as string | null) ?? "";
      if (!source.trim()) continue;
      const hash = sourceHash(source);
      const key = cacheKey(field, hash);
      if (!needs.has(key)) needs.set(key, { field, source, hash, key });
    }
  }
  if (!needs.size) return items;

  const resolved = new Map<string, string>();   // key -> translated value
  const admin = createServiceClient();

  // 2. Cache.
  const { data: cached } = await admin
    .from("content_translations")
    .select("field, source_hash, value")
    .eq("locale", locale)
    .in("source_hash", [...new Set([...needs.values()].map((n) => n.hash))]);
  for (const row of cached ?? []) {
    const key = cacheKey(row.field as TranslatableField, row.source_hash as string);
    if (needs.has(key)) resolved.set(key, row.value as string);
  }

  // Rows to write back at the end — cache misses only, so a page that was fully
  // cached touches the database once and writes nothing.
  const fresh: Array<{
    field: string; source_hash: string; locale: string; value: string; provider: string; source_text: string;
    ai_context: Record<string, unknown> | null;
  }> = [];
  // What Babel was shown, on every row its one batched call answered.
  let llmContext: Record<string, unknown> | null = null;
  const accept = (need: Need, value: string, provider: "shopify" | "llm"): boolean => {
    if (checkContent(need.field, need.source, value).length) return false;
    resolved.set(need.key, value.trim());
    fresh.push({
      field: need.field, source_hash: need.hash, locale, value: value.trim(),
      provider, source_text: need.source, ai_context: provider === "llm" ? llmContext : null,
    });
    return true;
  };

  const missing = () => [...needs.values()].filter((n) => !resolved.has(n.key));

  // 3. Shopify's own translations, for the three fields it can answer: the
  //    product title, the variant name, and the recipe metafield.
  //    `components`/`addons` are comma-joined titles of OTHER products with no
  //    id of their own on our side, so they go straight to the model.
  const shop = process.env.SHOPIFY_SHOP || process.env.SHOPIFY_STORE || "";
  const token = process.env.SHOPIFY_ADMIN_TOKEN || "";
  const shopifyFields: TranslatableField[] = ["title", "variant", "recipe"];
  const wantShopify = missing().filter((n) => shopifyFields.includes(n.field));
  if (wantShopify.length && shop && token && left() > 2_000) {
    const byTitle = new Map<string, Need[]>();   // product_id -> needs
    const byRecipe = new Map<string, Need[]>();  // variant_id -> needs
    // product_id -> the English variant names on this page and what they need.
    // Keyed by name because a variant name is a PRODUCT_OPTION_VALUE hanging
    // off the product, so this resolves without `variant_id` — which the rows
    // imported before 2026-08-06 don't have.
    const byVariant = new Map<string, Map<string, Need>>();
    for (const item of items) {
      const pid = item.catalog_id ?? "";
      const vid = item.variant_id ?? "";
      const need = (field: TranslatableField, source: string | null): Need | undefined => {
        if (!source?.trim()) return undefined;
        const n = needs.get(cacheKey(field, sourceHash(source)));
        return n && !resolved.has(n.key) ? n : undefined;
      };
      const titleNeed = need("title", item.title);
      const variantNeed = need("variant", item.variant);
      const recipeNeed = need("recipe", item.bouquet_spec);
      if (pid && titleNeed) byTitle.set(pid, [...(byTitle.get(pid) ?? []), titleNeed]);
      if (pid && variantNeed && item.variant) {
        const byName = byVariant.get(pid) ?? new Map<string, Need>();
        byName.set(item.variant, variantNeed);
        byVariant.set(pid, byName);
      }
      if (vid && recipeNeed) byRecipe.set(vid, [...(byRecipe.get(vid) ?? []), recipeNeed]);
    }
    const got = await fetchShopifyTranslations({
      shop, token, locale,
      productIds: [...new Set([...byTitle.keys(), ...byVariant.keys()])],
      variantIds: [...byRecipe.keys()],
      timeoutMs: Math.min(5_000, Math.max(1_000, left() - 1_000)),
    });
    // What Shopify's `outdated` flag is worth depends on the field.
    //
    // On a RECIPE it is disqualifying on sight. The florist buys from this
    // list, and a recipe whose source moved on is exactly the case that
    // produced "15 roses" against an English 12 with the chocolates, vase,
    // teddy and card all missing. Send it to the model, which translates the
    // recipe we actually hold.
    //
    // On a TITLE it is only a hint. A title is a label, not an instruction, and
    // the flag fires on edits far too small to matter — the fr, de and pt-BR
    // titles of the very product above are flagged and are perfectly good. Drop
    // those and we discard merchandising's own wording and pay a model to
    // reinvent it, worse. So an outdated title is allowed through, and stands
    // or falls on checkContent() like everything else.
    for (const [pid, ns] of byTitle) {
      const t = got.titles.get(pid);
      if (t) for (const n of ns) accept(n, t.value, "shopify");
    }
    // A variant name is a label like a title, so it follows the title rule on
    // `outdated`: the fr/es names of the very product this was reported on
    // ("Best Value - Deluxe" → "De luxe" / "De lujo") are flagged and are
    // exactly what a florist should read.
    for (const [pid, byName] of byVariant) {
      const available = got.variants.get(pid);
      if (!available) continue;
      for (const [englishName, need] of byName) {
        const t = available.get(englishName);
        if (t) accept(need, t.value, "shopify");
      }
    }
    for (const [vid, ns] of byRecipe) {
      const t = got.recipes.get(vid);
      if (t && !t.outdated) for (const n of ns) accept(n, t.value, "shopify");
    }
  }

  // 4. One batched model call for whatever is left — only when the caller has
  //    the budget for it. A page render never does (see warmLineItemTranslations).
  const apiKey = process.env.OPENROUTER_API_KEY;
  const stillMissing = allowModel ? missing() : [];
  if (stillMissing.length && apiKey && left() > 3_000) {
    const requests: ContentRequest[] = stillMissing.map((n) => ({ id: n.hash, field: n.field, source: n.source }));
    const prompt = buildContentPrompt(requests, locale);
    const model = process.env.OPENROUTER_TRANSLATION_MODEL || DEFAULT_RECRUITING_MODEL;
    const reply = await personaliseRecruitingEmail({
      prompt,
      apiKey,
      model,
      requireSubjectLine: false,
      timeoutMs: Math.max(2_000, left() - 500),
      trace: { agent: "babel", sessionId: items[0].order_id, metadata: { locale, strings: requests.length } },
    });
    if (reply) {
      llmContext = { agent: "babel", prompt, model, rulesHash: agentSpec("babel").rulesHash };
      const parsed = parseContentReply(reply, requests.map((r) => r.id));
      for (const need of stillMissing) {
        const v = parsed.get(need.hash);
        if (v) accept(need, v, "llm");
      }
    }
  }

  // 5. Persist the misses. `ignoreDuplicates` because two requests for the same
  //    new string can race — either row is equally valid, and neither caller
  //    should fail over losing that race.
  if (fresh.length) {
    await admin
      .from("content_translations")
      .upsert(fresh, { onConflict: "field,source_hash,locale", ignoreDuplicates: true });
  }

  // 6. Apply. Untouched fields keep their English, which every downstream
  //    component already renders correctly.
  return items.map((item) => {
    const out = { ...item };
    for (const field of Object.keys(FIELD_COLUMN) as TranslatableField[]) {
      const column = FIELD_COLUMN[field];
      const source = (item[column] as string | null) ?? "";
      if (!source.trim()) continue;
      const value = resolved.get(cacheKey(field, sourceHash(source)));
      if (value) (out[column] as unknown as string) = value;
    }
    return out;
  });
}

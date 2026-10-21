#!/usr/bin/env node
// Repairs order_line_items rows whose variant-lookup columns were wiped.
//
// Background: refreshFromShopify (#155) re-parsed the REST webhook payload and
// called replaceLineItems with it. parseShopifyOrder hard-codes image_url,
// barcode, bouquet_spec, variant_text, variant_icon_url, components and addons
// to null — those only ever come from the follow-up GraphQL variant lookup,
// which only the intake path runs. Since orders/updated fires on ANY mutation,
// every one of them overwrote enriched rows with nulls. The forward fix is in
// src/db.ts (replaceLineItems now preserves them); this restores what was lost.
//
// Recoverable because `orders.raw` retains the Shopify payload, so each line
// item's variant_id is still available to re-run the lookup.
//
// Idempotent and resumable: only touches rows that are still missing a value,
// only fills nulls, and re-running after a partial pass just continues.
//
// Usage:
//   node scripts/backfill-line-item-details.mjs --dry-run          # report only
//   node scripts/backfill-line-item-details.mjs --limit 50         # small live batch first
//   node scripts/backfill-line-item-details.mjs                    # full run
//
// Env (same values the worker uses):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SHOPIFY_SHOP, SHOPIFY_ADMIN_TOKEN
// Flags: --dry-run, --limit N, --batch N (orders per pass, default 100)

const API_VERSION = "2024-07"; // keep in step with src/shopifyImages.ts
const VARIANTS_PER_QUERY = 50; // Shopify caps nodes(ids:) at 250; 50 keeps query cost low
const SHOPIFY_PAUSE_MS = 250;  // ~4 GraphQL calls/sec — well inside the cost-based limit

const ENRICHED_COLUMNS = [
  "image_url", "barcode", "bouquet_spec", "variant_text", "variant_icon_url", "components", "addons",
];

function parseArgs(argv) {
  const out = { batch: 100 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--batch") out.batch = Number(argv[++i]);
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

/** Pure: map a stored line item to the variant_id that produced it, using the
 * order's raw Shopify payload. Matches on sku first (Shopify sends it on every
 * line item), then title+variant_title, then falls back to position — the same
 * identity replaceLineItems uses. Unit-tested; see
 * test/backfill-line-item-details.test.ts. */
export function resolveVariantIds(storedItems, rawLineItems) {
  const bySku = new Map();
  const byTitle = new Map();
  (rawLineItems ?? []).forEach((li) => {
    if (li?.variant_id == null) return;
    const vid = String(li.variant_id);
    if (li.sku && !bySku.has(li.sku)) bySku.set(li.sku, vid);
    const k = `${li.title ?? ""}|${li.variant_title ?? ""}`;
    if (!byTitle.has(k)) byTitle.set(k, vid);
  });
  return storedItems.map((item, idx) => {
    let variantId = null;
    if (item.sku && bySku.has(item.sku)) variantId = bySku.get(item.sku);
    else {
      const k = `${item.title ?? ""}|${item.variant ?? ""}`;
      if (byTitle.has(k)) variantId = byTitle.get(k);
      else if (rawLineItems?.[idx]?.variant_id != null) variantId = String(rawLineItems[idx].variant_id);
    }
    return { id: item.id, variantId };
  });
}

/** Pure: given a line item and the resolved variant details, produce the patch
 * of columns to write — only ever FILLING a null, never overwriting a value
 * that survived. Returns null when there is nothing to do. */
export function buildPatch(item, details) {
  if (!details) return null;
  const patch = {};
  for (const col of ENRICHED_COLUMNS) {
    if (item[col] == null && details[col] != null) patch[col] = details[col];
  }
  return Object.keys(patch).length ? patch : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sb(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`supabase ${method} ${path}: ${res.status} ${await res.text().catch(() => "")}`);
  return res.status === 204 ? null : res.json();
}

const VARIANT_QUERY = `
  query VariantDetails($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        barcode
        image { url }
        product { featuredImage { url } }
        recipe: metafield(namespace: "custom", key: "recipe") { value }
        variantText: metafield(namespace: "custom", key: "variant_text") { value }
        variantIcon: metafield(namespace: "custom", key: "variant_icon") {
          reference { ... on MediaImage { image { url } } }
        }
        components: metafield(namespace: "custom", key: "components") {
          references(first: 20) { nodes { ... on Product { title } } }
        }
        addons: metafield(namespace: "custom", key: "addons") {
          references(first: 20) { nodes { ... on Product { title } } }
        }
      }
    }
  }`;

const joinTitles = (ref) => {
  const names = (ref?.references?.nodes ?? []).map((n) => n.title).filter(Boolean);
  return names.length ? names.join(", ") : null;
};

/** Fetch variant details from Shopify, keyed by numeric variant id. Mirrors
 * src/shopifyImages.ts::fetchVariantDetails — but here a failure is surfaced,
 * not swallowed: a backfill that silently no-ops is worse than one that stops. */
async function fetchVariantDetails(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += VARIANTS_PER_QUERY) {
    const chunk = ids.slice(i, i + VARIANTS_PER_QUERY);
    const res = await fetch(`https://${process.env.SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: VARIANT_QUERY,
        variables: { ids: chunk.map((id) => `gid://shopify/ProductVariant/${id}`) },
      }),
    });
    if (res.status === 429) { // throttled — back off and retry this chunk once
      await sleep(2000);
      i -= VARIANTS_PER_QUERY;
      continue;
    }
    if (!res.ok) throw new Error(`shopify graphql ${res.status}: ${await res.text().catch(() => "")}`);
    const json = await res.json();
    if (json.errors) throw new Error(`shopify graphql errors: ${JSON.stringify(json.errors)}`);
    for (const node of json?.data?.nodes ?? []) {
      if (!node) continue;
      out.set(node.id.split("/").pop(), {
        image_url: node.image?.url ?? node.product?.featuredImage?.url ?? null,
        barcode: node.barcode ?? null,
        bouquet_spec: node.recipe?.value ?? null,
        variant_text: node.variantText?.value ?? null,
        variant_icon_url: node.variantIcon?.reference?.image?.url ?? null,
        components: joinTitles(node.components),
        addons: joinTitles(node.addons),
      });
    }
    await sleep(SHOPIFY_PAUSE_MS);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.error("Usage: node scripts/backfill-line-item-details.mjs [--dry-run] [--limit N] [--batch N]");
    return;
  }
  for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SHOPIFY_SHOP", "SHOPIFY_ADMIN_TOKEN"]) {
    if (!process.env[k]) { console.error(`Missing env var ${k}`); process.exitCode = 1; return; }
  }
  if (args.dryRun) console.log("DRY RUN — no writes.\n");

  let offset = 0, ordersSeen = 0, itemsPatched = 0, ordersPatched = 0, unresolved = 0;
  const started = Date.now();

  while (true) {
    if (args.limit && ordersSeen >= args.limit) break;
    const take = args.limit ? Math.min(args.batch, args.limit - ordersSeen) : args.batch;

    // Orders that still have at least one line item missing an image. `raw` is
    // what makes the repair possible, so orders without it are skipped.
    const rows = await sb(
      `orders?select=id,order_name,raw,order_line_items!inner(id,title,variant,sku,${ENRICHED_COLUMNS.join(",")})` +
      `&order_line_items.image_url=is.null&raw=not.is.null&order=created_at.desc&limit=${take}&offset=${offset}`,
    );
    if (!rows.length) break;
    ordersSeen += rows.length;
    // A repaired order stops matching `image_url is null`, so the result set
    // shrinks under us. Advance the cursor only past the orders we did NOT fix
    // (unresolvable ones, which would otherwise loop forever) — in --dry-run
    // nothing is fixed, so this advances by the full page as you'd expect.
    let patchedInBatch = 0;

    for (const order of rows) {
      const items = order.order_line_items ?? [];
      const rawLineItems = order.raw?.line_items ?? [];
      const resolved = resolveVariantIds(items, rawLineItems);
      const ids = [...new Set(resolved.map((r) => r.variantId).filter(Boolean))];
      if (!ids.length) { unresolved += items.length; continue; }

      let details;
      try {
        details = await fetchVariantDetails(ids);
      } catch (e) {
        console.error(`\n${order.order_name}: ${e.message}`);
        console.error("Stopping so the failure isn't silently skipped — re-run to resume.");
        process.exitCode = 1;
        return;
      }

      let patchedHere = 0;
      for (const item of items) {
        const vid = resolved.find((r) => r.id === item.id)?.variantId;
        const patch = buildPatch(item, vid ? details.get(vid) : null);
        if (!patch) continue;
        if (!args.dryRun) {
          await sb(`order_line_items?id=eq.${item.id}`, {
            method: "PATCH", body: patch, headers: { Prefer: "return=minimal" },
          });
        }
        patchedHere++; itemsPatched++;
      }
      if (patchedHere) { ordersPatched++; if (!args.dryRun) patchedInBatch++; }
      const tag = args.dryRun ? "would patch" : "patched";
      if (patchedHere) console.log(`${order.order_name}: ${tag} ${patchedHere}/${items.length} line items`);
    }
    offset += rows.length - patchedInBatch;
    console.log(`… ${ordersSeen} orders scanned, ${itemsPatched} line items ${args.dryRun ? "to fix" : "fixed"}`);
  }

  const secs = Math.round((Date.now() - started) / 1000);
  console.log(
    `\nDone in ${secs}s — scanned ${ordersSeen} orders, ` +
    `${args.dryRun ? "would fix" : "fixed"} ${itemsPatched} line items across ${ordersPatched} orders.`,
  );
  if (unresolved) console.log(`${unresolved} line items had no resolvable variant_id in orders.raw — left untouched.`);
  if (args.dryRun) console.log("Re-run without --dry-run to apply.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.stack ?? e); process.exitCode = 1; });
}

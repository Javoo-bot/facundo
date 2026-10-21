#!/usr/bin/env node
// Registers the Shopify webhook subscriptions the ingest-worker depends on
// (orders/create, orders/updated, orders/edited, orders/cancelled) against a custom app's
// Admin API. Idempotent: lists existing subscriptions first, and only
// creates what's missing or patches an existing one whose address has
// drifted (e.g. re-pointed at a new deploy) — safe to re-run any time.
//
// NOT run as part of this change — a standalone operator tool. See
// "Shopify setup" in ../DEPLOY.md for the full walkthrough (custom app
// creation, scopes, secrets).
//
// Usage:
//   node scripts/register-shopify-webhooks.mjs \
//     --shop your-store.myshopify.com \
//     --token shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxx \
//     --url https://facundo.<zone>/webhooks/shopify
//
// Flags may instead come from env vars: SHOPIFY_SHOP, SHOPIFY_ADMIN_TOKEN,
// SHOPIFY_WEBHOOK_URL. Flags take precedence over env vars.
//
// Requires: custom app installed on the shop with Admin API scopes
// `read_orders`, `write_orders` (webhooks.json needs read_orders at minimum;
// the worker itself needs write_orders for orders/cancelled's clawback path
// to be meaningful downstream — same token is reused for both).

const API_VERSION = "2024-07";
// orders/updated fires on any order mutation — we rely on it to catch tags a
// store app adds a few minutes after checkout (see src/lateMatch.ts).
const TOPICS = ["orders/create", "orders/updated", "orders/edited", "orders/cancelled"];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--shop") out.shop = argv[++i];
    else if (a === "--token") out.token = argv[++i];
    else if (a === "--url") out.url = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function usage() {
  console.error(
    [
      "Usage: node scripts/register-shopify-webhooks.mjs --shop <shop>.myshopify.com --token <admin-token> --url <https://.../webhooks/shopify>",
      "(or set SHOPIFY_SHOP / SHOPIFY_ADMIN_TOKEN / SHOPIFY_WEBHOOK_URL env vars)",
    ].join("\n"),
  );
}

// Pure: given the shop's existing webhook subscriptions and the target
// (topics, url), decide what to do for each topic — no I/O, so this is what
// gets unit-tested (see test/register-shopify-webhooks.test.ts).
export function planActions(existing, topics, url) {
  return topics.map((topic) => {
    const match = existing.find((w) => w.topic === topic && w.format === "json");
    if (!match) return { topic, kind: "create" };
    if (match.address === url) return { topic, kind: "skip", id: match.id };
    return { topic, kind: "repoint", id: match.id, from: match.address };
  });
}

async function listExisting(base, headers) {
  const res = await fetch(`${base}/webhooks.json?limit=250`, { headers });
  if (!res.ok) {
    throw new Error(`GET webhooks.json failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const body = await res.json();
  return body.webhooks ?? [];
}

async function createWebhook(base, headers, topic, url) {
  const res = await fetch(`${base}/webhooks.json`, {
    method: "POST",
    headers,
    body: JSON.stringify({ webhook: { topic, address: url, format: "json" } }),
  });
  if (!res.ok) {
    return { ok: false, detail: `${res.status} ${await res.text().catch(() => "")}` };
  }
  const { webhook } = await res.json();
  return { ok: true, id: webhook.id };
}

async function repointWebhook(base, headers, id, url) {
  const res = await fetch(`${base}/webhooks/${id}.json`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ webhook: { id, address: url } }),
  });
  if (!res.ok) return { ok: false, detail: `${res.status} ${await res.text().catch(() => "")}` };
  return { ok: true };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return; }

  const shop = args.shop ?? process.env.SHOPIFY_SHOP;
  const token = args.token ?? process.env.SHOPIFY_ADMIN_TOKEN;
  const url = args.url ?? process.env.SHOPIFY_WEBHOOK_URL;

  if (!shop || !token || !url) {
    usage();
    process.exitCode = 1;
    return;
  }

  const base = `https://${shop}/admin/api/${API_VERSION}`;
  const headers = { "X-Shopify-Access-Token": token, "Content-Type": "application/json" };

  const existing = await listExisting(base, headers);
  const plan = planActions(existing, TOPICS, url);

  const results = [];
  for (const step of plan) {
    if (step.kind === "skip") {
      results.push({ topic: step.topic, action: "already registered (skip)", id: step.id });
      continue;
    }
    if (step.kind === "create") {
      const r = await createWebhook(base, headers, step.topic, url);
      results.push({ topic: step.topic, action: r.ok ? "created" : `FAILED create (${r.detail})`, id: r.id });
      continue;
    }
    // repoint
    const r = await repointWebhook(base, headers, step.id, url);
    results.push({
      topic: step.topic,
      action: r.ok ? `re-pointed ${step.from} -> ${url}` : `FAILED re-point (${r.detail})`,
      id: step.id,
    });
  }

  console.log(`\nShopify webhook registration — shop=${shop}`);
  console.log(`target url=${url}\n`);
  for (const r of results) {
    console.log(`  ${r.topic.padEnd(18)} ${r.action}${r.id != null ? ` [id ${r.id}]` : ""}`);
  }

  const failed = results.some((r) => r.action.startsWith("FAILED"));
  if (failed) {
    console.error("\nOne or more webhook registrations failed — see above.");
    process.exitCode = 1;
    return;
  }
  console.log("\nDone.");
}

// Only auto-run when executed directly (`node scripts/register-shopify-webhooks.mjs`),
// not when imported — e.g. by test/register-shopify-webhooks.test.ts, which
// imports `planActions` for pure unit tests without touching the network.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.stack ?? e.message : e);
    process.exitCode = 1;
  });
}

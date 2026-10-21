#!/usr/bin/env node
// Staged, reversible live test of the two fulfilment writes against ONE order.
//
// Runs in phases so the irreversible step is never reached by accident:
//
//   --phase swap     save the real email to disk, then point the order at a
//                    safe inbox. Reversible. Must succeed before anything else.
//   --phase write    fulfillmentCreateV2 + fulfillmentEventCreate. The
//                    fulfilment is NOT deletable afterwards (only cancellable).
//   --phase restore  put the real email back, from the file written by `swap`.
//   --phase check    read-only inspect.
//
// WHY THE EMAIL SWAP MATTERS HERE: Shopify's own `notifyCustomer: false` does
// NOT make this safe. Customer mail on this store is sent by Mechanic tasks
// reacting to `orders/updated` and pushing to Ongage — an architecture that
// never sees, and cannot respect, that Shopify flag. Pointing the order at a
// monitored inbox first means any surprise send lands somewhere harmless
// instead of on a real customer.

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const API = "2024-07";
const SHOP = (process.env.SHOPIFY_SHOP || "").trim();
const TOKEN = (process.env.SHOPIFY_ADMIN_TOKEN || "").trim();

const arg = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };
const ORDER = arg("--order");
const PHASE = arg("--phase");
const SAFE_EMAIL = arg("--safe-email") || "owner@fc.example.com";
const STATE = join(process.cwd(), `.fulfilment-test-${ORDER}.json`);

if (!SHOP || !TOKEN || !ORDER || !PHASE) {
  console.error("usage: --order <id> --phase <swap|write|restore|check> [--safe-email addr]");
  process.exit(2);
}

const gq = async (query, variables) => {
  const r = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const b = await r.json().catch(() => null);
  if (b?.errors?.length) return { ok: false, error: b.errors.map((e) => e.message).join("; ") };
  if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
  return { ok: true, data: b?.data };
};

const gid = `gid://shopify/Order/${ORDER}`;
const ue = (e) => (Array.isArray(e) && e.length ? e.map((x) => `${x.field ?? ""} ${x.message}`.trim()).join("; ") : null);

const READ = `query($id:ID!){ order(id:$id){
  id name email displayFinancialStatus displayFulfillmentStatus closedAt
  fulfillmentOrders(first:10){ nodes{ id status supportedActions{action} } }
  fulfillments(first:10){ id status createdAt events(first:10){ nodes{ status happenedAt } } }
}}`;

async function read(label) {
  const o = (await gq(READ, { id: gid }))?.data?.order;
  if (!o) { console.error("  order not found"); process.exit(1); }
  console.log(`\n--- ${label} ---`);
  console.log(`  ${o.name}  email=${o.email}`);
  console.log(`  financial=${o.displayFinancialStatus}  fulfilment=${o.displayFulfillmentStatus}  archived=${o.closedAt ?? "no"}`);
  for (const f of o.fulfillmentOrders?.nodes ?? [])
    console.log(`  FO ${f.id.split("/").pop()} ${f.status} actions=[${f.supportedActions.map((a) => a.action).join(",")}]`);
  for (const f of o.fulfillments ?? []) {
    console.log(`  FULFILMENT ${f.id.split("/").pop()} status=${f.status} created=${f.createdAt}`);
    for (const e of f.events?.nodes ?? []) console.log(`     event ${e.status} @ ${e.happenedAt}`);
  }
  return o;
}

const SET_EMAIL = `mutation($input:OrderInput!){ orderUpdate(input:$input){ order{ id email } userErrors{ field message } } }`;

async function setEmail(to) {
  const out = await gq(SET_EMAIL, { input: { id: gid, email: to } });
  if (!out.ok) { console.error(`  FAILED: ${out.error}`); return false; }
  const err = ue(out.data?.orderUpdate?.userErrors);
  if (err) { console.error(`  REJECTED: ${err}`); return false; }
  console.log(`  email now: ${out.data?.orderUpdate?.order?.email}`);
  return true;
}

console.log(`shop=${SHOP}  order=${ORDER}  phase=${PHASE}`);

if (PHASE === "check") { await read("CURRENT"); process.exit(0); }

if (PHASE === "swap") {
  const before = await read("BEFORE");
  if (existsSync(STATE)) {
    console.error(`\n  REFUSING: ${STATE} already exists — a previous run saved an email that was never restored.`);
    console.error(`  Inspect it and run --phase restore first, so the real address cannot be lost.`);
    process.exit(1);
  }
  // Persist BEFORE mutating: if the swap succeeds and this process then dies,
  // the real address must still be recoverable from disk.
  writeFileSync(STATE, JSON.stringify({ order: ORDER, originalEmail: before.email, savedAt: new Date().toISOString() }, null, 2));
  console.log(`\n  saved original email to ${STATE}`);
  console.log(`\n=== WRITE: order email -> ${SAFE_EMAIL} ===`);
  if (!(await setEmail(SAFE_EMAIL))) process.exit(1);
  await read("AFTER SWAP");
  console.log(`\n  OK. Nothing irreversible has happened yet.`);
  process.exit(0);
}

if (PHASE === "restore") {
  if (!existsSync(STATE)) { console.error(`  no saved state at ${STATE}`); process.exit(1); }
  const { originalEmail } = JSON.parse(readFileSync(STATE, "utf8"));
  console.log(`\n=== WRITE: order email -> ${originalEmail} (restoring) ===`);
  if (!(await setEmail(originalEmail))) process.exit(1);
  await read("AFTER RESTORE");
  process.exit(0);
}

if (PHASE === "write") {
  const before = await read("BEFORE");
  // Refuse to fulfil unless the order is pointed at the safe inbox.
  if (before.email !== SAFE_EMAIL) {
    console.error(`\n  REFUSING: order email is ${before.email}, not ${SAFE_EMAIL}.`);
    console.error(`  Run --phase swap first. Customer mail here is sent by Mechanic->Ongage on`);
    console.error(`  orders/updated, which does not respect Shopify's notifyCustomer flag.`);
    process.exit(1);
  }

  const fulfillable = (before.fulfillmentOrders?.nodes ?? [])
    .filter((f) => f.supportedActions.some((a) => a.action === "CREATE_FULFILLMENT"))
    .map((f) => f.id);

  if (!fulfillable.length) {
    console.log("\n  nothing with CREATE_FULFILLMENT — skipping create (idempotent path).");
  } else {
    console.log(`\n=== WRITE: fulfillmentCreateV2 (${fulfillable.length} FO) — NOT REVERSIBLE ===`);
    const out = await gq(
      `mutation($f:FulfillmentV2Input!){ fulfillmentCreateV2(fulfillment:$f){ fulfillment{ id status } userErrors{ field message } } }`,
      { f: { lineItemsByFulfillmentOrder: fulfillable.map((id) => ({ fulfillmentOrderId: id })), notifyCustomer: false } }
    );
    if (!out.ok) { console.error(`  FAILED: ${out.error}`); process.exit(1); }
    const err = ue(out.data?.fulfillmentCreateV2?.userErrors);
    if (err) { console.error(`  REJECTED: ${err}`); process.exit(1); }
    console.log(`  OK: ${out.data.fulfillmentCreateV2.fulfillment.id} status=${out.data.fulfillmentCreateV2.fulfillment.status}`);
  }

  const mid = await read("AFTER FULFIL");
  const fid = mid.fulfillments?.[0]?.id;
  if (!fid) { console.error("\n  no fulfilment to attach an event to — stopping."); process.exit(1); }

  console.log(`\n=== WRITE: fulfillmentEventCreate OUT_FOR_DELIVERY ===`);
  const ev = await gq(
    `mutation($e:FulfillmentEventInput!){ fulfillmentEventCreate(fulfillmentEvent:$e){ fulfillmentEvent{ id status happenedAt } userErrors{ field message } } }`,
    { e: { fulfillmentId: fid, status: "OUT_FOR_DELIVERY", happenedAt: new Date().toISOString() } }
  );
  if (!ev.ok) console.error(`  FAILED: ${ev.error}`);
  else {
    const err = ue(ev.data?.fulfillmentEventCreate?.userErrors);
    if (err) console.error(`  REJECTED: ${err}`);
    else console.log(`  OK: ${JSON.stringify(ev.data.fulfillmentEventCreate.fulfillmentEvent)}`);
  }

  await read("AFTER EVENT");
  console.log(`\n  Now run --phase restore to put the real email back.`);
  process.exit(0);
}

console.error(`unknown phase: ${PHASE}`);
process.exit(2);

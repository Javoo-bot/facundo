// Drives the REAL lib/shopifyFulfillment.ts::fulfilOnAccept in dryRun mode
// against one order, so the thing being proven is the application's own code
// path — not a script that resembles it.
//
// Writes NOTHING to Shopify: the dry run sends fulfillmentCreateV2 with an empty
// line-item list, which Shopify rejects on validation. It does write one
// `fulfilment_create_dryrun` row to external_ops, which is the audit trail.
//
//   npx esbuild scripts/dryrun-accept.ts --bundle --platform=node --format=esm \
//     --outfile=<tmp>/dryrun.mjs && node <tmp>/dryrun.mjs <shopifyOrderId> <ourOrderId>

import { fulfilOnAccept, inspectOrder } from "../lib/shopifyFulfillment";

const shopifyOrderId = process.argv[2];
const orderId = process.argv[3];

if (!shopifyOrderId || !orderId) {
  console.error("usage: node dryrun.mjs <shopifyOrderId> <ourOrderUuid>");
  process.exit(2);
}

console.log(`shop        : ${process.env.SHOPIFY_SHOP}`);
console.log(`shopifyOrder: ${shopifyOrderId}`);
console.log(`our order   : ${orderId}`);
console.log("gate: app_settings.shopify_writeback_enabled  <- the dry run bypasses it by design\n");

console.log("=== 1. resolve the order (real code: inspectOrder) ===");
const probe = await inspectOrder(shopifyOrderId);
console.log(`  ok                 : ${probe.ok}${probe.error ? `  error=${probe.error}` : ""}`);
console.log(`  fulfillable (ours) : ${probe.fulfillable.length}  ${JSON.stringify(probe.fulfillable)}`);
console.log(`  CREATE_FULFILLMENT : ${probe.createAllowed.length}  ${JSON.stringify(probe.createAllowed)}`);
console.log(`  existing fulfilments: ${probe.existingFulfillmentIds.length}`);

const agree =
  probe.fulfillable.length === probe.createAllowed.length &&
  probe.fulfillable.every((id) => probe.createAllowed.includes(id));
console.log(`  our filter agrees with Shopify's permission: ${agree ? "YES" : "NO — investigate"}`);

console.log("\n=== 2. dry-run the write (real code: fulfilOnAccept, dryRun) ===");
const res = await fulfilOnAccept(shopifyOrderId, { orderId, actor: "dry-run", dryRun: true });
console.log(`  wouldSucceed : ${res.wouldSucceed}`);
console.log(`  diagnosis    : ${res.diagnosis}`);
console.log(`  skipped      : ${res.skipped}  (always true for a dry run)`);

console.log("\n=== 3. confirm nothing changed ===");
const after = await inspectOrder(shopifyOrderId);
console.log(`  fulfillable still  : ${after.fulfillable.length}`);
console.log(`  fulfilments still  : ${after.existingFulfillmentIds.length}`);
const unchanged =
  after.fulfillable.length === probe.fulfillable.length &&
  after.existingFulfillmentIds.length === probe.existingFulfillmentIds.length;
console.log(`  UNCHANGED: ${unchanged ? "YES" : "NO — something was written, investigate immediately"}`);

console.log(
  `\nVERDICT: ${
    res.wouldSucceed && unchanged
      ? "the accept -> Shopify status path WORKS and nothing was written."
      : "not proven — read the diagnosis above."
  }`
);

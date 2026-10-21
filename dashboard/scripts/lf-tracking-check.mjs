#!/usr/bin/env node
// READ-ONLY. Do local-florist orders currently get fulfilled WITH a tracking
// number? That decides whether the order_on_their_way guard changes today's
// behaviour or only future behaviour: the task sends its Ongage push the moment
// any fulfilment carries a tracking number, guard or no guard.
const API = "2024-07";
const SHOP = (process.env.SHOPIFY_SHOP || "").trim();
const TOKEN = (process.env.SHOPIFY_ADMIN_TOKEN || "").trim();
if (!SHOP || !TOKEN) { console.error("SHOPIFY_* required"); process.exit(2); }

const Q = `query($q:String!){ orders(first:50, query:$q, sortKey:CREATED_AT, reverse:true){ nodes{
  name createdAt displayFulfillmentStatus tags
  fulfillments(first:5){ id status trackingInfo{ number company url } }
}}}`;

const r = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, {
  method: "POST",
  headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
  body: JSON.stringify({ query: Q, variables: { q: 'tag:"Local-florist" fulfillment_status:fulfilled' } }),
});
const b = await r.json();
if (b.errors) { console.error(JSON.stringify(b.errors)); process.exit(1); }

const nodes = b.data?.orders?.nodes ?? [];
let withTracking = 0, without = 0;
const samples = [];
for (const o of nodes) {
  const tracked = (o.fulfillments ?? []).flatMap((f) => f.trackingInfo ?? []).filter((t) => t?.number);
  if (tracked.length) {
    withTracking++;
    if (samples.length < 8) samples.push(`${o.name} ${o.createdAt.slice(0,10)}  number="${tracked[0].number}" company="${tracked[0].company ?? ""}"`);
  } else without++;
}
console.log(`fulfilled Local-florist orders sampled: ${nodes.length}`);
console.log(`  WITH a tracking number : ${withTracking}   <- these get the Ongage "on the way" email today`);
console.log(`  without                : ${without}   <- these get nothing today`);
if (samples.length) { console.log("\nsamples with tracking:"); for (const s of samples) console.log("  " + s); }

#!/usr/bin/env node
// READ-ONLY. Find old, low-risk orders to practise the fulfilment writes on.
// Writes nothing. Usage: node scripts/find-old-order.mjs "<shopify search query>"

const API = "2024-07";
const SHOP = (process.env.SHOPIFY_SHOP || "").trim();
const TOKEN = (process.env.SHOPIFY_ADMIN_TOKEN || "").trim();
if (!SHOP || !TOKEN) { console.error("SHOPIFY_SHOP / SHOPIFY_ADMIN_TOKEN required"); process.exit(2); }

const search = process.argv[2] || "fulfillment_status:unfulfilled";
const Q = `
  query Find($q: String!) {
    orders(first: 25, query: $q, sortKey: CREATED_AT, reverse: false) {
      nodes {
        id name createdAt cancelledAt
        displayFinancialStatus displayFulfillmentStatus
        tags
        fulfillmentOrders(first: 5) { nodes { id status } }
      }
    }
  }`;

const res = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, {
  method: "POST",
  headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
  body: JSON.stringify({ query: Q, variables: { q: search } }),
});
const body = await res.json();
if (body.errors) { console.error("ERRORS:", JSON.stringify(body.errors)); process.exit(1); }

const nodes = body.data?.orders?.nodes ?? [];
console.log(`query: ${search}\nmatches shown: ${nodes.length}\n`);
for (const o of nodes) {
  const fos = o.fulfillmentOrders?.nodes ?? [];
  const open = fos.filter((f) => ["OPEN", "IN_PROGRESS"].includes(f.status)).length;
  const id = o.id.split("/").pop();
  console.log(
    `${o.name.padEnd(10)} ${o.createdAt.slice(0, 10)}  ${String(o.displayFinancialStatus).padEnd(18)}` +
    ` ${String(o.displayFulfillmentStatus).padEnd(12)} cancelled=${o.cancelledAt ? "YES" : "no "}` +
    `  FOs=${fos.length} open=${open}  id=${id}`
  );
}

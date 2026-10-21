#!/usr/bin/env node
// READ-ONLY. Is this order safe to practise fulfilment writes on — i.e. is it
// seed/test data rather than a real customer's order? Writes nothing.
const API = "2024-07";
const SHOP = (process.env.SHOPIFY_SHOP || "").trim();
const TOKEN = (process.env.SHOPIFY_ADMIN_TOKEN || "").trim();
const id = process.argv[2];
if (!SHOP || !TOKEN || !id) { console.error("usage: SHOPIFY_* set; node check-order-safety.mjs <orderId>"); process.exit(2); }

const Q = `query($id: ID!){ order(id:$id){
  id name createdAt test email phone
  displayFinancialStatus displayFulfillmentStatus cancelledAt closedAt tags note
  totalPriceSet{shopMoney{amount currencyCode}}
  customer{ id displayName email numberOfOrders }
  shippingAddress{ name city countryCodeV2 }
  lineItems(first:5){ nodes{ title quantity sku } }
  fulfillmentOrders(first:5){ nodes{ id status } }
}}`;

const r = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, {
  method: "POST",
  headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
  body: JSON.stringify({ query: Q, variables: { id: `gid://shopify/Order/${id}` } }),
});
const b = await r.json();
if (b.errors) { console.error(JSON.stringify(b.errors)); process.exit(1); }
const o = b.data?.order;
if (!o) { console.error("not found"); process.exit(1); }

const mask = (s) => (!s ? "(none)" : String(s).replace(/(.{2}).*(@.*)/, "$1***$2"));
console.log(`${o.name}  ${o.createdAt}`);
console.log(`  test order flag   ${o.test}`);
console.log(`  financial         ${o.displayFinancialStatus}`);
console.log(`  fulfilment        ${o.displayFulfillmentStatus}`);
console.log(`  cancelled/closed  ${o.cancelledAt ?? "no"} / ${o.closedAt ?? "no"}`);
console.log(`  total             ${o.totalPriceSet?.shopMoney?.amount} ${o.totalPriceSet?.shopMoney?.currencyCode}`);
console.log(`  order email       ${mask(o.email)}`);
console.log(`  customer          ${o.customer?.displayName ?? "(none)"}  ${mask(o.customer?.email)}  orders=${o.customer?.numberOfOrders}`);
console.log(`  ship to           ${o.shippingAddress?.name ?? "(none)"}, ${o.shippingAddress?.city ?? "?"} ${o.shippingAddress?.countryCodeV2 ?? ""}`);
console.log(`  tags              ${o.tags?.join(", ") || "(none)"}`);
console.log(`  note              ${o.note ?? "(none)"}`);
console.log(`  line items        ${(o.lineItems?.nodes ?? []).map((l) => `${l.quantity}x ${l.title}${l.sku ? ` [${l.sku}]` : ""}`).join(" | ") || "(none)"}`);
console.log(`  fulfillmentOrders ${(o.fulfillmentOrders?.nodes ?? []).map((f) => `${f.status}`).join(", ")}`);

#!/usr/bin/env node
// READ-ONLY diagnostic: WHY can't the app fulfil a given order's fulfillment
// orders? Scopes are only half the story — a fulfillment order is assigned to a
// location, and if that location is managed by a fulfillment SERVICE the app
// does not own, Shopify refuses with "api_client does not have access".
const API = "2024-07";
const SHOP = (process.env.SHOPIFY_SHOP || "").trim();
const TOKEN = (process.env.SHOPIFY_ADMIN_TOKEN || "").trim();
const ids = process.argv.slice(2);
if (!SHOP || !TOKEN || !ids.length) { console.error("usage: node fo-access.mjs <orderId> [orderId...]"); process.exit(2); }

const gq = async (query, variables) => {
  const r = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return r.json();
};

const Q = `query($id: ID!){ order(id:$id){
  name createdAt tags displayFulfillmentStatus
  fulfillmentOrders(first:10){ nodes{
    id status requestStatus supportedActions{ action }
    assignedLocation{ name location{ id name isActive fulfillmentService{ id serviceName handle type } } }
    deliveryMethod{ methodType }
  }}
}}`;

for (const id of ids) {
  const b = await gq(Q, { id: `gid://shopify/Order/${id}` });
  if (b.errors) { console.log(`${id}: ERRORS ${JSON.stringify(b.errors)}`); continue; }
  const o = b.data?.order;
  if (!o) { console.log(`${id}: not found`); continue; }
  console.log(`\n=== ${o.name}  ${o.createdAt.slice(0,10)}  ${o.displayFulfillmentStatus}`);
  console.log(`    tags: ${o.tags?.join(", ") || "(none)"}`);
  for (const f of o.fulfillmentOrders?.nodes ?? []) {
    const svc = f.assignedLocation?.location?.fulfillmentService;
    console.log(`    FO ${f.id.split("/").pop()}  status=${f.status}  requestStatus=${f.requestStatus}`);
    console.log(`       location        : ${f.assignedLocation?.location?.name ?? f.assignedLocation?.name ?? "?"}  active=${f.assignedLocation?.location?.isActive}`);
    console.log(`       fulfilmentSvc   : ${svc ? `${svc.serviceName} (handle=${svc.handle}, type=${svc.type})` : "NONE (merchant-managed)"}`);
    console.log(`       deliveryMethod  : ${f.deliveryMethod?.methodType ?? "?"}`);
    console.log(`       supportedActions: ${(f.supportedActions ?? []).map((a) => a.action).join(", ") || "(none)"}`);
  }
}

// Which locations exist, and which are service-managed?
const LOC = `{ locations(first:25){ nodes{ id name isActive fulfillmentService{ serviceName handle type } } } }`;
const lb = await gq(LOC, {});
console.log(`\n=== locations on ${SHOP} ===`);
for (const l of lb.data?.locations?.nodes ?? []) {
  const s = l.fulfillmentService;
  console.log(`  ${String(l.name).padEnd(28)} active=${String(l.isActive).padEnd(5)} svc=${s ? `${s.serviceName} [${s.handle}] ${s.type}` : "merchant-managed"}`);
}

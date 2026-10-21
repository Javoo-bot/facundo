#!/usr/bin/env node
// Exercise the customer-visible Shopify fulfilment writes against ONE real
// order, by hand, before any of this runs automatically.
//
// There is no Shopify test store, so the agreed approach is to practise on a
// genuinely old order — one already refunded/closed, whose customer stopped
// caring weeks ago — rather than on live traffic. Nothing here emails anyone:
// `notifyCustomer` is false on the fulfilment, and no tracking number is sent
// (a tracking number would additionally trip the Mechanic `order_on_their_way`
// task into an Ongage send — see that task's header).
//
// READ-ONLY BY DEFAULT. Inspecting writes nothing; the two mutations each need
// their own explicit flag.
//
//   node scripts/fulfilment-probe.mjs --scopes
//   node scripts/fulfilment-probe.mjs --order 7795351552328
//   node scripts/fulfilment-probe.mjs --order 7795351552328 --fulfil
//   node scripts/fulfilment-probe.mjs --order 7795351552328 --out-for-delivery
//
// Needs SHOPIFY_SHOP and SHOPIFY_ADMIN_TOKEN in the environment, and the token
// must carry `write_fulfillments` for the two write flags — `--scopes` tells
// you whether it does before you try. Shopify never upgrades an existing token
// when the requested scopes change; re-grant with scripts/shopify-reauth.sh.

const API = "2024-07"; // in step with lib/shopifyFulfillment.ts

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

const SHOP = (process.env.SHOPIFY_SHOP || "").trim();
const TOKEN = (process.env.SHOPIFY_ADMIN_TOKEN || "").trim();

if (!SHOP || !TOKEN) {
  console.error("ERROR: SHOPIFY_SHOP and SHOPIFY_ADMIN_TOKEN must be set.");
  console.error("       They are documented in dashboard/.env.local.example but are not set locally.");
  process.exit(2);
}

const headers = { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" };
const gid = (type, id) => (String(id).startsWith("gid://") ? String(id) : `gid://shopify/${type}/${id}`);

async function graphql(query, variables) {
  const res = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => null);
  // A missing scope arrives in top-level `errors`, not `userErrors`.
  if (body?.errors?.length) {
    return { ok: false, error: body.errors.map((e) => e?.message ?? "?").join("; ") };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  return { ok: true, data: body?.data };
}

async function showScopes() {
  const res = await fetch(`https://${SHOP}/admin/oauth/access_scopes.json`, { headers });
  const body = await res.json().catch(() => null);
  const granted = (body?.access_scopes ?? []).map((s) => s.handle).sort();
  console.log(`\nGranted scopes on this token (${granted.length}):`);
  for (const s of granted) console.log(`   ${s}`);
  // BOTH are required, and the second is the one everybody misses.
  //
  // write_fulfillments lets you call the mutations. It does NOT grant access to
  // the fulfillment orders themselves — an app may only act on fulfillment
  // orders it has access to, and that is decided by which LOCATION they are
  // assigned to. Both of this store's locations are merchant-managed, so
  // write_merchant_managed_fulfillment_orders is what actually unlocks them.
  //
  // Without it the failure is indirect and easy to misread: the fulfillment
  // order is readable (read_merchant_managed_fulfillment_orders is granted),
  // its supportedActions come back as HOLD/SPLIT with no CREATE_FULFILLMENT,
  // and fulfillmentCreateV2 fails with "The api_client does not have access to
  // the fulfillment order" — which sounds like a token problem rather than a
  // missing scope. Confirmed live 2026-09-15.
  const need = ["write_fulfillments", "write_merchant_managed_fulfillment_orders"];
  const missing = need.filter((s) => !granted.includes(s));
  if (!missing.length) {
    console.log(`\n  OK: ${need.join(" + ")} both granted — the write flags will work.`);
  } else {
    console.log(`\n  MISSING: ${missing.join(", ")}`);
    console.log(`  Present : ${need.filter((s) => granted.includes(s)).join(", ") || "(neither)"}`);
    console.log(
      `\n     Re-grant with:\n` +
      `       dashboard/scripts/shopify-reauth.sh "${[...new Set([...granted, ...need])].join(",")}"\n` +
      `     (that keeps every currently-granted scope and adds the missing one — Shopify\n` +
      `      replaces the whole scope set on re-grant, so dropping any would break other code.)`
    );
  }
  return missing.length === 0;
}

const ORDER_Q = `
  query Probe($id: ID!) {
    order(id: $id) {
      id name createdAt displayFinancialStatus displayFulfillmentStatus cancelledAt tags
      fulfillmentOrders(first: 20) { nodes { id status requestStatus } }
      fulfillments(first: 10) { id status createdAt events(first: 10) { nodes { status happenedAt } } }
    }
  }`;

async function inspect(orderId) {
  const out = await graphql(ORDER_Q, { id: gid("Order", orderId) });
  if (!out.ok) {
    console.error(`\n  QUERY FAILED: ${out.error}`);
    return null;
  }
  const o = out.data?.order;
  if (!o) {
    console.error(`\n  Order ${orderId} not found on ${SHOP}.`);
    return null;
  }
  console.log(`\n  ${o.name}   ${o.id}`);
  console.log(`  created            ${o.createdAt}`);
  console.log(`  financial status   ${o.displayFinancialStatus}`);
  console.log(`  fulfilment status  ${o.displayFulfillmentStatus}`);
  console.log(`  cancelled          ${o.cancelledAt ?? "no"}`);
  console.log(`  tags               ${o.tags?.join(", ") || "(none)"}`);

  const fos = o.fulfillmentOrders?.nodes ?? [];
  console.log(`\n  fulfillmentOrders (${fos.length}):`);
  for (const f of fos) console.log(`     ${f.status.padEnd(12)} ${f.id}  requestStatus=${f.requestStatus}`);
  const fulfillable = fos.filter((f) => ["OPEN", "IN_PROGRESS"].includes((f.status || "").toUpperCase()));
  console.log(`  -> fulfillable now: ${fulfillable.length}`);

  const fs = o.fulfillments ?? [];
  console.log(`\n  existing fulfillments (${fs.length}):`);
  for (const f of fs) {
    console.log(`     ${f.id}  status=${f.status}  created=${f.createdAt}`);
    for (const e of f.events?.nodes ?? []) console.log(`        event ${e.status} @ ${e.happenedAt}`);
  }
  return { order: o, fulfillable: fulfillable.map((f) => f.id), fulfillmentIds: fs.map((f) => f.id) };
}

const CREATE = `
  mutation Fulfil($fulfillment: FulfillmentV2Input!) {
    fulfillmentCreateV2(fulfillment: $fulfillment) {
      fulfillment { id status createdAt }
      userErrors { field message }
    }
  }`;

const EVENT = `
  mutation Ev($fulfillmentEvent: FulfillmentEventInput!) {
    fulfillmentEventCreate(fulfillmentEvent: $fulfillmentEvent) {
      fulfillmentEvent { id status happenedAt }
      userErrors { field message }
    }
  }`;

const userErr = (e) =>
  Array.isArray(e) && e.length ? e.map((x) => `${x.field ?? ""} ${x.message}`.trim()).join("; ") : null;

async function main() {
  console.log(`shop: ${SHOP}   api: ${API}`);

  if (has("--scopes")) {
    await showScopes();
    if (!has("--order")) return;
  }

  const orderId = val("--order");
  if (!orderId) {
    console.error("\nUsage: --order <shopify numeric id> [--fulfil] [--out-for-delivery] [--scopes]");
    process.exit(2);
  }

  console.log("\n=== BEFORE ===");
  const before = await inspect(orderId);
  if (!before) process.exit(1);

  if (has("--fulfil")) {
    if (before.fulfillable.length === 0) {
      console.log("\n  SKIP --fulfil: nothing fulfillable (already fulfilled, closed, or cancelled).");
      console.log("  That is the idempotent path the real code takes too — not a failure.");
    } else {
      console.log(`\n=== WRITE: fulfillmentCreateV2 on ${before.fulfillable.length} fulfillment order(s) ===`);
      const out = await graphql(CREATE, {
        fulfillment: {
          lineItemsByFulfillmentOrder: before.fulfillable.map((id) => ({ fulfillmentOrderId: id })),
          notifyCustomer: false, // never true — see the header
        },
      });
      if (!out.ok) console.error(`  FAILED: ${out.error}`);
      else {
        const ue = userErr(out.data?.fulfillmentCreateV2?.userErrors);
        if (ue) console.error(`  REJECTED: ${ue}`);
        else console.log(`  OK: ${out.data?.fulfillmentCreateV2?.fulfillment?.id}`);
      }
    }
  }

  if (has("--out-for-delivery")) {
    const after = await inspect(orderId);
    const fid = after?.fulfillmentIds?.[0];
    if (!fid) {
      console.log("\n  SKIP --out-for-delivery: the order has no fulfilment to attach an event to.");
    } else {
      console.log(`\n=== WRITE: fulfillmentEventCreate OUT_FOR_DELIVERY on ${fid} ===`);
      const out = await graphql(EVENT, {
        fulfillmentEvent: { fulfillmentId: fid, status: "OUT_FOR_DELIVERY", happenedAt: new Date().toISOString() },
      });
      if (!out.ok) console.error(`  FAILED: ${out.error}`);
      else {
        const ue = userErr(out.data?.fulfillmentEventCreate?.userErrors);
        if (ue) console.error(`  REJECTED: ${ue}`);
        else console.log(`  OK: ${JSON.stringify(out.data?.fulfillmentEventCreate?.fulfillmentEvent)}`);
      }
    }
  }

  if (has("--fulfil") || has("--out-for-delivery")) {
    console.log("\n=== AFTER ===");
    await inspect(orderId);
  } else {
    console.log("\n(read-only — pass --fulfil and/or --out-for-delivery to write)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

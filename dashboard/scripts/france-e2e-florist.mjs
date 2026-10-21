// Drive the FLORIST half of the France test through the real staging APIs.
//
//   node scripts/france-e2e-florist.mjs open    B2
//   node scripts/france-e2e-florist.mjs accept  B1
//   node scripts/france-e2e-florist.mjs decline B3 "Too busy"
//   node scripts/france-e2e-florist.mjs photo   B1
//   node scripts/france-e2e-florist.mjs state   B1
//
// Sessions come from scripts/act-as.mjs, which mints a real florist_magic_tokens
// row and redeems it through /florist/m/<token> — the same route the offer
// email's button points at. Nothing here is mocked; these are the endpoints the
// florist's own taps hit.
//
// The delivery photo is the order's OWN catalogue image, fetched from the
// line-item image_url. A synthetic 1x1 JPEG would be a fair test of the reject
// path and a useless test of the happy path, because verifyDeliveryPhoto puts
// the bytes in front of a vision model and a blank square is not a bouquet.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { floristSession, call, hop, BASE } from "./act-as.mjs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const [, , action, label, extra] = process.argv;
if (!action || !label) {
  console.error("usage: france-e2e-florist.mjs <open|accept|decline|photo|state> <B1..B5> [reason]");
  process.exit(2);
}

const { data: order } = await db
  .from("orders")
  .select("id, order_name, status, total, delivery_at")
  .eq("shopify_order_id", `FRTEST-${label}`)
  .single();
if (!order) {
  console.error(`no order FRTEST-${label}`);
  process.exit(1);
}
// Whichever assignment actually holds the offer, not blindly rank 1: on a
// multi-wave order the live offer has moved on, and on a cold-offer order the
// shop that got it is whichever one cleared the gate first.
const { data: all } = await db
  .from("order_assignments")
  .select("id, florist_id, status, rank, sent_at, offer_expires_at, payout_price, offer_audience")
  .eq("order_id", order.id)
  .order("rank");
const asg =
  (all ?? []).find((a) => a.status === "sent" || a.status === "opened") ??
  (all ?? []).find((a) => a.status === "accepted" || a.status === "delivered") ??
  (all ?? []).find((a) => a.status === "expired") ??
  (all ?? [])[0];
if (!asg) {
  console.error(`no assignment on FRTEST-${label}`);
  process.exit(1);
}

console.log(`${order.order_name}  order=${order.status}  assignment=rank${asg.rank}/${asg.status}  payout=€${asg.payout_price}  audience=${asg.offer_audience}`);

async function showState() {
  const { data: a } = await db
    .from("order_assignments")
    .select("status, accepted_at, declined_at, delivered_at, decline_reason")
    .eq("order_id", order.id);
  const { data: p } = await db
    .from("payouts")
    .select("leg, amount, currency, rail, status, provider_ref")
    .in("assignment_id", (a ?? []).length ? [asg.id] : ["00000000-0000-0000-0000-000000000000"]);
  const { data: ap } = await db.from("order_approvals").select("kind, status, block_reason").eq("order_id", order.id);
  const { data: ev } = await db
    .from("order_events")
    .select("type, created_at")
    .eq("order_id", order.id)
    .order("created_at");
  console.log("  assignments:", JSON.stringify(a));
  console.log("  payouts:", JSON.stringify(p));
  console.log("  approvals:", JSON.stringify(ap));
  console.log("  events:", (ev ?? []).map((e) => e.type).join(" → "));
}

if (action === "state") {
  await showState();
  process.exit(0);
}

const { jar, landed } = await floristSession(asg.florist_id, `/florist/orders/${asg.id}`);
console.log(`  session: ${landed}`);

if (action === "open") {
  // Exactly what the florist's tap does: land on the offer page, read it, stop.
  const r = await hop(jar, `${BASE}/florist/orders/${asg.id}`);
  console.log(`  GET /florist/orders/${asg.id} → ${r.status}`);
  const { data: after } = await db
    .from("order_assignments")
    .select("status, opened_at")
    .eq("id", asg.id)
    .single();
  console.log(`  assignment after opening: status=${after.status}  opened_at=${after.opened_at ?? "NULL"}`);
  await showState();
} else if (action === "accept") {
  const r = await call(jar, "POST", "/api/florist/respond", { assignmentId: asg.id, action: "accept" });
  console.log(`  POST /api/florist/respond accept → ${r.code} ${r.body.slice(0, 300)}`);
  await showState();
} else if (action === "decline") {
  const r = await call(jar, "POST", "/api/florist/respond", {
    assignmentId: asg.id,
    action: "decline",
    reason: extra ?? "Too busy",
  });
  console.log(`  POST /api/florist/respond decline → ${r.code} ${r.body.slice(0, 300)}`);
  await showState();
} else if (action === "photo") {
  // This order's own catalogue image if it has one; otherwise any real bouquet
  // photo from the catalogue. Either way the vision verifier sees flowers,
  // which is the point — the happy path is not tested by a blank square.
  let { data: item } = await db
    .from("order_line_items")
    .select("image_url, title")
    .eq("order_id", order.id)
    .not("image_url", "is", null)
    .limit(1)
    .maybeSingle();
  if (!item?.image_url) {
    const { data: any } = await db
      .from("order_line_items")
      .select("image_url, title")
      .not("image_url", "is", null)
      .limit(1)
      .maybeSingle();
    item = any;
    console.log("  (this order's items carry no image — using a catalogue bouquet photo)");
  }
  if (!item?.image_url) {
    console.error("  no bouquet image available anywhere to use as the delivery photo");
    process.exit(1);
  }
  console.log(`  fetching bouquet photo: ${item.title} — ${item.image_url}`);
  const img = await fetch(item.image_url);
  const bytes = Buffer.from(await img.arrayBuffer());
  console.log(`  ${bytes.length} bytes, ${img.headers.get("content-type")}`);

  const form = new FormData();
  form.set("assignmentId", asg.id);
  form.set("type", "delivered");
  form.set("file", new Blob([bytes], { type: "image/jpeg" }), "delivery.jpg");
  const r = await hop(jar, `${BASE}/api/florist/photo`, { method: "POST", body: form });
  const text = r.res ? await r.res.text() : "";
  console.log(`  POST /api/florist/photo → ${r.status} ${text.slice(0, 400)}`);
  await showState();
} else {
  console.error(`unknown action ${action}`);
  process.exit(2);
}

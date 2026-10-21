#!/usr/bin/env node
// PLACEHOLDER florist (and Shopify customer) for the garden weather, until the
// tester.army browser personas and the Ollama reply actors take over. It
// performs each scenario's `steps` (weather-catalogue.mjs) through the same
// HTTP routes the florist app uses: a magic link to sign in, then
// /api/florist/respond to accept or decline and /api/florist/photo to upload.
// A cancellation goes in as a signed orders/cancelled webhook.
//
//   node agents/garden/weather-puppet.mjs [--day YYYY-MM-DD] [--loop MINUTES]
//
// Every step is decided from the order's own state, so running it again, or
// every few minutes, never repeats a click.
import fs from "node:fs";
import path from "node:path";
import { db, inList, postWebhook, madridDate, addDays, sleep, DASHBOARD_URL, HERE } from "./weather-lib.mjs";

const PHOTOS = {
  bouquet: path.join(HERE, "weather-photos", "bouquet.jpg"),
  screenshot: path.resolve(HERE, "..", "..", "dashboard", "public", "guide", "02-orders-table.jpg"),
};
const minutesSince = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 6e4 : -Infinity);

/** Signs in as the florist the way an offer email's link does, and returns the session cookies. */
async function signInAs(floristId, assignmentId) {
  const token = crypto.randomUUID();
  await db("florist_magic_tokens", {
    method: "POST", prefer: "return=minimal",
    body: {
      token, florist_id: floristId, dest: `/florist/orders/${assignmentId}`, purpose: "offer", assignment_id: assignmentId,
      expires_at: new Date(Date.now() + 3600e3).toISOString(),
    },
  });
  const res = await fetch(`${DASHBOARD_URL}/florist/m/${token}`, { redirect: "manual" });
  const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => !c.endsWith("="));
  if (!cookies.length) throw new Error(`magic link gave no session (${res.status} -> ${res.headers.get("location")})`);
  return cookies.join("; ");
}

async function respond(a, action) {
  const cookie = await signInAs(a.florist_id, a.id);
  const res = await fetch(`${DASHBOARD_URL}/api/florist/respond`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ assignmentId: a.id, action, ...(action === "decline" ? { reason: "busy", detail: "garden puppet" } : {}) }),
  });
  return `${res.status} ${(await res.text()).slice(0, 160)}`;
}

async function uploadPhoto(a, which) {
  const cookie = await signInAs(a.florist_id, a.id);
  const form = new FormData();
  form.set("assignmentId", a.id);
  form.set("type", "delivered");
  form.set("file", new File([fs.readFileSync(PHOTOS[which])], `${which}.jpg`, { type: "image/jpeg" }));
  const res = await fetch(`${DASHBOARD_URL}/api/florist/photo`, { method: "POST", headers: { cookie }, body: form });
  return `${res.status} ${(await res.text()).slice(0, 160)}`;
}

/** The next step this order is ready for, or null. State decides; nothing is stored. */
function nextStep(steps, order, assigns, photos) {
  const accepted = assigns.find((a) => a.status === "accepted" || a.status === "delivered");
  const live = assigns.find((a) => a.status === "sent" || a.status === "opened");
  for (const s of steps) {
    if (s.do === "accept" && !accepted && live && minutesSince(live.sent_at) >= s.after) return { s, a: live };
    if (s.do === "decline" && !assigns.some((a) => a.status === "declined") && live && minutesSince(live.sent_at) >= s.after) return { s, a: live };
    if (s.do === "late_accept" && !accepted && order.status === "escalated") {
      const lapsed = assigns.find((a) => a.status === "expired" && a.sent_at);
      if (lapsed) return { s, a: lapsed };
    }
    if (s.do === "photo" && accepted && !photos.has(accepted.id) && minutesSince(accepted.accepted_at) >= s.after) return { s, a: accepted };
    if (s.do === "cancel" && ["matched", "reaching_out"].includes(order.status) && live && minutesSince(live.sent_at) >= s.after) return { s, a: live };
  }
  return null;
}

async function tick(days) {
  const rows = await db(`garden_scenarios?day=${inList(days)}&order_id=not.is.null&expected->steps=not.is.null&select=shopify_order_id,order_id,expected`);
  if (!rows.length) return 0;
  const ids = rows.map((r) => r.order_id);
  const orders = new Map((await db(`orders?id=${inList(ids)}&select=id,status,shopify_order_id`)).map((o) => [o.id, o]));
  const assigns = await db(`order_assignments?order_id=${inList(ids)}&select=id,order_id,florist_id,status,sent_at,accepted_at&order=rank`);
  const photoRows = assigns.length
    ? await db(`delivery_events?assignment_id=${inList(assigns.map((a) => a.id))}&type=eq.delivered_photo&select=assignment_id`) : [];
  const photos = new Set(photoRows.map((p) => p.assignment_id));
  let acted = 0;
  for (const r of rows) {
    const order = orders.get(r.order_id);
    if (!order) continue;
    const step = nextStep(r.expected.steps, order, assigns.filter((a) => a.order_id === r.order_id), photos);
    if (!step) continue;
    const { s, a } = step;
    let result;
    // One failed click (a dropped connection) is retried on the next pass; it must not stop the rest.
    try {
      if (s.do === "accept" || s.do === "late_accept") result = await respond(a, "accept");
      else if (s.do === "decline") result = await respond(a, "decline");
      else if (s.do === "photo") result = await uploadPhoto(a, s.photo);
      else if (s.do === "cancel") {
        result = `webhook ${await postWebhook({ id: order.shopify_order_id, name: `#${order.shopify_order_id}`, cancelled_at: new Date().toISOString(), cancel_reason: "customer" }, { topic: "orders/cancelled" })}`;
      }
    } catch (e) {
      result = `will retry: ${e.cause?.code ?? e.message}`;
    }
    acted++;
    console.log(`${new Date().toISOString()} ${r.shopify_order_id} ${r.expected.scenario} ${s.do}${s.photo ? `(${s.photo})` : ""}: ${result}`);
  }
  return acted;
}

const di = process.argv.indexOf("--day");
const today = di > 0 ? process.argv[di + 1] : madridDate();
// Yesterday too: a late accept or a photo can fall after midnight.
const days = [addDays(today, -1), today];
const li = process.argv.indexOf("--loop");
const loopUntil = li > 0 ? Date.now() + Number(process.argv[li + 1]) * 6e4 : 0;
do {
  await tick(days);
  if (Date.now() < loopUntil) await sleep(60_000);
} while (Date.now() < loopUntil);

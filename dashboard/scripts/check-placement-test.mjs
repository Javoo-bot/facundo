// Where has each placement-test order actually got to, and can the operator do
// anything about it from the three screens they have?
//
//   node --import ./scripts/alias-loader-register.mjs scripts/check-placement-test.mjs
//
// Run it after every click. Read-only — it writes nothing.
//
// It answers three questions per order that no single screen does:
//
//   1. What does /operator SAY about it right now — using the real
//      gatherAttention + lib/operator.ts, so this cannot drift from the page.
//   2. Where did the automation actually get to — status, escalation reason,
//      and the offer trail, so "nothing happened" can be told apart from
//      "something happened and it was wrong".
//   3. IS THE BUTTON REACHABLE. The staging CX operator works only in
//      /operator, /orders/[id]/call and /orders/[id]/reply; /orders/[id] is
//      the old panel there. A row whose button opens the old page is a dead end
//      for them however correct it is, so those are called out rather than
//      being listed as if they were work they could do.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { gatherAttention } from "@/lib/cxAttention";
import { byDeadline, operatorAction, operatorHref, countdown } from "@/lib/operator";

const PREFIX = "#FIND-";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
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

const { data: orders } = await db
  .from("orders")
  .select("id, order_name, status, escalation_reason, delivery_at, delivery_area, total, worklist_at")
  .like("order_name", `${PREFIX}%`)
  .order("order_name");

if (!orders?.length) {
  console.log(`No ${PREFIX} orders. Run scripts/seed-placement-test.mjs first.`);
} else {
  await report(orders);
}

async function report(orders) {
const ids = orders.map((o) => o.id);
const [{ data: asg }, { data: appr }, { data: events }] = await Promise.all([
  db.from("order_assignments").select("order_id, status, rank, sent_at, declined_at, florist_id, florists(name, email, phone_maps, phone_web, is_test_shop)").in("order_id", ids).order("rank"),
  db.from("order_approvals").select("order_id, kind, status").in("order_id", ids).eq("status", "pending"),
  db.from("order_events").select("order_id, type, created_at").in("order_id", ids).order("created_at"),
]);

// The real queue, so this report and the page can never disagree.
const attention = byDeadline(await gatherAttention(db));
const attentionById = new Map(attention.map((a) => [a.orderId, a]));

/** The operator on staging has these three screens and no others. The Operator
 *  panel was retired on 3 Sept 2026; its queue is now the Control panel at "/". */
function reachable(href) {
  return /\/call$/.test(href) || /\/reply$/.test(href) || href === "/";
}

const summary = { placed: 0, stuck: 0, unreachable: 0, quiet: 0 };

for (const o of orders) {
  const mine = (asg ?? []).filter((a) => a.order_id === o.id);
  const byStatus = {};
  for (const a of mine) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
  const trail = (events ?? []).filter((e) => e.order_id === o.id).map((e) => e.type);
  const pending = (appr ?? []).filter((a) => a.order_id === o.id).map((a) => a.kind);
  const row = attentionById.get(o.id);

  const lead = o.delivery_at ? (Date.parse(o.delivery_at) - Date.now()) / 3600e3 : null;
  const leadText = lead == null ? "no date" : lead < 0 ? `${(-lead).toFixed(1)}h PAST DEADLINE` : `${lead.toFixed(1)}h to delivery`;

  console.log("─".repeat(96));
  console.log(`${o.order_name}   ${o.delivery_area ?? "—"}   €${o.total}   ${leadText}`);
  console.log(`  status:      ${o.status}${o.escalation_reason ? ` (${o.escalation_reason})` : ""}${o.worklist_at ? "" : "   ⚠ NOT IN THE WORKING SET"}`);

  const shopBits = mine.map((a) => {
    const f = Array.isArray(a.florists) ? a.florists[0] : a.florists;
    const reach = [f?.email ? "email" : null, f?.phone_maps || f?.phone_web ? "phone" : null].filter(Boolean).join("+") || "NO CHANNEL";
    return `${a.rank}:${a.status}(${reach})`;
  });
  console.log(`  shops:       ${mine.length ? shopBits.join("  ") : "none written yet"}`);
  if (pending.length) console.log(`  approvals:   ${pending.join(", ")} pending`);
  console.log(`  trail:       ${trail.length ? trail.join(" → ") : "nothing has happened"}`);

  if (!row) {
    console.log(`  /operator:   not listed — nothing needs a human`);
    if (["accepted", "in_production", "ready", "out_for_delivery", "delivered", "paid", "closed"].includes(o.status)) {
      console.log(`  ✓ PLACED — a florist holds this order.`);
      summary.placed++;
    } else {
      console.log(`  · quiet: in flight, or waiting on the cron.`);
      summary.quiet++;
    }
  } else {
    const action = operatorAction(row.primary);
    const href = operatorHref(o.id, action);
    const c = countdown(o.delivery_at);
    const ok = reachable(href);
    console.log(`  /operator:   "${action.headline}"`);
    console.log(`               [ ${action.action} ] ${action.run ? "· runs on the row" : `→ ${href}`}   (${c.value} ${c.unit})`);
    if (ok || action.run) {
      console.log(`  → the operator can do this.`);
      summary.stuck++;
    } else {
      console.log(`  ✖ DEAD END for this operator — that button opens the old order page.`);
      summary.unreachable++;
    }
    if (row.others.length) console.log(`               (+${row.others.length} other thing(s) also wrong with this order)`);
  }
}

console.log("─".repeat(96));
console.log(`\n  placed: ${summary.placed}    needs a human, can act: ${summary.stuck}    needs a human, CANNOT act: ${summary.unreachable}    quiet: ${summary.quiet}\n`);
if (summary.unreachable) {
  console.log("  The dead ends are the finding. Each one is an order the operator can see, understand,");
  console.log("  and not act on, because its only control lives on a page they do not work in.\n");
}
}

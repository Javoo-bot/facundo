// Of the orders we started, how many reached a florist — and where did the rest die?
//
//   node scripts/funnel.mjs           # the #FIND- test orders
//   node scripts/funnel.mjs --all     # every order in the working set
//
// Read-only. This is the question the whole placement test exists to answer:
// start at 100% "arrived" and see what percentage survives each step to a
// terminal outcome. It deliberately mirrors the stages on the flow map rather
// than the database's own vocabulary, so a number here can be pointed at a box
// on the diagram.
//
// A stage is counted from EVIDENCE, not from the order's current status: an
// order that was offered and then declined still counts as "offered", because
// the funnel asks how far it got, not where it sits now.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const all = process.argv.includes("--all");

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

let q = db.from("orders").select("id, order_name, status, escalation_reason, delivery_at, worklist_at").is("deleted_at", null);
q = all ? q.not("worklist_at", "is", null) : q.like("order_name", "#FIND-%");
const { data: orders } = await q.order("order_name");
if (!orders?.length) {
  console.log("No orders to report on.");
} else {
  const ids = orders.map((o) => o.id);
  const [{ data: asg }, { data: appr }] = await Promise.all([
    db.from("order_assignments").select("order_id, status, sent_at, rank").in("order_id", ids),
    db.from("order_approvals").select("order_id, kind").in("order_id", ids).eq("status", "pending"),
  ]);

  const OFFERED = ["sent", "opened", "expired", "declined", "accepted", "delivered"];
  const ANSWERED = ["declined", "accepted", "delivered"];
  const HELD = ["accepted", "in_production", "ready", "out_for_delivery", "delivered", "paid", "closed"];

  const rows = orders.map((o) => {
    const mine = (asg ?? []).filter((a) => a.order_id === o.id);
    const offered = mine.filter((a) => OFFERED.includes(a.status) || a.sent_at);
    const answered = mine.filter((a) => ANSWERED.includes(a.status));
    const pending = (appr ?? []).filter((a) => a.order_id === o.id);
    return {
      name: o.order_name,
      status: o.status,
      reason: o.escalation_reason,
      matched: mine.length > 0,
      offered: offered.length > 0,
      offerCount: offered.length,
      answered: answered.length > 0,
      declined: mine.filter((a) => a.status === "declined").length,
      placed: HELD.includes(o.status),
      waitingOnHuman: pending.length > 0,
      pendingKinds: pending.map((p) => p.kind),
    };
  });

  const n = rows.length;
  const pct = (k) => `${Math.round((k / n) * 100)}%`.padStart(4);
  const bar = (k) => "█".repeat(Math.round((k / n) * 34)).padEnd(34, "·");

  const stages = [
    ["Arrived", n],
    ["Matched to shops", rows.filter((r) => r.matched).length],
    ["An offer went out", rows.filter((r) => r.offered).length],
    ["A shop answered", rows.filter((r) => r.answered).length],
    ["PLACED — a shop holds it", rows.filter((r) => r.placed).length],
  ];

  console.log(`\n${n} order${n === 1 ? "" : "s"}, from arrival to a florist:\n`);
  for (const [label, k] of stages) {
    console.log(`  ${bar(k)}  ${String(k).padStart(3)}  ${pct(k)}  ${label}`);
  }

  // Where the survivors stopped. One line per order that has not been placed,
  // saying which box on the map it is sitting in.
  const stuck = rows.filter((r) => !r.placed);
  if (stuck.length) {
    console.log(`\nThe ${stuck.length} that did not get there:\n`);
    for (const r of stuck) {
      let where;
      if (!r.matched) where = "never matched — no shop was ever attached";
      else if (r.waitingOnHuman) where = `waiting on a person to ${r.pendingKinds.join("/")}`;
      else if (!r.offered) where = "matched, but no offer has gone out";
      else if (r.status === "escalated") where = `offered ${r.offerCount}, then escalated (${r.reason ?? "no reason"})`;
      else if (r.declined >= r.offerCount && r.offerCount > 0) where = `all ${r.declined} shops asked said no`;
      else where = `offered ${r.offerCount}, ${r.answered ? "answered but not placed" : "nobody has answered"}`;
      console.log(`  ${r.name.padEnd(10)} ${where}`);
    }
  }

  const placed = rows.filter((r) => r.placed).length;
  console.log(`\n  ${placed}/${n} placed (${pct(placed).trim()}). ${n - placed} short.\n`);
}

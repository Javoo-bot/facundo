// Seed the staging database with orders that are stuck in each of the ways the
// Operator panel (/operator) knows how to describe, so the page can be judged
// against real rows rather than a mockup.
//
//   node scripts/seed-operator-demo.mjs          # create them
//   node scripts/seed-operator-demo.mjs --clean  # delete them again
//
// SAFETY. Every row this writes is named `#OPQA-…`, and --clean deletes on that
// prefix only, so it can never touch a real order. It refuses to run against a
// project whose `app_settings.test_mode` is false — this is a fixture script,
// not something to point at production. Reads its credentials from
// .env.local (the staging project) and uses the service-role key,
// the same key the ingest pipeline writes with.
//
// The deadlines span the whole ladder the countdown can render — 30 minutes,
// 2, 4, 8 and 26 hours, then 2 days — so the column has something real to rank
// and every severity tone (red under 2h, amber inside 2 days, calm at 2 days)
// appears at least once. 2 days is the deliberate maximum: past that the rows
// stop being today's problem and the page stops being a to-do list.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const PREFIX = "#OPQA-";
const clean = process.argv.includes("--clean");

// ── credentials ────────────────────────────────────────────────────────────
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

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });
console.log(`→ ${url.replace(/https:\/\/([a-z]{6}).*/, "https://$1….supabase.co")}`);

// ── guard: staging only ────────────────────────────────────────────────────
{
  const { data, error } = await db.from("app_settings").select("test_mode").eq("id", 1).maybeSingle();
  if (error) {
    console.error("Could not read app_settings:", error.message);
    process.exit(1);
  }
  if (data?.test_mode !== true) {
    console.error("REFUSING TO RUN: app_settings.test_mode is not true. This script is for staging only.");
    process.exit(1);
  }
  console.log("✓ test_mode is on — safe to seed");
}

// ── clean ──────────────────────────────────────────────────────────────────
async function removeSeeded() {
  const { data: existing } = await db.from("orders").select("id, order_name").like("order_name", `${PREFIX}%`);
  const ids = (existing ?? []).map((o) => o.id);
  if (ids.length === 0) return 0;
  // order_assignments / order_issues cascade on order delete; payouts cascade
  // from the assignment. payment_events has no FK to orders, so clear it by
  // the payout ids first.
  const { data: asg } = await db.from("order_assignments").select("id").in("order_id", ids);
  const asgIds = (asg ?? []).map((a) => a.id);
  if (asgIds.length) {
    const { data: po } = await db.from("payouts").select("id").in("assignment_id", asgIds);
    const poIds = (po ?? []).map((p) => p.id);
    if (poIds.length) await db.from("payment_events").delete().in("payout_id", poIds);
  }
  await db.from("orders").delete().in("id", ids);
  return ids.length;
}

const removed = await removeSeeded();
if (removed) console.log(`✓ removed ${removed} previously seeded order(s)`);
if (clean) {
  console.log("Done (clean only).");
  process.exit(0);
}

// ── a florist to hang the assignments off ──────────────────────────────────
// Any activated shop will do; these assignments are never offered or paid, they
// only give the panel something true to say in its context line.
const { data: florists } = await db.from("florists").select("id, name").limit(6);
if (!florists?.length) {
  console.error("No florists in this project — seed some first.");
  process.exit(1);
}
const shopFor = (i) => florists[i % florists.length];

// ── helpers ────────────────────────────────────────────────────────────────
const now = Date.now();
const at = (mins) => new Date(now + mins * 60_000).toISOString();

/** A deadline that READS as `n` hours for a while.
 *
 * countdown() floors — 3h59m shows as "3 hours left" — which is the right way
 * round for a deadline (it never tells an operator they have more time than
 * they do). It does mean a fixture seeded at exactly 4h renders "3 hours left"
 * the moment this script finishes. The 50 minutes of headroom here buy the
 * intended label most of an hour of life, without touching the rounding. */
const hoursFrom = (n) => at(n * 60 + 50);

let seq = 0;
async function makeOrder(fields) {
  seq += 1;
  const name = `${PREFIX}${String(9200 + seq)}`;
  const { data, error } = await db
    .from("orders")
    .insert({
      shopify_order_id: `OPQA-${Date.now()}-${seq}`,
      order_name: name,
      shopify_created_at: new Date(now - 3 * 3600_000).toISOString(),
      currency: "EUR",
      total: 74.9,
      financial_status: "paid",
      buyer_name: "QA Buyer",
      buyer_email: "qa@example.invalid",
      recipient_name: "QA Recipient",
      substitution_policy: "similar_value",
      notes: "🧪 Operator-panel demo row. Safe to delete.",
      // Explicit working-set pick, so the panel sees it whatever the tag gate
      // is currently set to (dashboard/lib/workingSet.ts::isInWorkingSet).
      worklist_at: new Date().toISOString(),
      ...fields,
    })
    .select("id, order_name")
    .single();
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

async function addAssignments(orderId, specs) {
  const rows = specs.map((s, i) => ({
    order_id: orderId,
    florist_id: shopFor(i).id,
    rank: i + 1,
    status: s.status,
    offer_kind: "race",
    payout_price: 52.43,
    sent_at: s.status === "candidate" ? null : new Date(now - 90 * 60_000).toISOString(),
    sla_deadline_at: s.slaMins != null ? at(s.slaMins) : null,
    accepted_at: s.status === "accepted" ? new Date(now - 60 * 60_000).toISOString() : null,
  }));
  const { data, error } = await db.from("order_assignments").insert(rows).select("id, status");
  if (error) throw new Error(`assignments: ${error.message}`);
  return data;
}

const city = (c, region, country) => ({
  delivery_area: `${c} · ${region}`,
  delivery_address: { line1: "1 Test Street", city: c, postal: "00000", region, country },
});

// ── the five rows ──────────────────────────────────────────────────────────
const made = [];

// 1 · 30 minutes — an offer went out and nobody answered. The SLA is already
//     breached, which is the single highest-urgency reason cxAttention emits.
{
  const o = await makeOrder({
    status: "reaching_out",
    delivery_at: at(32),
    delivery_window: "17:00–19:00",
    ...city("York", "England", "GB"),
  });
  await addAssignments(o.id, [
    { status: "sent", slaMins: -20 }, // breached 20 minutes ago
    { status: "sent", slaMins: -15 },
    { status: "expired" },
    { status: "expired" },
  ]);
  made.push([o.order_name, "30 min", "No florist has answered yet"]);
}

// 2 · 2 hours — the wave engine ran out of shops in range and escalated.
{
  const o = await makeOrder({
    status: "escalated",
    escalation_reason: "pool_exhausted",
    delivery_at: hoursFrom(2),
    delivery_window: "18:00–20:00",
    ...city("Utrecht", "Utrecht", "NL"),
  });
  await addAssignments(o.id, [{ status: "declined" }, { status: "declined" }]);
  made.push([o.order_name, "2 hours", "No florist available in range"]);
}

// 3 · 4 hours — everyone we asked declined and no offer is live, so it is
//     sitting still until a person advances it.
{
  const o = await makeOrder({
    status: "reaching_out",
    delivery_at: hoursFrom(4),
    delivery_window: "10:00–14:00",
    ...city("York", "England", "GB"),
  });
  await addAssignments(o.id, [
    { status: "declined" },
    { status: "declined" },
    { status: "declined" },
    { status: "expired" },
  ]);
  made.push([o.order_name, "4 hours", "No answer from any shop we asked"]);
}

// 4 · 8 hours — accepted and being made, but the 70% is parked on the shop's
//     trust tier and needs a human to release it.
{
  const o = await makeOrder({
    status: "accepted",
    delivery_at: hoursFrom(8),
    delivery_window: "10:00–14:00",
    ...city("York", "England", "GB"),
  });
  const asg = await addAssignments(o.id, [{ status: "accepted" }]);
  const { data: payout, error: pErr } = await db
    .from("payouts")
    .insert({
      assignment_id: asg[0].id,
      leg: "accept",
      amount: 36.7,
      currency: "EUR",
      rail: "card",
      status: "held",
    })
    .select("id")
    .single();
  if (pErr) throw new Error(`payout: ${pErr.message}`);
  // The reason the desk reads back to say WHY it is held, not just that it is.
  const { error: eErr } = await db.from("payment_events").insert({
    payout_id: payout.id,
    type: "held_for_review",
    payload: { reason: "tier-hold" },
  });
  if (eErr) console.warn(`  (payment_events skipped: ${eErr.message})`);
  made.push([o.order_name, "8 hours", "Payment is waiting for your approval"]);
}

// 5 · 26 hours — the florist has it in hand and has raised a question. The row
//     that proves the list is not only fires.
{
  const o = await makeOrder({
    status: "in_production",
    delivery_at: hoursFrom(26),
    delivery_window: "09:00–13:00",
    ...city("York", "England", "GB"),
  });
  const asg = await addAssignments(o.id, [{ status: "accepted" }]);
  const { error } = await db.from("order_issues").insert({
    order_id: o.id,
    assignment_id: asg[0].id,
    type: "missing_ingredient",
    detail: "No peonies left this week — can I substitute garden roses?",
    status: "open",
    cx_unread: true,
    created_by: "florist",
  });
  if (error) throw new Error(`issue: ${error.message}`);
  made.push([o.order_name, "26 hours", "A florist reported a problem"]);
}

// 6 · 2 days — matched, with a shortlist nobody has been offered yet. The
//     quietest row on the page, and the one that shows the calm tone: seeded a
//     little past 48h so it stays on the calm side of the boundary rather than
//     flipping to amber a minute after this script runs.
{
  const o = await makeOrder({
    status: "matched",
    delivery_at: at(48 * 60 + 40),
    delivery_window: "12:00–16:00",
    ...city("Leeds", "England", "GB"),
  });
  await addAssignments(o.id, [{ status: "candidate" }, { status: "candidate" }, { status: "candidate" }]);
  made.push([o.order_name, "2 days", "Nobody has been asked yet"]);
}

console.log(`\n✓ seeded ${made.length} orders:\n`);
for (const [name, due, why] of made) console.log(`   ${name.padEnd(12)} ${due.padEnd(9)} ${why}`);
console.log(`\nOpen /operator to see them. Remove with: node scripts/seed-operator-demo.mjs --clean`);

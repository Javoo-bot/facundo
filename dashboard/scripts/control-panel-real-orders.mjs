// Narrow the staging working set to FIVE orders that between them show every
// branch of the Control panel's button rule.
//
//   node scripts/control-panel-real-orders.mjs          # pick them
//   node scripts/control-panel-real-orders.mjs --clean  # release them
//
// WHY THESE FIVE. The panel shows "Contact florist" only when there is nobody
// left to EMAIL (the order is `escalated`) and somebody we emailed never
// answered — see docs/order-flow/4-cx-the-one-button.md. That rule has four
// distinct outcomes, and a demo that does not contain all four cannot be judged:
//
//   escalated + shops emailed and silent  → BUTTON
//   escalated + nobody ever emailed       → no button (find more florists)
//   still emailing (reaching_out)         → no button (not yours yet)
//   nothing sent yet (received)           → no button (the engine is starting)
//
// The states are NOT fabricated here. Every assignment history below was
// produced by the real matcher and the real wave engine during earlier testing,
// so what the panel renders is what the engine actually did. This script only
// decides which orders are IN the working set; it writes nothing else.
//
// HOW IT PICKS. `orders.worklist_at` — an explicit staff pick, the documented
// second half of the working-set gate (lib/workingSet.ts). It does NOT touch
// `app_settings.active_order_tags`, which stays empty, so the gate has exactly
// the shape production uses: no tags, a handful of explicit picks.
//
// WHAT THIS TURNS ON. A picked order is one the wave engine may act on. Staging
// runs in test_mode, which redirects every florist email to the staff address,
// and the preflight below refuses to run if that is not true.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const clean = process.argv.includes("--clean");

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })
);
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });
console.log(`→ ${url}`);

/**
 * The five, what each is here to prove, and how far out it is due.
 *
 * NOTHING IS OVERDUE. An order past its delivery date would have been dealt
 * with long before it reached this panel in production, so a demo full of them
 * teaches the wrong reflex — everything looks like an emergency and the ranking
 * has nothing to sort. These are tomorrow onwards, which is what a real morning
 * queue looks like.
 *
 * `dueInDays` is applied at seed time rather than hard-coded, so re-running this
 * refreshes the window instead of leaving yesterday's dates behind. That is the
 * same reason scripts/seed-placement-test.mjs computes its deadlines: the demo
 * fixture before it aged out silently, and a past-deadline order is not merely
 * stale — waves.ts refuses to offer one at all and re-escalates it as
 * `past_delivery_deadline`, so every scenario reports the same wrong answer.
 */
const PICKS = [
  { name: "#2000021", dueInDays: 1, shows: "ESCALATED + button — 14 shops emailed, all silent (real Shopify order, Marseille FR)" },
  { name: "#FIND-08", dueInDays: 2, shows: "ESCALATED + button — 9 emailed and silent, 3 refused; the card must skip the refusals" },
  { name: "#FIND-05", dueInDays: 3, shows: "ESCALATED, no button — nobody was ever emailed, so there is nobody to ring" },
  { name: "#FIND-03", dueInDays: 4, shows: "NO LIVE OFFER, no button — the engine still has candidates and is emailing" },
  { name: "#2000028", dueInDays: 5, shows: "RECEIVED, no button — nothing sent yet (real Shopify order, Kfar Saba IL)" },
];
const NAMES = PICKS.map((p) => p.name);

/** 11:00 local, `days` from now — a plausible delivery slot rather than a
 *  timestamp that happens to be whatever o'clock the script ran at. */
function dueAt(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(11, 0, 0, 0);
  return d.toISOString();
}

// ── preflight ──────────────────────────────────────────────────────────────
// Only matters when picking: releasing is safe under any settings.
if (!clean) {
  const { data: s, error } = await db.from("app_settings").select("test_mode, test_email, active_order_tags").maybeSingle();
  if (error) { console.error("could not read app_settings:", error.message); process.exit(1); }
  if (!s?.test_mode) {
    console.error("REFUSING: app_settings.test_mode is off. Picking these would send offers to real florists.");
    process.exit(1);
  }
  console.log(`  test_mode on, florist mail redirected to ${s.test_email ?? "(test_email unset)"}`);
  const tags = (s.active_order_tags ?? []).filter((t) => String(t).trim());
  if (tags.length) {
    console.log(`  NOTE active_order_tags is set to [${tags.join(", ")}] — the working set is the UNION of`);
    console.log("       those tags and these picks, so the panel will show more than five rows.");
    console.log("       Clear it in Settings → Orders for a five-row panel.");
  }
}

const { data: found, error: findErr } = await db
  .from("orders")
  .select("id, order_name, status")
  .in("order_name", NAMES)
  .is("deleted_at", null);
if (findErr) { console.error("lookup failed:", findErr.message); process.exit(1); }

const missing = NAMES.filter((n) => !(found ?? []).some((o) => o.order_name === n));
if (missing.length) console.log(`  not on this database (skipped): ${missing.join(", ")}`);

const ids = (found ?? []).map((o) => o.id);
if (ids.length === 0) { console.log("nothing to do"); process.exit(0); }

if (clean) {
  const { error } = await db.from("orders").update({ worklist_at: null, worklist_by: null }).in("id", ids);
  if (error) { console.error("update failed:", error.message); process.exit(1); }
  console.log(`\nreleased ${ids.length} orders from the working set.`);
  process.exit(0);
}

// EVERYTHING ELSE OUT FIRST. Without this the five are merely added to whatever
// was already picked, and the panel shows a crowd rather than the five cases.
// Only explicit picks are cleared — no tags are touched, nothing is deleted.
const { error: clearErr, count: cleared } = await db
  .from("orders")
  .update({ worklist_at: null, worklist_by: null }, { count: "exact" })
  .not("worklist_at", "is", null)
  .not("id", "in", `(${ids.join(",")})`);
if (clearErr) { console.error("could not clear the previous working set:", clearErr.message); process.exit(1); }

// Pick them, and move each onto its slot in the coming week. The delivery date
// is set per order, so this is one write each rather than one for the batch.
for (const p of PICKS) {
  const o = (found ?? []).find((x) => x.order_name === p.name);
  if (!o) continue;
  const { error } = await db
    .from("orders")
    .update({
      worklist_at: new Date().toISOString(),
      worklist_by: "control-panel-qa",
      delivery_at: dueAt(p.dueInDays),
    })
    .eq("id", o.id);
  if (error) { console.error(`update failed for ${p.name}:`, error.message); process.exit(1); }
}

console.log(`\nreleased ${cleared ?? 0} previously-picked orders; the working set is now these ${ids.length}:\n`);
for (const p of PICKS) {
  const o = (found ?? []).find((x) => x.order_name === p.name);
  if (!o) continue;
  const when = p.dueInDays === 1 ? "tomorrow" : `in ${p.dueInDays} days`;
  console.log(`  ${p.name.padEnd(11)} ${String(o.status).padEnd(13)} due ${when.padEnd(11)} ${p.shows}`);
}
console.log("\nNext: node --import ./scripts/alias-loader-register.mjs scripts/check-control-panel.mjs");

// Render, in the terminal, exactly the table the Control panel will show —
// against the REAL staging database, real orders, no fixtures.
//
//   node --import ./scripts/alias-loader-register.mjs scripts/check-control-panel.mjs
//
// It runs the same three steps app/(staff)/page.tsx runs, in the same order and
// through the same modules:
//
//   1. gatherAttention()  — which orders need a human (working-set gated)
//   2. byDeadline()       — the ranking: overdue first, then soonest
//   3. the hydration query + the four cells
//
// then re-checks the three things that could silently be wrong on the page:
// that the row count still equals the sidebar badge, that the ranking really is
// monotonic by deadline, and that every filter option offered actually matches
// rows. READ-ONLY — it writes nothing and sends nothing.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { gatherAttention, countAttention } from "../lib/cxAttention.ts";
import { byDeadline } from "../lib/operator.ts";
import { deriveCity, deriveCountry } from "../components/orders/orderDerive.ts";
import {
  applyControlFilters,
  destinationOptions,
  statusOptions,
  controlChip,
  showContactFlorist,
  timeLeftLabel,
} from "../lib/controlPanel.ts";

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
console.log(`→ ${url}\n`);

// ── 1 + 2. the page's own row source and ranking ───────────────────────────
const attn = byDeadline(await gatherAttention(db));
const badge = await countAttention(db);

// ── 3. the hydration the page does ─────────────────────────────────────────
const ids = attn.map((r) => r.orderId);
const { data: detail, error } = ids.length
  ? await db
      .from("orders")
      .select("id, order_name, status, delivery_area, delivery_address, delivery_at, delivery_window, order_assignments(status, withdrawn_at)")
      .in("id", ids)
  : { data: [], error: null };
if (error) {
  console.error("hydration query failed:", error.message);
  process.exit(1);
}
const byId = new Map((detail ?? []).map((o) => [o.id, o]));

const rows = attn.map((r) => {
  const d = byId.get(r.orderId) ?? {};
  const place = [deriveCity(d), deriveCountry(d)].filter((s) => s && s !== "—").join(", ");
  return {
    id: r.orderId,
    orderName: r.orderName,
    destination: place || "—",
    status: d.status ?? "received",
    deliveryAt: r.deliveryAt,
    deliveryWindow: d.delivery_window ?? null,
    assignments: (d.order_assignments ?? []).map((a) => ({ status: a.status, withdrawnAt: a.withdrawn_at ?? null })),
    reason: r.primary.label,
    severity: r.urgency >= 80 ? "crit" : "warn",
  };
});

// ── the table, as it will appear ───────────────────────────────────────────
const now = Date.now();
const pad = (v, n) => String(v ?? "").slice(0, n).padEnd(n);

console.log(
  `${pad("ORDER", 12)} ${pad("DESTINATION", 22)} ${pad("STATUS", 36)} ${pad("DELIVERY", 12)} ${pad("TIME LEFT", 14)} ACTION`
);
console.log("-".repeat(116));
for (const r of rows) {
  const chip = controlChip(r, now);
  const day = r.deliveryAt ? new Date(r.deliveryAt).toISOString().slice(0, 10) : "—";
  console.log(
    `${pad(r.orderName ?? r.id.slice(0, 8), 12)} ${pad(r.destination, 22)} ${pad(chip.label, 36)} ${pad(day, 12)} ${pad(timeLeftLabel(r.deliveryAt, now), 14)} ${showContactFlorist(r) ? "[Contact florist]" : ""}`
  );
}
if (rows.length === 0) console.log("(empty — nothing needs a human right now)");

// ── the three things that could be silently wrong ──────────────────────────
console.log("\nCHECKS");

const countOk = rows.length === badge;
console.log(`  ${countOk ? "ok  " : "FAIL"} row count (${rows.length}) equals the sidebar badge (${badge})`);

// Ranking: overdue first (most overdue at the top), then soonest. Anything
// without a date sorts last. This is the whole promise of the page.
const key_ = (r) => {
  const t = r.deliveryAt ? Date.parse(r.deliveryAt) : NaN;
  return Number.isNaN(t) ? Infinity : t - now;
};
let rankOk = true;
for (let i = 1; i < rows.length; i++) if (key_(rows[i - 1]) > key_(rows[i])) rankOk = false;
console.log(`  ${rankOk ? "ok  " : "FAIL"} ranked by deadline — most overdue first, then soonest`);

// Every option the filter offers must match at least one visible row, or the
// operator gets an empty table from a filter the page itself suggested.
let optOk = true;
for (const d of destinationOptions(rows)) {
  const n = applyControlFilters(rows, { destination: d }).length;
  if (n === 0) { optOk = false; console.log(`       destination "${d}" matches nothing`); }
}
for (const f of statusOptions(rows, now)) {
  const n = applyControlFilters(rows, { status: [f] }, now).length;
  if (n === 0) { optOk = false; console.log(`       status "${f}" matches nothing`); }
}
console.log(`  ${optOk ? "ok  " : "FAIL"} every offered filter option matches at least one row`);

// The button rule, spelled out per row, so it can be checked against real data
// rather than asserted. Every "no button" gets a reason.
const withButton = rows.filter(showContactFlorist);
console.log(`\n  BUTTON on ${withButton.length} of ${rows.length} rows`);
for (const r of rows) {
  const who = (r.orderName ?? r.id.slice(0, 8)).padEnd(12);
  if (showContactFlorist(r)) {
    const silent = r.assignments.filter((a) => !a.withdrawnAt && ["sent", "opened", "expired"].includes(a.status)).length;
    console.log(`    yes  ${who} escalated, ${silent} shop${silent === 1 ? "" : "s"} emailed and silent`);
  } else if (r.status !== "escalated") {
    console.log(`    no   ${who} not escalated (${r.status}) — the engine still has someone to email`);
  } else {
    console.log(`    no   ${who} escalated, but nobody was emailed and left silent — find more florists`);
  }
}

console.log(
  `\n  destinations: ${destinationOptions(rows).join(" | ") || "(none)"}` +
  `\n  statuses:     ${statusOptions(rows, now).join(" | ") || "(none)"}`
);

// "Due today" is the case the whole design is for — show what that filter gives.
const today = new Date().toISOString().slice(0, 10);
const todayRows = applyControlFilters(rows, { from: today, to: today });
console.log(`\n  due today (${today}): ${todayRows.length} of ${rows.length}`);

process.exit(countOk && rankOk && optOk ? 0 : 1);

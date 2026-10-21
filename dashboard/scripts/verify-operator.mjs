// Print exactly what /operator will render, using the REAL modules the page
// uses — lib/cxAttention.ts::gatherAttention for the queue and its ranking,
// lib/operator.ts for the sentence, the button and the countdown.
//
//   node --import ./scripts/alias-loader-register.mjs scripts/verify-operator.mjs
//
// This is the check that the page is correct end-to-end against the staging
// database, short of a browser: same queries, same working-set gate, same
// priority order, same copy. If a row reads wrong here it reads wrong on the
// page. Read-only — it writes nothing.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { gatherAttention } from "@/lib/cxAttention";
import { byDeadline, countdown, operatorAction, operatorHref } from "@/lib/operator";

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

// The service key, standing in for the staff session client the page uses.
// RLS is what the page relies on; this bypasses it, so the row SET here is a
// superset of nothing — every table gatherAttention reads has a staff read
// policy, so the two agree.
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const rows = byDeadline(await gatherAttention(db));
console.log(`\ngatherAttention returned ${rows.length} order(s), in the order the panel renders them:\n`);
console.log(
  `${"COUNTDOWN".padEnd(15)}${"ORDER".padEnd(24)}${"WHAT IS WRONG".padEnd(42)}${"BUTTON".padEnd(26)}LINK`
);
console.log("─".repeat(130));

for (const r of rows) {
  const a = operatorAction(r.primary);
  const c = countdown(r.deliveryAt);
  const cd = `${c.value} ${c.unit}`;
  console.log(
    `${cd.padEnd(15)}${(r.orderName ?? r.orderId.slice(0, 8)).padEnd(24)}${a.headline.padEnd(42)}${a.action.padEnd(26)}${operatorHref(r.orderId, a)}`
  );
}

// A sentence that still contains our own vocabulary is the failure this whole
// page exists to prevent, so check for it rather than trusting the eye.
const JARGON = ["escalat", "sla", "wave", "candidate", "payout", "reach-out", "status", "held", "outbox"];
const leaks = [];
for (const r of rows) {
  const a = operatorAction(r.primary);
  for (const w of JARGON) {
    if (a.headline.toLowerCase().includes(w) || a.action.toLowerCase().includes(w)) {
      leaks.push(`${r.orderName}: "${a.headline}" / "${a.action}" contains "${w}"`);
    }
  }
}
console.log(leaks.length ? `\n✗ jargon leaked:\n  ${leaks.join("\n  ")}` : "\n✓ no internal vocabulary in any headline or button");

// The ranking promise: reading the page top to bottom IS the order to work in.
// That only holds if the countdown column never goes backwards — the check the
// eye does, made explicit.
let ok = true;
let prev = -Infinity;
for (const r of rows) {
  const left = r.deliveryAt ? new Date(r.deliveryAt).getTime() - Date.now() : Number.POSITIVE_INFINITY;
  const k = Number.isNaN(left) ? Number.POSITIVE_INFINITY : left;
  if (k < prev) ok = false;
  prev = k;
}
console.log(ok ? "✓ the countdown column never goes backwards" : "✗ rows are NOT in deadline order");

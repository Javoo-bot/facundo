#!/usr/bin/env node
// Read-only LIVE check for the Demo Control Room (/testing): fetches
// GET /api/testing/orders from a running dashboard and reports which of the
// six lib/testing/orderScenarios.ts presets are present with the expected
// status/assignment pattern, using lib/testing/demoQaCheck.ts. This is the
// automated half of docs/demo-control-room-qa-runbook.md's "verify all
// scenario rows exist" step — run the runbook's manual steps to create the
// scenarios first, then this to confirm they landed.
//
// SAFETY:
//   - Read-only. This script only ever calls GET /api/testing/orders — it
//     never calls setup / setup_all / cleanup. Creating and clearing demo
//     data stays a deliberate, presenter-driven action in the /testing UI
//     (see the runbook), never something a script does on its own.
//   - Fails closed. It makes zero network calls unless ALL THREE of
//     FACUNDO_DEMO_QA_BASE_URL, FACUNDO_DEMO_QA_ALLOW_LIVE=1, and
//     FACUNDO_DEMO_QA_SESSION_COOKIE are set — so a stray `node
//     scripts/demo-qa-check.mjs` (or a CI job that happens to import this
//     file) can never accidentally hit a real environment.
//   - Never logs the session cookie. Only the target URL and the scenario
//     report are printed.
//   - Point FACUNDO_DEMO_QA_BASE_URL only at a dashboard you are actively
//     running a demo/QA pass against (local dev or a staging deploy) — this
//     reads whatever demo orders that environment currently has, real
//     production data is never touched by this script (the endpoint itself
//     only ever returns orders.is_demo=true rows).

import { verifyScenarioCoverage, summarizeScenarioCoverage } from "../lib/testing/demoQaCheck.ts";

/** Pure env → go/no-go decision, kept separate from the actual fetch so it's
 *  testable without a network call. Fails closed: any missing/malformed piece
 *  refuses to run rather than guessing a default. */
export function resolveLiveGate(env) {
  const baseUrl = (env.FACUNDO_DEMO_QA_BASE_URL ?? "").trim();
  const allowLive = env.FACUNDO_DEMO_QA_ALLOW_LIVE === "1";
  const cookie = (env.FACUNDO_DEMO_QA_SESSION_COOKIE ?? "").trim();

  if (!baseUrl) return { ok: false, reason: "FACUNDO_DEMO_QA_BASE_URL is not set." };
  if (!allowLive) return { ok: false, reason: "FACUNDO_DEMO_QA_ALLOW_LIVE=1 is not set — refusing to make a live request." };
  if (!cookie) return { ok: false, reason: "FACUNDO_DEMO_QA_SESSION_COOKIE is not set — an authenticated admin session cookie is required." };
  return { ok: true, baseUrl: baseUrl.replace(/\/+$/, ""), cookie };
}

async function main() {
  const gate = resolveLiveGate(process.env);
  if (!gate.ok) {
    console.error(`Refusing to run: ${gate.reason}`);
    console.error(
      "Set FACUNDO_DEMO_QA_BASE_URL, FACUNDO_DEMO_QA_ALLOW_LIVE=1, and FACUNDO_DEMO_QA_SESSION_COOKIE " +
        "(copied from an authenticated admin browser session's Cookie header) to run this against a real dashboard. " +
        "See docs/demo-control-room-qa-runbook.md."
    );
    process.exitCode = 1;
    return;
  }

  const url = `${gate.baseUrl}/api/testing/orders`;
  console.log(`GET ${url}`);

  let res;
  try {
    res = await fetch(url, { headers: { Cookie: gate.cookie } });
  } catch (e) {
    console.error(`Request failed: ${e instanceof Error ? e.message : "unknown error"}`);
    process.exitCode = 1;
    return;
  }
  if (!res.ok) {
    console.error(`Request failed: ${res.status} ${res.statusText} — is the session cookie still valid, and is this account role=admin?`);
    process.exitCode = 1;
    return;
  }

  const body = await res.json();
  const results = verifyScenarioCoverage(body.orders);
  const summary = summarizeScenarioCoverage(results);

  console.log(`\nScenario coverage: ${summary.covered}/${summary.total} OK\n`);
  for (const r of results) {
    const mark = r.present && r.assignmentOk ? "✅" : "❌";
    console.log(`${mark} ${r.label} (${r.scenarioId})${r.orderId ? ` — order ${r.orderId}` : ""}`);
    for (const issue of r.issues) console.log(`   ${issue}`);
  }

  if (!summary.ok) {
    console.error(`\n${summary.missing.length} missing, ${summary.mismatched.length} mismatched. See docs/demo-control-room-qa-runbook.md, section "Troubleshooting".`);
    process.exitCode = 1;
  } else {
    console.log("\nAll scenarios present with the expected status/assignment pattern.");
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main();
}

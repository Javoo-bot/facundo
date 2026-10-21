#!/usr/bin/env node
// Backup for GitHub's scheduler, which skips scheduled runs under load (it
// dropped the 04:00 UTC weather and report on 2026-10-14). Run on the laptop
// after the morning slot: for each daily garden workflow, if no run started
// today (UTC), dispatch one on GitHub. Nothing garden-related runs locally, and
// both workflows are idempotent per day, so a late double start is harmless.
//
// Scheduled by Windows Task Scheduler as Facundo-Garden-Backup (see run-backup.vbs).
import { execFileSync } from "node:child_process";

const WORKFLOWS = ["Garden weather", "Garden daily report"];
const today = new Date().toISOString().slice(0, 10);

const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", cwd: import.meta.dirname });

for (const name of WORKFLOWS) {
  const runs = JSON.parse(gh("run", "list", "--workflow", name, "--limit", "20", "--json", "createdAt,status,conclusion"));
  const ranToday = runs.some((r) => r.createdAt.startsWith(today) && r.conclusion !== "failure" && r.conclusion !== "cancelled");
  if (ranToday) {
    console.log(`${new Date().toISOString()} ${name}: already ran today`);
    continue;
  }
  gh("workflow", "run", name);
  console.log(`${new Date().toISOString()} ${name}: GitHub skipped it, dispatched now`);
}

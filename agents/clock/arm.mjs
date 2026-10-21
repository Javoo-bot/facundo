#!/usr/bin/env node
// Switches the deployed clock from dry run to live, once main's workflow files
// have no GitHub cron left (otherwise both clocks would fire).
//
//   node agents/clock/arm.mjs <path to .env holding GITHUB_DISPATCH_TOKEN>
//
// Proves the token by dispatching factory-sweep.yml (a harmless sweep), stores
// it in Trigger.dev prod, then deletes CLOCK_DRY_RUN. The Trigger.dev access
// token comes from TRIGGER_ACCESS_TOKEN or the `trigger login` profile.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { REPO, GITHUB_API_VERSION } from "./jobs.ts";

const PROJECT = "proj_your_project_ref";
const WORKFLOWS = ["garden-weather.yml", "garden-daily.yml", "factory-sweep.yml", "factory-execute.yml"];

const envFile = process.argv[2] ?? ".env";
const dispatchToken = readFileSync(envFile, "utf8").match(/^GITHUB_DISPATCH_TOKEN=["']?([^"'\r\n]+)/m)?.[1];
if (!dispatchToken) throw new Error(`GITHUB_DISPATCH_TOKEN not found in ${envFile}`);

function triggerAccessToken() {
  if (process.env.TRIGGER_ACCESS_TOKEN) return process.env.TRIGGER_ACCESS_TOKEN;
  const home = process.env.APPDATA ? `${process.env.APPDATA}/xdg.config` : `${process.env.HOME}/.config`;
  const cfg = JSON.parse(readFileSync(`${home}/trigger/config.json`, "utf8"));
  return cfg.profiles[cfg.currentProfile ?? "default"].accessToken;
}

for (const wf of WORKFLOWS) {
  const yaml = execFileSync("gh", ["api", `repos/${REPO}/contents/.github/workflows/${wf}?ref=main`, "-H", "Accept: application/vnd.github.raw"], { encoding: "utf8" });
  if (/^\s+schedule:/m.test(yaml)) throw new Error(`main's ${wf} still has a GitHub cron; land the workflow commit first`);
  if (wf === "garden-weather.yml" && !/^\s+mode:/m.test(yaml)) throw new Error("main's garden-weather.yml has no mode input yet");
}

const proof = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/factory-sweep.yml/dispatches`, {
  method: "POST",
  headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${dispatchToken}`, "X-GitHub-Api-Version": GITHUB_API_VERSION, "User-Agent": "facundo-garden-clock" },
  body: JSON.stringify({ ref: "main" }),
});
if (!proof.ok) throw new Error(`the token cannot dispatch: ${proof.status} ${await proof.text()}`);
console.log("token dispatched factory-sweep:", (await proof.json().catch(() => ({}))).html_url ?? "(no run url)");

const trigger = (path, init = {}) =>
  fetch(`https://api.trigger.dev/api/v1/projects/${PROJECT}/envvars/prod${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${triggerAccessToken()}`, "Content-Type": "application/json" },
  });

const set = await trigger("", { method: "POST", body: JSON.stringify({ name: "GITHUB_DISPATCH_TOKEN", value: dispatchToken }) });
const update = set.ok ? set : await trigger("/GITHUB_DISPATCH_TOKEN", { method: "PUT", body: JSON.stringify({ value: dispatchToken }) });
if (!update.ok) throw new Error(`could not store the token in Trigger.dev: ${update.status} ${await update.text()}`);
console.log("GITHUB_DISPATCH_TOKEN stored in Trigger.dev prod");

const del = await trigger("/CLOCK_DRY_RUN", { method: "DELETE" });
if (!del.ok && del.status !== 404) throw new Error(`could not delete CLOCK_DRY_RUN: ${del.status} ${await del.text()}`);
console.log("CLOCK_DRY_RUN removed: the clock is live");

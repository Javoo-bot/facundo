import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JOBS, dispatchRequest, readOutcome } from "./jobs.ts";

const WORKFLOWS_DIR = new URL("../../.github/workflows/", import.meta.url);

test("the schedule the owner chose, in UTC", () => {
  const table = Object.values(JOBS).map((j) => [j.cron, j.workflow, "inputs" in j ? j.inputs.mode : null]);
  assert.deepEqual(table, [
    ["0 4 * * *", "garden-weather.yml", "plant"],
    ["30 7 * * *", "garden-weather.yml", "puppet"],
    ["30 10 * * *", "garden-weather.yml", "puppet"],
    ["30 4 * * *", "garden-daily.yml", null],
    ["*/30 * * * *", "factory-sweep.yml", null],
    ["0 7 * * *", "factory-execute.yml", null],
    ["0 13 * * *", "factory-execute.yml", null],
  ]);
});

test("task ids are unique", () => {
  const ids = Object.values(JOBS).map((j) => j.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("dispatch targets the workflow on main with the job's inputs", () => {
  assert.deepEqual(dispatchRequest(JOBS.weatherPuppetLate), {
    url: "https://api.github.com/repos/your-org/agent-factory/actions/workflows/garden-weather.yml/dispatches",
    body: { ref: "main", inputs: { mode: "puppet" } },
  });
  assert.deepEqual(dispatchRequest(JOBS.factorySweep).body, { ref: "main" });
});

for (const job of Object.values(JOBS)) {
  test(`${job.workflow} can be dispatched by ${job.id} and has no GitHub cron of its own`, () => {
    const yaml = readFileSync(new URL(job.workflow, WORKFLOWS_DIR), "utf8");
    assert.match(yaml, /^\s+workflow_dispatch:/m);
    assert.doesNotMatch(yaml, /^\s+schedule:/m, "GitHub cron would double-run with the Trigger.dev clock");
    for (const input of Object.keys("inputs" in job ? job.inputs : {})) {
      assert.match(yaml, new RegExp(`^\\s+${input}:`, "m"), `workflow does not declare input ${input}`);
    }
  });
}

test("a 200 with run details reports the run's page", () => {
  assert.deepEqual(readOutcome(200, { workflow_run_id: 1, html_url: "https://github.com/x/runs/1" }), {
    kind: "dispatched",
    runUrl: "https://github.com/x/runs/1",
  });
  assert.deepEqual(readOutcome(204, null), { kind: "dispatched", runUrl: null });
});

test("a workflow not yet on main is a no-op, not a failure", () => {
  assert.deepEqual(readOutcome(404, { message: "Not Found" }), { kind: "workflow-not-on-main" });
});

test("only server errors and rate limits are retried", () => {
  assert.deepEqual(readOutcome(401, { message: "Bad credentials" }), { kind: "failed", status: 401, retry: false, message: "Bad credentials" });
  const retried = (status: number) => {
    const o = readOutcome(status, null);
    return o.kind === "failed" && o.retry;
  };
  assert.deepEqual([422, 403, 429, 500, 502].map(retried), [false, false, true, true, true]);
});

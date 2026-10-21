// The garden's clock. Trigger.dev keeps the time; the work still runs on
// GitHub runners. Each job here becomes one Trigger.dev scheduled task that
// dispatches one GitHub workflow. GitHub reads the workflow file from `main`.

export const REPO = "your-org/agent-factory";
export const REF = "main";
export const GITHUB_API_VERSION = "2026-03-10";

export type Job = {
  id: string;
  cron: string;
  workflow: string;
  inputs?: Readonly<Record<string, string>>;
};

export const JOBS = {
  weatherPlant: { id: "garden-weather-plant", cron: "0 4 * * *", workflow: "garden-weather.yml", inputs: { mode: "plant" } },
  weatherPuppetMorning: { id: "garden-weather-puppet-0730", cron: "30 7 * * *", workflow: "garden-weather.yml", inputs: { mode: "puppet" } },
  weatherPuppetLate: { id: "garden-weather-puppet-1030", cron: "30 10 * * *", workflow: "garden-weather.yml", inputs: { mode: "puppet" } },
  gardenDaily: { id: "garden-daily", cron: "30 4 * * *", workflow: "garden-daily.yml" },
  factorySweep: { id: "factory-sweep", cron: "*/30 * * * *", workflow: "factory-sweep.yml" },
  factoryExecuteMorning: { id: "factory-execute-0700", cron: "0 7 * * *", workflow: "factory-execute.yml" },
  factoryExecuteAfternoon: { id: "factory-execute-1300", cron: "0 13 * * *", workflow: "factory-execute.yml" },
} as const satisfies Record<string, Job>;

export type DispatchRequest = {
  url: string;
  body: { ref: string; inputs?: Readonly<Record<string, string>> };
};

export function dispatchRequest(job: Job): DispatchRequest {
  return {
    url: `https://api.github.com/repos/${REPO}/actions/workflows/${job.workflow}/dispatches`,
    body: job.inputs ? { ref: REF, inputs: job.inputs } : { ref: REF },
  };
}

// 404 means the workflow file is not on `main` (yet): a logged no-op, not a
// failure. 5xx is worth a retry;
// any other 4xx (bad token, unknown input) will not fix itself.
export type Outcome =
  | { kind: "dispatched"; runUrl: string | null }
  | { kind: "workflow-not-on-main" }
  | { kind: "failed"; status: number; retry: boolean; message: string };

export function readOutcome(status: number, body: unknown): Outcome {
  if (status === 200 || status === 204) {
    const runUrl = typeof body === "object" && body !== null && "html_url" in body && typeof body.html_url === "string" ? body.html_url : null;
    return { kind: "dispatched", runUrl };
  }
  if (status === 404) return { kind: "workflow-not-on-main" };
  const message = typeof body === "object" && body !== null && "message" in body ? String(body.message) : `HTTP ${status}`;
  return { kind: "failed", status, retry: status >= 500 || status === 429, message };
}

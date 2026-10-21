import { AbortTaskRunError, logger, schedules } from "@trigger.dev/sdk";
import { GITHUB_API_VERSION, JOBS, dispatchRequest, readOutcome, type Job } from "../jobs.ts";

async function dispatch(job: Job) {
  const request = dispatchRequest(job);
  if (process.env.CLOCK_DRY_RUN === "1") {
    logger.info("dry run: would dispatch", { ...request });
    return { kind: "dry-run" as const, ...request };
  }
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) throw new AbortTaskRunError("GITHUB_DISPATCH_TOKEN is not set in this Trigger.dev environment");

  const res = await fetch(request.url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "facundo-garden-clock",
    },
    body: JSON.stringify(request.body),
    signal: AbortSignal.timeout(20_000),
  });
  const outcome = readOutcome(res.status, await res.json().catch(() => null));

  if (outcome.kind === "workflow-not-on-main") logger.warn(`${job.workflow} is not on main yet, nothing dispatched`);
  if (outcome.kind === "dispatched") logger.info(`dispatched ${job.workflow}`, { run: outcome.runUrl });
  if (outcome.kind === "failed") {
    const message = `GitHub refused ${job.workflow}: ${outcome.status} ${outcome.message}`;
    throw outcome.retry ? new Error(message) : new AbortTaskRunError(message);
  }
  return outcome;
}

function clockTask(job: Job) {
  return schedules.task({
    id: job.id,
    cron: { pattern: job.cron, timezone: "UTC", window: "0m", environments: ["PRODUCTION"] },
    maxDuration: 60,
    run: () => dispatch(job),
  });
}

export const gardenWeatherPlant = clockTask(JOBS.weatherPlant);
export const gardenWeatherPuppetMorning = clockTask(JOBS.weatherPuppetMorning);
export const gardenWeatherPuppetLate = clockTask(JOBS.weatherPuppetLate);
export const gardenDaily = clockTask(JOBS.gardenDaily);
export const factorySweep = clockTask(JOBS.factorySweep);
export const factoryExecuteMorning = clockTask(JOBS.factoryExecuteMorning);
export const factoryExecuteAfternoon = clockTask(JOBS.factoryExecuteAfternoon);

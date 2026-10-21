// Order-automation observability, via PostHog — the team's chosen sink (see
// CLAUDE.md), not Sentry. Deliberately NOT posthog-js: that's a browser
// singleton (dashboard/lib/analytics.ts) and would drag client-only code into
// this Worker's bundle. This POSTs straight to PostHog's HTTP capture
// endpoint instead — the whole vendor surface this file needs is one fetch
// call, so a Node SDK would be dependency weight for nothing.
//
// Every export no-ops (no fetch, never throws) when POSTHOG_PROJECT_TOKEN is
// unset, which is the normal case in local dev/tests — nothing here needs a
// live PostHog project to pass typecheck/tests. A PostHog outage or bad
// token must never affect order handling: capture failures are swallowed
// (logged, not thrown) same as monitor.ts's default sink.
import { setErrorSink, defaultSink, type MonitorEvent } from "./monitor";
import type { Env } from "./types";

export const ORDER_AUTOMATION_FAILED = "order_automation_failed";
export const ORDER_MATCH_FAILED = "order_match_failed";
export const ORDER_WORKFLOW_STEP_FAILED = "order_workflow_step_failed";

const DEFAULT_HOST = "https://eu.i.posthog.com";

/**
 * Fire one structured order-automation event to PostHog.
 *
 * `distinctId` groups events the way PostHog needs a subject to group
 * by — pass the order id (or shopify order id) for anything order-scoped, or
 * a fixed value like "system" for a sweep-level event with no single order.
 * Never throws: callers on the order-handling hot path can call this
 * fire-and-forget (`.catch(() => {})` if awaited at all) without risking the
 * order itself.
 */
export async function captureAutomationEvent(
  env: Env,
  event: string,
  distinctId: string,
  properties?: Record<string, unknown>,
): Promise<void> {
  const token = env.POSTHOG_PROJECT_TOKEN;
  if (!token) return;
  const host = env.POSTHOG_HOST || DEFAULT_HOST;
  try {
    const res = await fetch(`${host}/capture/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: token,
        event,
        distinct_id: distinctId,
        properties: { ...properties, source: "ingest-worker", environment: env.POSTHOG_ENVIRONMENT || "production" },
      }),
    });
    if (!res.ok) {
      console.error(JSON.stringify({ level: "warn", analytics: true, event, status: res.status }));
    }
  } catch (e) {
    console.error(
      JSON.stringify({ level: "warn", analytics: true, event, message: e instanceof Error ? e.message : String(e) }),
    );
  }
}

// captureError contexts that are genuinely order-automation health signals —
// this worker also runs the (unrelated) Discovery/Recruiting city-ingest
// pipeline (see CityIngestWorkflow, cron.claim_ingest_jobs), whose failures
// must NOT be mislabeled as order automation. Keep this list in step with
// the contexts actually passed to captureError() at Production call sites
// (index.ts webhook handlers, reconcile.ts).
const ORDER_AUTOMATION_CONTEXT_PREFIXES = ["webhook.", "reconcile.", "cron.reconcile", "cron.outbox_drain", "cron.waves_tick", "cron.cx_alert_sweep", "cron.payout_reconcile"];

function isOrderAutomationContext(context: string): boolean {
  return ORDER_AUTOMATION_CONTEXT_PREFIXES.some((prefix) => context.startsWith(prefix));
}

/**
 * Mirror order-related captureError(...) calls to a PostHog
 * `order_automation_failed` event, so the "N failures in 10m" alerting
 * monitor.ts's header comment describes for Sentry can be built on PostHog
 * instead. Registered once per entry point (fetch/scheduled/queue in
 * index.ts) rather than at module scope — `env` (and therefore the PostHog
 * token) is only reachable there, same constraint monitor.ts documents for a
 * DSN. `ctx.waitUntil` keeps the fire-and-forget POST alive past the
 * response/invocation, since the sink itself must stay synchronous
 * (ErrorSink's signature).
 *
 * MIRRORS to PostHog rather than replacing console output: a registered sink
 * makes captureError skip its own defaultSink call entirely (see monitor.ts),
 * so this calls defaultSink itself first — every captureError call keeps
 * logging to console.error exactly as before, on top of whichever ones also
 * reach PostHog.
 */
export function installAutomationErrorSink(env: Env, ctx: ExecutionContext): void {
  setErrorSink((event: MonitorEvent) => {
    defaultSink(event);
    if (!isOrderAutomationContext(event.context)) return;
    ctx.waitUntil(
      captureAutomationEvent(env, ORDER_AUTOMATION_FAILED, "system", {
        context: event.context,
        message: event.message,
      }),
    );
  });
}

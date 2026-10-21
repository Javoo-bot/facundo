// Dashboard server-side observability, via PostHog — the team's chosen sink (see CLAUDE.md), not
// Sentry. Deliberately NOT posthog-js: that's a browser singleton (lib/analytics.ts,
// instrumentation-client.ts) and would drag client-only code into server bundles. This POSTs
// straight to PostHog's HTTP capture endpoint instead, matching
// ingest-worker/src/analytics.ts::captureAutomationEvent — the whole vendor surface this file
// needs is one fetch call.
//
// Reads POSTHOG_PROJECT_TOKEN / POSTHOG_HOST directly off process.env, same as the other
// server-only secrets in this codebase (OPENROUTER_API_KEY, SUPABASE_SERVICE_ROLE_KEY — see
// lib/agentTurn.ts, lib/supabaseAdmin.ts). Deliberately NOT the NEXT_PUBLIC_POSTHOG_* pair
// instrumentation-client.ts uses: those are inlined into the client bundle at build time, but
// this is server code running at request time — wrangler.jsonc's nodejs_compat_populate_process_env
// is what makes a plain `wrangler secret put POSTHOG_PROJECT_TOKEN` readable here, unmodified.
//
// Every export no-ops (no fetch, never throws) when POSTHOG_PROJECT_TOKEN is unset, which is the
// normal case in local dev/tests. A PostHog outage or bad token must never affect a request:
// capture failures are swallowed (logged, not thrown), same as monitor.ts's default sink.
import { setErrorSink, defaultSink, type MonitorEvent } from "./monitor.ts";

// Stable event name every captureError() call is mirrored under — one event, not one per
// context, so a single PostHog insight/alert covers all dashboard server errors. `context`
// (e.g. "payout.failed", "waves.file_escalate") stays queryable as an event property instead.
export const DASHBOARD_SERVER_ERROR = "dashboard_server_error";

const DEFAULT_HOST = "https://eu.i.posthog.com";

/**
 * Fire one structured event to PostHog.
 *
 * `distinctId` groups events the way PostHog needs a subject to group by. captureError() has no
 * concept of "who"/"which order" — it's a generic (context, err) capture called from deep inside
 * error-handling call sites all over lib/ — so installServerErrorSink() always passes the fixed
 * value "system" here, same as the worker's sweep-level (no single order) events.
 *
 * Never throws: this must be safely fire-and-forget from a synchronous sink.
 */
export async function captureServerEvent(
  event: string,
  distinctId: string,
  properties?: Record<string, unknown>,
): Promise<void> {
  const token = process.env.POSTHOG_PROJECT_TOKEN;
  if (!token) return;
  const host = process.env.POSTHOG_HOST || DEFAULT_HOST;
  try {
    const res = await fetch(`${host}/capture/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: token,
        event,
        distinct_id: distinctId,
        // POSTHOG_ENVIRONMENT is "garden" only in wrangler.jsonc env.garden.vars: the garden
        // shares production's PostHog project, and this tag is how the two are told apart.
        properties: { ...properties, source: "dashboard", environment: process.env.POSTHOG_ENVIRONMENT || "production" },
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

/**
 * Mirror every captureError(...) call to a PostHog `dashboard_server_error` event, so the
 * "N failures in 10m" alerting monitor.ts's header comment describes can be built on PostHog.
 * Intended to be called once, from instrumentation.ts's register() — the one server bootstrap
 * hook Next.js runs before any request, mirroring how ingest-worker/src/index.ts calls
 * installAutomationErrorSink() from each Worker entry point.
 *
 * MIRRORS to PostHog rather than replacing console output: a registered sink makes captureError
 * skip its own defaultSink call entirely (see monitor.ts), so this calls defaultSink itself
 * first — every captureError call keeps logging to console.error exactly as before, on top of
 * also reaching PostHog.
 *
 * Only `context` and `message` are forwarded as properties — `stack` is deliberately dropped
 * (never sent to PostHog) since a stack trace can include file paths and argument values that
 * don't belong in a third-party analytics event; the full payload still reaches console.error
 * via defaultSink for anyone reading platform logs.
 *
 * Unlike ingest-worker's installAutomationErrorSink, there is no context allowlist: this Worker
 * process handles ONE app (not a second, unrelated pipeline sharing the runtime), so every
 * captureError call here is a dashboard server error worth mirroring.
 */
export function installServerErrorSink(): void {
  setErrorSink((event: MonitorEvent) => {
    defaultSink(event);
    // Best-effort, not awaited: captureError() is a synchronous void function called from deep
    // inside error-handling call sites, so this fire-and-forget POST can be cut off if the
    // request's Worker isolate is torn down immediately after the response is sent — the same
    // class of issue app/[code]/route.ts's hit-counter hit and fixed by awaiting instead.
    // Rearchitecting captureError() to be awaitable everywhere is out of scope here; in
    // practice most calls happen mid-request, not on the final response tick.
    captureServerEvent(DASHBOARD_SERVER_ERROR, "system", {
      context: event.context,
      message: event.message,
    }).catch(() => {
      // captureServerEvent already swallows its own errors; this is a defensive belt-and-
      // suspenders guard against a future edit breaking that invariant.
    });
  });
}

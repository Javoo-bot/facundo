// Minimal error capture. Emits a structured payload to console.error so go-live alerting
// (a log-drain "N failures in 10m" query) has one shape to match.
//
// The team's chosen tracker is PostHog, not Sentry (see CLAUDE.md) — lib/analytics.ts is the
// existing client-side PostHog seam (posthog-js), but that's browser-only and can't back a
// server-side sink here. lib/serverAnalytics.ts::installServerErrorSink() registers a sink here
// (from instrumentation.ts's register() — the one server-side bootstrap hook Next.js runs before
// any request) that mirrors every captureError call to a PostHog `dashboard_server_error` event,
// on top of — not instead of — this file's own console.error, matching the pattern
// ingest-worker/src/analytics.ts already ships and tests.
export interface MonitorEvent {
  level: "error";
  context: string;
  message: string;
  stack?: string;
  at: string;
}

export type ErrorSink = (event: MonitorEvent) => void;

// Exported so a registered sink (lib/serverAnalytics.ts::installServerErrorSink) can call it
// explicitly and MIRROR to a second destination rather than replacing it — captureError's own
// contract (below) only calls this when no sink is registered, or a registered one throws.
export function defaultSink(event: MonitorEvent): void {
  console.error(JSON.stringify({ level: event.level, monitor: true, context: event.context, message: event.message, stack: event.stack, at: event.at }));
}

let sink: ErrorSink | null = null;

/** Register (or clear, with null) a sink to receive future captureError events. */
export function setErrorSink(newSink: ErrorSink | null): void {
  sink = newSink;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") return message;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function captureError(context: string, err: unknown): void {
  const message = errorMessage(err);
  const stack = err instanceof Error ? err.stack : undefined;
  const event: MonitorEvent = { level: "error", context, message, stack, at: new Date().toISOString() };
  if (sink) {
    try {
      sink(event);
      return;
    } catch {
      // A registered sink must never swallow the original error — fall back to the
      // default console.error path below rather than losing it.
    }
  }
  defaultSink(event);
}

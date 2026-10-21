// Minimal error capture for the Worker. Emits a structured payload to console.error so
// go-live alerting (a log-drain "N failures in 10m" query) has one shape to match. The two
// classes that must page someone at launch are webhook-failure and payout-failure.
//
// The team's chosen tracker is PostHog, not Sentry (see CLAUDE.md) — analytics.ts's
// installAutomationErrorSink() already registers a sink here that mirrors every
// order-automation captureError context (webhook.*, reconcile.*, and a few cron.* ones — see
// its ORDER_AUTOMATION_CONTEXT_PREFIXES allowlist) to a PostHog `order_automation_failed`
// event, on top of — not instead of — this file's own console.error. Registered from one of
// the entry points in src/index.ts — fetch/scheduled/queue — since those are where `env` (and
// therefore the PostHog token) is reachable; captureError's signature intentionally does not
// take `env`, so an env-bearing sink must be registered from an entry point, not from inside
// this file. Contexts outside that allowlist (the Discovery/Recruiting city-ingest side of this
// same Worker, e.g. cron.claim_ingest_jobs) still only reach console.error — no PostHog tracker
// is wired for them yet.
export interface MonitorEvent {
  level: "error";
  context: string;
  message: string;
  stack?: string;
  at: string;
}

export type ErrorSink = (event: MonitorEvent) => void;

// Exported so a registered sink (analytics.ts::installAutomationErrorSink) can
// call it explicitly and MIRROR to a second destination rather than replacing
// it — captureError's own contract (below) only calls this when no sink is
// registered, or a registered one throws.
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

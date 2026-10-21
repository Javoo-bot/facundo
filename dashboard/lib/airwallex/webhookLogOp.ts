// Pure builder for the Airwallex webhook route's `external_ops` log entry —
// kept separate from route.ts so every branch (each verify-reject reason, the
// bad-json case, and success) is unit-testable without a DB.
//
// WHY THIS EXISTS. Before this, `app/api/webhooks/airwallex/route.ts` only
// wrote to `airwallex_events` AFTER `verifyWebhook` passed. A rejected
// delivery — e.g. `AIRWALLEX_WEBHOOK_SECRET` unset, so every delivery 401s —
// left literally zero trace anywhere: not in `airwallex_events`, not in
// `external_ops`, nowhere. That is indistinguishable from "Airwallex never
// registered a webhook endpoint at all", which is exactly the ambiguity that
// motivated this file (see the 2026-09-04 investigation on
// lib/lifecycle.ts's `pay-state-stale` branch).
//
// This never sees or logs the raw body, the signature, or any card data —
// only the event name/id (once we trust it enough to have parsed it) and,
// on rejection, the verify failure reason string.

import type { ExternalOp } from "../externalOps";

export interface WebhookLogInput {
  ok: boolean;
  statusCode: number;
  /** Verify failure reason (e.g. "no-secret-configured") or a processing
   *  failure like "bad-json". Never set together with ok:true. */
  error?: string | null;
  eventName?: string | null;
  eventId?: string | null;
}

export function webhookLogOp(input: WebhookLogInput): ExternalOp {
  return {
    provider: "airwallex",
    operation: "webhook_in",
    direction: "in",
    ok: input.ok,
    statusCode: input.statusCode,
    error: input.error ?? null,
    ref: input.eventId ?? null,
    meta: input.eventName ? { event: input.eventName } : null,
  };
}

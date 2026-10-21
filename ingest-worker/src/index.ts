// Worker entry: Cron-claim sweep (replaces the Mac-mini poller), Queue consumer
// (starts a Workflow per city), and a dev-only manual trigger.
import { createServiceClient, unwindOrder, clawbackOrder } from "./db";
import { verifyShopifyHmac, parseShopifyOrder } from "./shopify";
import { handleOrderUpdated } from "./lateMatch";
import { reconcileMissingOrders, reconcileOneOrder, reconcileOrders, reconcileAllOrders, armFullSweep } from "./reconcile";
import { captureError } from "./monitor";
import { installAutomationErrorSink } from "./analytics";
import { reapStaleRunningJobs } from "./jobs";
import { claimQueuedIngestJobs } from "./cronClaim";
import { sendDailyDigest, sendDigestReplay } from "./dailyDigest";
import { isActorsMinute, runGardenActors } from "./gardenActors";
import { isSherlockDailyCasesMinute, sherlockDailyCasesGate, enqueueSherlockDailyCases } from "./sherlockDailyCases";
import type { Env, CityJobMessage, OrderQueueMessage } from "./types";

// Record an inbound Shopify webhook in the shared external-operations log
// (backoffice → SYSTEM). Best-effort — never affects webhook handling.
async function logWebhookIn(env: Env, topic: string, shopifyId: string | null, ok: boolean, error?: string): Promise<void> {
  try {
    const sb = createServiceClient(env);
    await sb.from("external_ops").insert({
      provider: "shopify", operation: `webhook_${topic.replace(/\//g, "_")}`, direction: "in",
      ref: shopifyId, ok, error: error ?? null,
    });
  } catch { /* best-effort — logging must never break webhook handling */ }
}

// orders/cancelled → unwind the assignment + full clawback (idempotent).
async function handleCancel(env: Env, body: { id: unknown }): Promise<void> {
  const sb = createServiceClient(env);
  const id = await unwindOrder(sb, String(body.id));
  if (id) await clawbackOrder(sb, id, null);
}

// orders/edited → re-parse the new total; if the florist's payout should drop, partial clawback.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Shopify webhook payload is untyped JSON
async function handleEditClawback(env: Env, body: any): Promise<void> {
  const sb = createServiceClient(env);
  const { data: order } = await sb.from("orders").select("id").eq("shopify_order_id", String(body.id)).maybeSingle();
  if (!order) return;
  const { order: parsed } = parseShopifyOrder(body);
  await clawbackOrder(sb, order.id as string, parsed.total);
}

// Re-exported so the runtime can find the Workflow + Durable Object classes.
export { CityIngestWorkflow, EnrichBatchWorkflow } from "./workflow";
export { OrderWorkflow } from "./orderWorkflow";
export { BrowserPool } from "./browserPool";

async function postDashboardTick(base: string, path: string, headers: HeadersInit, context: string): Promise<void> {
  try {
    const res = await fetch(`${base}${path}`, { method: "POST", headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      captureError(context, new Error(`dashboard tick ${path} failed with ${res.status}${body ? `: ${body.slice(0, 500)}` : ""}`));
    }
  } catch (e) {
    captureError(context, e);
  }
}

export default {
  // Cron (every minute): claim queued ingest_jobs rows and enqueue them. The
  // atomic queued→running update is the claim; only rows we flip get enqueued,
  // so overlapping ticks never double-process.
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    installAutomationErrorSink(env, ctx);

    // Garden only, every 10 minutes. Not a second cron: a "*/10" trigger next to
    // this "* * * * *" one never fired on the garden (2026-10-14, 08:30 and 08:40
    // UTC). runGardenActors refuses unless every garden-only switch is present
    // (gardenActors.ts::actorsGate), so on production this is a no-op.
    if (isActorsMinute(event.scheduledTime)) {
      ctx.waitUntil(
        runGardenActors(env).then(
          (r) => {
            if (r.ran) console.log(`[garden-actors] due=${r.due}${r.lines.map((l) => `\n  ${l}`).join("")}`);
            else if (env.GARDEN_ACTORS) console.warn(`[garden-actors] skipped: ${r.reason}`);
          },
          (e) => captureError("cron.garden_actors", e),
        ),
      );
    }
    const sb = createServiceClient(env);

    // Garden only, once a day: queue a `repair` job (no Apify) for every city
    // with free-place-layer shops still carrying the "Unchecked" placeholder —
    // Sherlock's only source of real cases until the paid check exists. See
    // sherlockDailyCases.ts. A no-op on production (sherlockDailyCasesGate).
    if (isSherlockDailyCasesMinute(event.scheduledTime) && sherlockDailyCasesGate(env)) {
      ctx.waitUntil(
        enqueueSherlockDailyCases(sb).then(
          (r) => console.log(`[sherlock-daily-cases] queued=${r.queued.join(",") || "none"} skipped=${r.skipped.join(",") || "none"}`),
          (e) => captureError("cron.sherlock_daily_cases", e),
        ),
      );
    }

    // Reap jobs whose claimer died without writing a terminal status. Ahead of
    // the claim below because a wedged `running` row blocks its city from being
    // re-ingested at all (see config.ts::STALE_RUNNING_JOB_HOURS).
    const reaped = await reapStaleRunningJobs(sb);
    if (reaped > 0) console.warn(`[cron] reaped ${reaped} stale running ingest job(s)`);

    await claimQueuedIngestJobs(sb, env);

    // Missing-webhook reconciliation sweep — self-throttled to ~hourly, guarded
    // to a no-op when Shopify Admin creds are unset. A failure here can leave
    // order-working-set pilot orders stale, so it must be visible to the monitor
    // stream even though the next tick should continue.
    await reconcileMissingOrders(env).catch((e) => captureError("cron.reconcile_missing_orders", e));

    // Full-table catch-up sweep. Unlike the call above this is NOT throttled to
    // ~hourly — once armed it needs every tick to get through the whole table in
    // a reasonable time (~3.6k orders at 60/tick ≈ an hour). A no-op unless
    // someone armed it, and it disarms itself when it reaches the end.
    await reconcileAllOrders(env).catch((e) => captureError("cron.reconcile_all_orders", e));

    // Trigger the dashboard's cron-driven jobs (the effect logic — Airwallex/
    // Shopify/Resend, offer-wave advancement — lives in the dashboard, so we poke
    // its endpoints with the shared secret). They remain best-effort and the next
    // tick retries, but failures are now captured instead of being swallowed — a
    // silent wave/outbox failure is exactly how a working-set pilot order stalls.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- optional deploy vars not in the base Env type
    const anyEnv = env as any;
    if (anyEnv.OUTBOX_SECRET) {
      // These POST to host-agnostic /api/* routes; the backoffice host is the
      // canonical dashboard origin. Set DASHBOARD_URL per environment to override.
      const base = anyEnv.DASHBOARD_URL || "https://bo.fc.example.net";
      const headers = { "x-outbox-secret": anyEnv.OUTBOX_SECRET };
      // Durable payout/writeback retries.
      await postDashboardTick(base, "/api/outbox/drain", headers, "cron.outbox_drain");
      // Offer-wave engine: expire lapsed offers, advance to the next florist, escalate.
      await postDashboardTick(base, "/api/orders/waves/tick", headers, "cron.waves_tick");
      // CX single-point-of-failure fix: page staff (email + push) when the CX
      // attention queue has SLA-breaching / high-urgency work sitting
      // unattended. Self-throttled server-side — safe to poke every tick.
      await postDashboardTick(base, "/api/cx/alert-sweep", headers, "cron.cx_alert_sweep");
      // Outreach funnel: send whatever touch is due, park what isn't, stop runs
      // that have hit their cap. Ships dark — the route returns immediately
      // unless app_settings.sequence_enabled is on.
      await postDashboardTick(base, "/api/sequences/tick", headers, "cron.sequences_tick");
      // Held-payout sweep: release delivery legs whose hold was only the
      // operator's delivery-gate toggle, now that it's back off. Every other
      // hold reason (tier-hold, provisional-shop, photo-verdict) is left alone
      // — see dashboard/lib/payoutHold.ts::shouldSweepReleaseHeldPayout.
      await postDashboardTick(base, "/api/payouts/held-sweep", headers, "cron.held_payout_sweep");
      // Airwallex payout reconcile: the Shopify leg's `webhook-missing` fix
      // (reconcileMissingOrders, above) has no Airwallex equivalent — nothing
      // ever polled or repaired a payout whose webhook was dropped, which is
      // exactly how 38 card-rail payouts sat at `status='issued'` while
      // Airwallex itself showed real, often-cleared spend (2026-09-04). Reads
      // live Airwallex state and patches the stragglers; self-throttled
      // server-side (dashboard/lib/airwallex/reconcile.ts +
      // app_settings.payout_reconcile_last_run_at), so safe to poke every tick.
      await postDashboardTick(base, "/api/payouts/reconcile", headers, "cron.payout_reconcile");
    }

    // Daily automation digest: one email a day saying how much of yesterday's
    // order loop ran without a human. Gated internally on the local hour in
    // Europe/Madrid (Cloudflare crons are UTC-only, so an 08:00 UTC trigger
    // would drift by an hour across DST) and on an external_ops dedupe, so it
    // is safe to call on every tick. Never throws; a reporting email must not
    // be able to break the automation cron it shares an invocation with.
    const digest = await sendDailyDigest(env);
    if (digest.ran) console.log(`[cron] daily digest sent for ${digest.period} (${digest.emailId})`);

    // One-shot replay of an already-sent period to a single address, for
    // reviewing a format change against real numbers. Dedupes on its own key,
    // so it sends once however long DIGEST_REPLAY stays set, and a no-op
    // whenever it is unset.
    const replay = await sendDigestReplay(env);
    if (replay.ran) console.log(`[cron] digest replay sent for ${replay.period} (${replay.emailId})`);
  },

  // Queue consumer: one message per city → one Workflow instance (id = jobId,
  // unique per job row, so re-delivery won't spawn duplicates). The orders
  // queue is handled by the same consumer, keyed on the queue name: each
  // message starts one OrderWorkflow (id = shopifyOrderId, so a re-delivered
  // webhook is a no-op).
  async queue(batch: MessageBatch<CityJobMessage | OrderQueueMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
    installAutomationErrorSink(env, ctx);
    // Prefix, not equality: the staging deployment's queues carry a "-staging"
    // suffix (wrangler.jsonc env.staging), and an exact match silently routed
    // its order messages into the city branch — which is how staging's first
    // webhook order vanished into the DLQ on 2026-08-20.
    if (batch.queue.startsWith("orders-queue")) {
      for (const msg of batch.messages) {
        const body = msg.body as OrderQueueMessage;
        try {
          await env.ORDER_WORKFLOW.create({ id: body.shopifyOrderId, params: { raw: body.raw } });
          msg.ack();
        } catch (e) {
          const text = e instanceof Error ? e.message : String(e);
          if (text.includes("already exists")) msg.ack();
          else msg.retry();
        }
      }
      return;
    }
    for (const msg of batch.messages) {
      const body = msg.body as CityJobMessage;
      try {
        await env.CITY_WORKFLOW.create({ id: body.jobId, params: body });
        msg.ack();
      } catch (e) {
        // An "instance already exists" error means the workflow is already
        // running for this job — ack rather than loop forever.
        const text = e instanceof Error ? e.message : String(e);
        if (text.includes("already exists")) msg.ack();
        else msg.retry();
      }
    }
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    installAutomationErrorSink(env, ctx);
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");

    // On-demand reconcile trigger (dashboard admin "Reconcile now" / per-order
    // "Re-pull"). Gated by the shared OUTBOX_SECRET — the same secret the worker
    // uses to call back into the dashboard. Body {orderId} → reconcile that one
    // order; {orderIds:[...]} → retry a specific batch (e.g. the ids a full sweep
    // logged as failed to external_ops); {all:"dry"|"apply"|"stop"} arms/stops the
    // full-table catch-up sweep; empty body → force the windowed sweep (bypasses
    // the hourly throttle).
    if (req.method === "POST" && url.pathname === "/reconcile") {
      const secret = env.OUTBOX_SECRET;
      if (!secret) return new Response("reconcile trigger not configured", { status: 501 });
      if (req.headers.get("x-outbox-secret") !== secret) return new Response("unauthorized", { status: 401 });
      const body = (await req.json().catch(() => ({}))) as { orderId?: unknown; orderIds?: unknown; all?: unknown };
      if (typeof body.orderId === "string" && body.orderId) {
        return Response.json(await reconcileOneOrder(env, body.orderId));
      }
      if (Array.isArray(body.orderIds)) {
        const ids = body.orderIds.filter((id): id is string => typeof id === "string" && id.length > 0);
        return Response.json(await reconcileOrders(env, ids));
      }
      // {all: "dry" | "apply"} arms the full-table catch-up sweep; {all: "stop"}
      // disarms it. The sweep itself runs on the cron — this only sets the flag,
      // so the call returns immediately rather than holding a request open for
      // the ~hour the pass takes.
      if (typeof body.all === "string") {
        if (body.all === "stop") return Response.json(await armFullSweep(env, null));
        if (body.all === "dry" || body.all === "apply") return Response.json(await armFullSweep(env, body.all));
        return new Response("all must be dry, apply or stop", { status: 400 });
      }
      return Response.json(await reconcileMissingOrders(env, { force: true }));
    }

    if (req.method === "POST" && url.pathname === "/webhooks/shopify") {
      const raw = await req.text();
      const hmac = req.headers.get("X-Shopify-Hmac-Sha256") ?? "";
      if (!(await verifyShopifyHmac(raw, hmac, env.SHOPIFY_WEBHOOK_SECRET))) {
        // webhook-failure: HMAC rejection — must page at launch.
        captureError("webhook.hmac", new Error("Shopify HMAC verification failed"));
        await logWebhookIn(env, "hmac_rejected", null, false, "HMAC verification failed");
        return new Response("unauthorized", { status: 401 });
      }
      let body: { id: unknown };
      try { body = JSON.parse(raw); }
      catch (e) { captureError("webhook.parse", e); await logWebhookIn(env, "parse_failed", null, false, "JSON parse failed"); return new Response("bad request", { status: 400 }); }
      const topic = req.headers.get("X-Shopify-Topic") ?? "orders/create";
      await logWebhookIn(env, topic, String(body.id), true);
      if (topic === "orders/cancelled") { await handleCancel(env, body); return new Response("ok"); }
      if (topic === "orders/edited") { await env.ORDER_QUEUE.send({ shopifyOrderId: String(body.id), raw: body }); /* re-upsert via workflow */ await handleEditClawback(env, body); return new Response("ok"); }
      // orders/updated → a store app tags orders a few minutes after checkout;
      // refresh the stored tags and run the late match a parked order missed at
      // create time (never rewinds an already-worked order). See lib/lateMatch.ts.
      if (topic === "orders/updated") { await handleOrderUpdated(env, body); return new Response("ok"); }
      // else orders/create → existing enqueue path
      await env.ORDER_QUEUE.send({ shopifyOrderId: String(body.id), raw: body });
      return new Response("ok", { status: 200 });   // ack fast; work happens in the workflow
    }

    // Dev-only manual trigger: POST /__run { country, city, radius, limit,
    // resetExisting? } — inserts a running ingest_jobs row and starts the
    // Workflow directly, bypassing the cron/queue. Gated on DEV_TRIGGER.
    if (url.pathname === "/__run" && req.method === "POST" && env.DEV_TRIGGER === "true") {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const country = String(body.country ?? "").trim();
      const city = String(body.city ?? "").trim();
      if (!country || !city) return new Response("country and city required", { status: 400 });
      const jobId = crypto.randomUUID();
      const message: CityJobMessage = {
        jobId,
        country,
        city,
        radiusKm: typeof body.radius === "number" ? body.radius : 10,
        limit: typeof body.limit === "number" ? body.limit : 20,
        resetExisting: body.resetExisting === true,
      };
      const sb = createServiceClient(env);
      await sb.from("ingest_jobs").insert({
        id: jobId,
        country,
        city,
        radius_km: message.radiusKm,
        limit_per_keyword: message.limit,
        keywords: null,
        language: null,
        reset_existing: message.resetExisting,
        status: "running",
      });
      await env.CITY_WORKFLOW.create({ id: jobId, params: message });
      return Response.json({ jobId });
    }

    return new Response("not found", { status: 404 });
  },
};

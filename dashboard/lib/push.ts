import webpush from "web-push";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { logCommunication } from "@/lib/communications";

/** Server-only web-push sender. Configures VAPID once at module scope (guarded —
 * a missing keypair is a valid, logged-once no-op rather than a crash). Node
 * runtime only: web-push needs Node's crypto module. Never throws — every send
 * is best-effort so a florist's dead/misconfigured subscription can never break
 * the caller (offer-send, etc). Every attempt is also recorded to the
 * communications log (channel 'push', no subject) via `context`; the log call
 * itself never throws (logCommunication swallows), so it can never affect
 * delivery. */

/** Attribution for the communications-log row a push attempt writes. `kind`
 * is required whenever the caller wants it logged; omit `context` entirely to
 * skip logging (not expected to happen at any current call site). */
export interface PushLogContext {
  kind: string;
  orderId?: string | null;
  assignmentId?: string | null;
  issueId?: string | null;
  actor?: string | null;
  // Pass the caller's already-resolved test_mode when it has one in scope
  // (e.g. reachoutSend/cxAlerts, which already read it for the email leg) —
  // reuse it rather than re-reading. Omit it when the caller has no
  // authoritative read of its own (e.g. the issue-reply/resolve routes);
  // resolveTestMode() below then does the fail-closed read itself.
  testMode?: boolean;
}

/** Server-authoritative test_mode, fail-closed (`?? true`) — same policy as
 * every email send site. Only hit when a caller didn't already pass one. */
async function resolveTestMode(admin: ReturnType<typeof createServiceClient>): Promise<boolean> {
  const { data } = await admin.from("app_settings").select("test_mode").eq("id", 1).single();
  return data?.test_mode ?? true;
}

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT;

const vapidConfigured = Boolean(VAPID_PRIVATE_KEY && VAPID_PUBLIC_KEY && VAPID_SUBJECT);
if (vapidConfigured) {
  webpush.setVapidDetails(VAPID_SUBJECT!, VAPID_PUBLIC_KEY!, VAPID_PRIVATE_KEY!);
} else {
  console.warn("[push] VAPID not configured: sendPushToFlorist is a no-op");
}

export type PushPayload = { title: string; body: string; url: string };

type SubRow = { endpoint: string; keys: unknown };

/** Shared delivery loop for both subscription tables: sends to every row,
 * best-effort per-subscription — a 404/410 (subscription gone — browser
 * unsubscribed or expired) prunes that row from `table` so dead subscriptions
 * don't accumulate; any other error is logged and skipped. Never throws. */
async function deliverAndPrune(
  admin: ReturnType<typeof createServiceClient>,
  table: "push_subscriptions" | "staff_push_subscriptions",
  subs: SubRow[],
  payload: PushPayload
): Promise<void> {
  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys as { p256dh: string; auth: string } },
          body
        );
      } catch (e) {
        const statusCode = (e as { statusCode?: number })?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await admin.from(table).delete().eq("endpoint", sub.endpoint);
        } else {
          console.error(`[push] sendNotification failed (${table})`, statusCode, e);
        }
      }
    })
  );
}

/** Sends a web-push notification to every device the florist has subscribed
 * from. Best-effort per-subscription (see deliverAndPrune). Never throws.
 * When `context` is given, also writes one communications row (audience
 * 'florist', channel 'push', no subject, body = payload.body) summarizing the
 * attempt — 'sent' means delivery was attempted to >=1 subscription (per-
 * endpoint outcomes aren't tracked back up; see deliverAndPrune), 'skipped'
 * means there was nothing to deliver to. */
export async function sendPushToFlorist(floristId: string, payload: PushPayload, context?: PushLogContext): Promise<void> {
  const admin = createServiceClient();

  // Resolved once, reused for every exit path below (no context → no log at all).
  const logComm = async (status: "sent" | "skipped" | "failed", error?: string | null) => {
    if (!context) return;
    const testMode = context.testMode ?? (await resolveTestMode(admin));
    await logCommunication({
      channel: "push",
      audience: "florist",
      kind: context.kind,
      orderId: context.orderId ?? null,
      floristId,
      assignmentId: context.assignmentId ?? null,
      issueId: context.issueId ?? null,
      body: payload.body,
      testMode,
      status,
      provider: "web-push",
      error: error ?? null,
      actor: context.actor ?? null,
    });
  };

  if (!vapidConfigured) {
    await logComm("skipped", "VAPID not configured");
    return;
  }

  const { data: subs, error } = await admin
    .from("push_subscriptions")
    .select("endpoint, keys")
    .eq("florist_id", floristId);

  if (error) {
    console.error("[push] failed to load subscriptions", floristId, error);
    await logComm("failed", error.message);
    return;
  }
  if (!subs || subs.length === 0) {
    await logComm("skipped", "no subscriptions");
    return;
  }
  await deliverAndPrune(admin, "push_subscriptions", subs, payload);
  await logComm("sent", null);
}

/** Sends a web-push notification to every staff device subscribed for CX
 * alerts (dashboard/lib/cxAlerts.ts). Returns how many subscriptions were
 * attempted so the caller can tell "no staff subscribed yet" apart from
 * "delivery attempted" — best-effort per-subscription (see deliverAndPrune),
 * never throws. When `context` is given, also logs one communications row
 * (channel 'push'; audience defaults to 'staff', pass 'cx' for CX alerts). */
export async function sendPushToStaff(
  payload: PushPayload,
  context?: PushLogContext & { audience?: "cx" | "staff" }
): Promise<{ attempted: number }> {
  const admin = createServiceClient();
  const audience = context?.audience ?? "staff";

  const logComm = async (status: "sent" | "skipped" | "failed", error?: string | null) => {
    if (!context) return;
    const testMode = context.testMode ?? (await resolveTestMode(admin));
    await logCommunication({
      channel: "push",
      audience,
      kind: context.kind,
      orderId: context.orderId ?? null,
      assignmentId: context.assignmentId ?? null,
      issueId: context.issueId ?? null,
      body: payload.body,
      testMode,
      status,
      provider: "web-push",
      error: error ?? null,
      actor: context.actor ?? null,
    });
  };

  if (!vapidConfigured) {
    await logComm("skipped", "VAPID not configured");
    return { attempted: 0 };
  }

  const { data: subs, error } = await admin.from("staff_push_subscriptions").select("endpoint, keys");

  if (error) {
    console.error("[push] failed to load staff subscriptions", error);
    await logComm("failed", error.message);
    return { attempted: 0 };
  }
  if (!subs || subs.length === 0) {
    await logComm("skipped", "no subscriptions");
    return { attempted: 0 };
  }
  await deliverAndPrune(admin, "staff_push_subscriptions", subs, payload);
  await logComm("sent", null);
  return { attempted: subs.length };
}

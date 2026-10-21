import { logExternalOp } from "@/lib/externalOps";
import { logCommunication } from "@/lib/communications";

/** Mirrors SendEmailContext (lib/email.ts) minus `subject` — SMS has none.
 * `audience`/`kind` are optional so a caller that only wants the external_ops
 * audit can omit them; every send site in this feature passes both. */
export interface SendSmsContext {
  orderId?: string | null;
  operation?: string;
  audience?: "florist" | "client" | "cx" | "staff";
  kind?: string;
  floristId?: string | null;
  assignmentId?: string | null;
  issueId?: string | null;
  actor?: string | null;
  // The caller's already-resolved, server-authoritative test_mode read (it
  // decided `to` against the test sink before calling sendSms) — sendSms
  // itself has no way to know this, so it must be threaded through, never
  // re-read here. Required whenever `audience`+`kind` are set.
  testMode?: boolean;
}

/** Server-only Telnyx SMS sender. Never throws — returns a discriminated
 * result so the caller records success/failure per florist. Every send is
 * recorded in the external-operations log (call audit) and, when `context`
 * carries `audience`+`kind`, in the `communications` log (message-shaped view,
 * with the actual body). Deliberately shaped exactly like lib/email.ts::sendEmail.
 *
 * SENDER IDENTITY. Telnyx requires an explicit `from` on every send, alongside
 * the messaging profile — unlike a Twilio Messaging Service, which picks a
 * sender per destination country on the provider's side. So `from` comes from
 * TELNYX_SENDER_ID (the alphanumeric brand sender, e.g. "Facundo") and is
 * the SAME for every destination.
 *
 * That is correct for the markets this ships to — ES/FR/IT/DE all accept
 * alphanumeric sender IDs — but it is a real narrowing versus the Twilio
 * design: sender choice now lives in OUR env rather than in provider config.
 * Expanding to a country that forbids alphanumeric senders (notably the US and
 * Canada, which require a registered 10DLC or toll-free NUMBER) would need
 * per-country sender selection added here. It is deliberately not built yet —
 * there is no such market today and a guessed mapping would be worse than none.
 *
 * Alphanumeric sender IDs also require pre-registration in several European
 * countries; that is Telnyx-portal account setup, not code. */
export async function sendSms(args: {
  to: string; // E.164, from lib/phone.ts::resolveFloristSmsPhone
  body: string;
  context?: SendSmsContext;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const ctx = args.context;
  const op = ctx?.operation ?? "send_sms";
  const orderId = ctx?.orderId ?? null;

  const logComm = (status: "sent" | "failed", opts: { providerMessageId?: string | null; error?: string | null }) => {
    if (!ctx?.audience || !ctx?.kind) return; // no message-shaped context — external_ops audit only
    return logCommunication({
      channel: "sms",
      audience: ctx.audience,
      kind: ctx.kind,
      orderId,
      floristId: ctx.floristId ?? null,
      assignmentId: ctx.assignmentId ?? null,
      issueId: ctx.issueId ?? null,
      to: args.to,
      subject: null, // SMS has no subject
      body: args.body,
      html: null,
      testMode: ctx.testMode ?? true, // fail-closed if a caller sets audience/kind but forgets testMode
      status,
      provider: "telnyx",
      providerMessageId: opts.providerMessageId ?? null,
      error: opts.error ?? null,
      actor: ctx.actor ?? null,
    });
  };

  // A scoped API key, not an account-master credential: it is independently
  // revocable and rotatable, so a leak from this one send path can be cut off
  // without disturbing any other integration.
  const apiKey = process.env.TELNYX_API_KEY;
  const messagingProfileId = process.env.TELNYX_MESSAGING_PROFILE_ID;
  const senderId = process.env.TELNYX_SENDER_ID;
  // meta deliberately records the destination and length but NOT the body —
  // external_ops is a call audit; the content lives in `communications`.
  const meta = { to: args.to, chars: args.body.length };

  if (!apiKey || !messagingProfileId || !senderId) {
    const error = "TELNYX_API_KEY / TELNYX_MESSAGING_PROFILE_ID / TELNYX_SENDER_ID are not all set";
    await logExternalOp({ provider: "telnyx", operation: op, orderId, ok: false, error, meta });
    await logComm("failed", { error });
    return { ok: false, error };
  }

  const start = Date.now();
  try {
    const res = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      // `messaging_profile_id` is REQUIRED alongside an alphanumeric `from`
      // (a bare `from` only works for a number already bound to a profile).
      body: JSON.stringify({
        from: senderId,
        to: args.to,
        text: args.body,
        messaging_profile_id: messagingProfileId,
      }),
    });
    // Success: { data: { id, … } }. Failure: { errors: [{ code, title, detail }] }.
    const data = (await res.json().catch(() => ({}))) as {
      data?: { id?: string };
      errors?: { code?: string; title?: string; detail?: string }[];
    };
    const dur = Date.now() - start;
    if (!res.ok) {
      // `detail` is the specific, actionable line ("The from number … is not
      // assigned to a messaging profile"); `title` is the generic class.
      const first = data.errors?.[0];
      const error = first?.detail || first?.title || `Telnyx error ${res.status}`;
      await logExternalOp({ provider: "telnyx", operation: op, orderId, ok: false, statusCode: res.status, durationMs: dur, error, meta });
      await logComm("failed", { error });
      return { ok: false, error };
    }
    const id = data.data?.id ?? null;
    await logExternalOp({ provider: "telnyx", operation: op, orderId, ref: id, ok: true, statusCode: res.status, durationMs: dur, meta });
    await logComm("sent", { providerMessageId: id });
    return { ok: true, id: id ?? "" };
  } catch (e) {
    const error = e instanceof Error ? e.message : "send failed";
    await logExternalOp({ provider: "telnyx", operation: op, orderId, ok: false, durationMs: Date.now() - start, error, meta });
    await logComm("failed", { error });
    return { ok: false, error };
  }
}

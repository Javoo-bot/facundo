import { logExternalOp } from "@/lib/externalOps";
import { logCommunication } from "@/lib/communications";
import { richTextToPlain } from "@/lib/messages/richText";
import { newRfcMessageId } from "@/lib/inboundMatch";
import { replyToAddress, chooseReplyTo, inboundMailbox } from "@/lib/replyToken";
import { parseFrom } from "@/lib/emailFrom";
import { ongageConfig, buildOngagePayload, ongageFailure, type OngageSendResponse } from "@/lib/ongage";
import { resolveEmailTransport, emailTransportError } from "@/lib/emailTransport";
import { buildResendPayload, resendFailure, type ResendSendResponse } from "@/lib/resend";

/** `context` lets a caller attribute a send to an order/operation (external_ops)
 * and, when `audience`+`kind` are given, to a communications-log row (the
 * message-shaped view, WITH content). `audience`/`kind` are optional so a
 * caller that only wants the external_ops audit (no message-shaped row) can
 * omit them — but every send site added in the comms hub passes both. */
export interface SendEmailContext {
  orderId?: string | null;
  operation?: string;
  audience?: "florist" | "client" | "cx" | "staff";
  kind?: string;
  floristId?: string | null;
  assignmentId?: string | null;
  issueId?: string | null;
  actor?: string | null;
  // The caller's already-resolved, server-authoritative test_mode read (it
  // decided `to` against the test sink before calling sendEmail) — sendEmail
  // itself has no way to know this, so it must be threaded through, never
  // re-read here. Required whenever `audience`+`kind` are set.
  testMode?: boolean;
}

/** Server-only email sender. Dual-transport (2026-08-21): EMAIL_TRANSPORT
 * picks Resend or Ongage per environment (lib/emailTransport.ts) — production
 * runs Resend for its delivery/open/click webhook, staging keeps Ongage.
 * Never throws — returns a discriminated result so the caller records send
 * success/failure per florist. Every send is also recorded in the
 * external-operations log (call audit, provider = whichever transport ran)
 * and, when the caller's `context` carries `audience`+`kind`, a
 * `communications` row (message-shaped view — the actual recipient/subject/
 * body). */
export async function sendEmail(args: {
  to: string;
  from: string;
  subject: string;
  body: string;
  html?: string; // optional HTML alternative (text `body` is always kept as the fallback)
  /** Where a reply goes, when that isn't the From address. Used by the outreach
   * funnel: follow-ups are signed by a named persona (outreach_personas) and
   * their reply_to is a real, monitored inbox. Without this the signature would
   * be a name over an address nobody reads, which is what turns an interested
   * florist into a bounce. */
  replyTo?: string;
  /** A monitored inbox to use as Reply-To when neither `replyTo` nor the
   * signed per-assignment reply address applies — see
   * lib/replyToken.ts::chooseReplyTo. Without it, a florist's reply goes to the
   * From address, which has no mailbox, and bounces. */
  fallbackReplyTo?: string | null;
  /** Optional custom headers (e.g. List-Unsubscribe). Sent on the RESEND path
   * only — Resend accepts arbitrary headers. Ongage's embed-content API has no
   * custom-header support, so on the Ongage path these are accepted for
   * call-site compatibility but dropped. */
  headers?: Record<string, string>;
  context?: SendEmailContext;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const ctx = args.context;
  const op = ctx?.operation ?? "send_email";
  const orderId = ctx?.orderId ?? null;

  // A subject is plain text at the mail layer, so any markup in it reaches the
  // inbox as literal characters: "Order in <b>Girona</b>". Since the message
  // editor lets staff apply formatting to any field, the guard belongs here,
  // at the one point every outbound email passes through, rather than in each
  // builder where the next one added would forget it.
  args = { ...args, subject: richTextToPlain(args.subject) };

  // ---- Threading: make every outbound florist email answerable -------------
  //
  // Two independent ways for a reply to tell us which order it is about, both
  // set here so no individual send site has to remember:
  //
  //   1. A Reply-To carrying a signed token for the assignment. Only for
  //      florist mail with an assignment, and only when both REPLY_TOKEN_SECRET
  //      and INBOUND_EMAIL_DOMAIN are configured — until the MX record for that
  //      domain exists, replyToAddress returns null and this is a no-op. An
  //      explicit replyTo from the caller always wins (the persona inbox).
  //   2. Our own Message-ID, stored on the communications row, so In-Reply-To
  //      on the reply resolves back to the order.
  //
  // HONEST CAVEAT ON (2): it is only on the wire when EMAIL_TRANSPORT=resend —
  // Resend accepts arbitrary custom headers, so the Message-ID we set actually
  // reaches the recipient. Under Ongage the embed-content API accepts none, so
  // the header is NOT on the wire there; it is still stored on the
  // communications row either way so the schema and lib/inboundMatch.ts need
  // no change per-transport. On the Ongage path (1) is the only working leg.
  const rfcMessageId = newRfcMessageId();
  // Every florist email routes replies into the app (/conversations), best
  // address first: the signed per-assignment address when the email is about
  // one order, otherwise the general inbound mailbox (magic links, notices), and
  // only when inbound mail is not configured at all, the monitored fallback
  // inbox. See lib/replyToken.ts::chooseReplyTo and ::inboundMailbox.
  const toFlorist = ctx?.audience === "florist";
  const threadedReplyTo = chooseReplyTo(
    args.replyTo,
    toFlorist && ctx?.assignmentId ? replyToAddress(ctx.assignmentId) : null,
    toFlorist ? inboundMailbox() : null,
    args.fallbackReplyTo,
  );

  const logComm = (
    provider: "resend" | "ongage",
    status: "sent" | "failed",
    opts: { providerMessageId?: string | null; error?: string | null },
  ) => {
    if (!ctx?.audience || !ctx?.kind) return; // no message-shaped context — external_ops audit only
    return logCommunication({
      channel: "email",
      audience: ctx.audience,
      kind: ctx.kind,
      orderId,
      floristId: ctx.floristId ?? null,
      assignmentId: ctx.assignmentId ?? null,
      issueId: ctx.issueId ?? null,
      to: args.to,
      subject: args.subject,
      body: args.body,
      html: args.html ?? null,
      testMode: ctx.testMode ?? true, // fail-closed if a caller sets audience/kind but forgets testMode
      status,
      provider,
      providerMessageId: opts.providerMessageId ?? null,
      rfcMessageId,
      error: opts.error ?? null,
      actor: ctx.actor ?? null,
    });
  };

  // ---- Transport selection: explicit, fails closed, never guesses ----------
  const transport = resolveEmailTransport();
  if (!transport) {
    const error = emailTransportError();
    // Best-effort label for the audit trail: the raw flag if it at least names
    // a known transport (its OWN secrets are what's missing), else a generic
    // marker — never a guess at which transport was "meant".
    const raw = process.env.EMAIL_TRANSPORT?.trim();
    const attemptedProvider = raw === "resend" || raw === "ongage" ? raw : "unconfigured";
    await logExternalOp({ provider: attemptedProvider, operation: op, orderId, ok: false, error, meta: { to: args.to, subject: args.subject } });
    if (attemptedProvider === "resend" || attemptedProvider === "ongage") await logComm(attemptedProvider, "failed", { error });
    return { ok: false, error };
  }

  const sender = parseFrom(args.from);
  const start = Date.now();

  // ---- Ongage --------------------------------------------------------------
  if (transport === "ongage") {
    const cfg = ongageConfig();
    if (!cfg) {
      // Defensive only: resolveEmailTransport() already confirmed the same
      // five vars are present (same process.env, no I/O in between), so this
      // should be unreachable — kept as a safety net against future drift.
      const error = "Ongage is not configured (ONGAGE_LIST_ID / ONGAGE_USERNAME / ONGAGE_PASSWORD / ONGAGE_ACCOUNT_CODE / ONGAGE_SENDING_CONNECTION_ID)";
      await logExternalOp({ provider: "ongage", operation: op, orderId, ok: false, error, meta: { to: args.to, subject: args.subject } });
      await logComm("ongage", "failed", { error });
      return { ok: false, error };
    }
    try {
      const res = await fetch(`https://api.ongage.net/${cfg.listId}/api/transactional/send_embed_content`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          X_USERNAME: cfg.username,
          X_PASSWORD: cfg.password,
          X_ACCOUNT_CODE: cfg.accountCode,
        },
        body: JSON.stringify(buildOngagePayload({
          to: args.to, subject: args.subject, text: args.body, html: args.html,
          fromName: sender.name, fromAddress: sender.address, replyTo: threadedReplyTo ?? null,
          connectionId: cfg.connectionId,
        })),
        signal: AbortSignal.timeout(20_000),
      });
      const data = (await res.json().catch(() => ({}))) as OngageSendResponse;
      const dur = Date.now() - start;
      const failure = ongageFailure(res, data, args.to);
      if (failure) {
        await logExternalOp({ provider: "ongage", operation: op, orderId, ok: false, statusCode: res.status, durationMs: dur, error: failure, meta: { to: args.to, subject: args.subject } });
        await logComm("ongage", "failed", { error: failure });
        return { ok: false, error: failure };
      }
      // Ongage returns per-call counters, not a per-message id — there is
      // nothing to store as provider_message_id. The rfcMessageId we minted is
      // still stored on the communications row, but see the caveat above: it is
      // NOT on the wire under Ongage, so only the Reply-To token leg threads a
      // reply on this path.
      await logExternalOp({ provider: "ongage", operation: op, orderId, ref: null, ok: true, statusCode: res.status, durationMs: dur, meta: { to: args.to, subject: args.subject } });
      await logComm("ongage", "sent", { providerMessageId: null });
      return { ok: true, id: "" };
    } catch (e) {
      const error = e instanceof Error ? e.message : "send failed";
      await logExternalOp({ provider: "ongage", operation: op, orderId, ok: false, durationMs: Date.now() - start, error, meta: { to: args.to, subject: args.subject } });
      await logComm("ongage", "failed", { error });
      return { ok: false, error };
    }
  }

  // ---- Resend ----------------------------------------------------------
  const key = process.env.RESEND_API_KEY!; // resolveEmailTransport() already confirmed this is set
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildResendPayload({
        from: args.from, to: args.to, subject: args.subject, text: args.body, html: args.html,
        replyTo: threadedReplyTo ?? null, rfcMessageId, extraHeaders: args.headers ?? null,
      })),
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await res.json().catch(() => ({}))) as ResendSendResponse;
    const dur = Date.now() - start;
    const failure = resendFailure(res, data);
    if (failure) {
      await logExternalOp({ provider: "resend", operation: op, orderId, ok: false, statusCode: res.status, durationMs: dur, error: failure, meta: { to: args.to, subject: args.subject } });
      await logComm("resend", "failed", { error: failure });
      return { ok: false, error: failure };
    }
    await logExternalOp({ provider: "resend", operation: op, orderId, ref: data.id ?? null, ok: true, statusCode: res.status, durationMs: dur, meta: { to: args.to, subject: args.subject } });
    await logComm("resend", "sent", { providerMessageId: data.id ?? null });
    return { ok: true, id: data.id ?? "" };
  } catch (e) {
    const error = e instanceof Error ? e.message : "send failed";
    await logExternalOp({ provider: "resend", operation: op, orderId, ok: false, durationMs: Date.now() - start, error, meta: { to: args.to, subject: args.subject } });
    await logComm("resend", "failed", { error });
    return { ok: false, error };
  }
}

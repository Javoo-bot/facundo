// ---- Resend transport --------------------------------------------------
//
// POST https://api.resend.com/emails, Bearer-authenticated with
// RESEND_API_KEY. This is the transport dashboard email used before the
// 2026-08-20 move to Ongage ("Send all dashboard email through Ongage (drop
// Resend)"), restored for PRODUCTION on 2026-08-21 so outbound mail gets
// Resend's delivery/open/click webhook (app/api/webhooks/resend/route.ts) —
// Ongage has no equivalent yet (see lib/lifecycle.ts's
// `x-email-delivery-feedback-ongage` cross-cutting entry). Staging stays on
// Ongage (lib/ongage.ts); lib/emailTransport.ts decides which one runs per
// environment via EMAIL_TRANSPORT.
//
// Everything here is pure (no I/O, no app imports) so lib/resend.test.mjs can
// cover it without pulling in lib/email.ts's aliased (@/lib/...) imports —
// mirrors lib/ongage.ts's split for the same reason.

export interface ResendSendResponse { id?: string; message?: string; name?: string }

/** The request body for POST https://api.resend.com/emails. Unlike Ongage's
 * embed-content API, Resend accepts arbitrary custom headers, so the
 * Message-ID lib/email.ts mints for reply-threading rides on the wire here —
 * the leg that went dark under Ongage (see lib/email.ts's threading comment). */
export function buildResendPayload(a: {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string | null;
  replyTo?: string | null;
  rfcMessageId: string;
  extraHeaders?: Record<string, string> | null;
}) {
  return {
    from: a.from,
    to: a.to,
    subject: a.subject,
    text: a.text,
    ...(a.html ? { html: a.html } : {}),
    ...(a.replyTo ? { reply_to: a.replyTo } : {}),
    headers: { "Message-ID": a.rfcMessageId, ...(a.extraHeaders ?? {}) },
  };
}

/** Null when Resend accepted the message (HTTP 2xx); otherwise a one-line
 * reason, preferring Resend's own message over a bare status code. */
export function resendFailure(res: { ok: boolean; status: number }, data: ResendSendResponse): string | null {
  if (res.ok) return null;
  return data.message || `Resend error ${res.status}`;
}

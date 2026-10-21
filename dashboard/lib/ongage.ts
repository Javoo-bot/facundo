// ---- Ongage transport ------------------------------------------------------
//
// POST https://api.ongage.net/<list_id>/api/transactional/send_embed_content,
// authenticated with the X_USERNAME / X_PASSWORD / X_ACCOUNT_CODE headers.
// Docs: Ongage Help → "Transactional Mailing API Methods". Verified live on
// 2026-08-20 against list <list-id> / connection <connection-id> (noreply@fc.example.com).
// Everything here is pure (no I/O, no app imports) so lib/ongage.test.mjs can cover it.

export interface OngageConfig { listId: string; username: string; password: string; accountCode: string; connectionId: number }

export function ongageConfig(): OngageConfig | null {
  const listId = process.env.ONGAGE_LIST_ID?.trim();
  const username = process.env.ONGAGE_USERNAME?.trim();
  const password = process.env.ONGAGE_PASSWORD?.trim();
  const accountCode = process.env.ONGAGE_ACCOUNT_CODE?.trim();
  const connectionId = Number(process.env.ONGAGE_SENDING_CONNECTION_ID?.trim());
  if (!listId || !username || !password || !accountCode || !Number.isFinite(connectionId) || connectionId <= 0) return null;
  return { listId, username, password, accountCode, connectionId };
}

/** The request body for send_embed_content. Ongage requires content_html, so
 * a text-only send gets the text wrapped (escaped) rather than dropped. */
export function buildOngagePayload(a: {
  to: string; subject: string; text: string; html?: string | null;
  fromName: string; fromAddress: string; replyTo?: string | null; connectionId: number;
}) {
  return {
    message: {
      subject: a.subject,
      content_html: a.html ?? textAsHtml(a.text),
      content_text: a.text,
      addresses: {
        from_name: a.fromName || "Facundo",
        from_address: a.fromAddress,
        reply_address: a.replyTo ?? a.fromAddress,
      },
    },
    recipients: [a.to],
    sending_connection_id: a.connectionId,
    // We mint and render our own unsubscribe links (florist opt-out tokens),
    // and most of this mail is transactional — Ongage must not append a
    // list-unsubscribe footer of its own.
    disable_unsubscribe: true,
  };
}

export interface OngageSendResponse {
  metadata?: { error?: boolean; message?: string };
  payload?: {
    total?: number; success?: number; failed?: number; suppressed?: number; not_active?: number; queued?: number;
    // Documented as an object keyed by address; observed as `[]` when empty.
    failed_emails?: Record<string, string> | string[];
    message?: string;
  } | string;
}

/** Null when Ongage accepted the message for `to`; otherwise a one-line reason.
 * A 200 with success=0 is a failure — Ongage reports per-recipient rejections
 * in the payload, not the status code. */
export function ongageFailure(res: { ok: boolean; status: number }, data: OngageSendResponse, to: string): string | null {
  const payload = typeof data.payload === "object" && data.payload ? data.payload : null;
  if (!res.ok || data.metadata?.error) {
    const msg = data.metadata?.message || payload?.message || (typeof data.payload === "string" ? data.payload : null);
    return msg || `Ongage error ${res.status}`;
  }
  if (!payload) return "Ongage returned no payload";
  if ((payload.success ?? 0) + (payload.queued ?? 0) > 0) return null;
  const fe = payload.failed_emails;
  const perAddress = fe && !Array.isArray(fe) ? (fe[to] ?? fe[to.toLowerCase()] ?? Object.values(fe)[0]) : null;
  if (perAddress) return `Ongage rejected recipient: ${perAddress}`;
  if (payload.suppressed) return "Ongage: recipient is on a suppression list";
  if (payload.not_active) return "Ongage: recipient is not active (unsubscribed/bounced)";
  return "Ongage accepted the call but delivered to nobody (success=0)";
}

function textAsHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<html><body><pre style="font-family:inherit;white-space:pre-wrap">${esc}</pre></body></html>`;
}

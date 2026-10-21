import { verifyResendSignature } from "@/lib/resendWebhookGuard";
import { ingestInbound } from "@/lib/conversations";
import { htmlToText } from "@/lib/htmlText";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Inbound email (Resend Inbound → `email.received`). Signed with Svix, exactly
// like the outbound event webhook, so it reuses the same guard.
//
// IMPORTANT PROVIDER DETAIL: the `email.received` payload does NOT carry the
// message body. It carries an id, and the parsed text/HTML must be fetched back
// from the Resend API. Missing that is the difference between a working agent
// and one that silently answers every email as if it were blank.

interface ReceivedPayload {
  type?: string;
  data?: {
    email_id?: string;
    id?: string;
    from?: string | { address?: string };
    to?: string[] | string;
    subject?: string;
    headers?: Record<string, string>;
    text?: string;
    html?: string;
  };
}

/** A RECIPIENT address, with the local part kept exactly as delivered.
 *
 * The reply-address token (r+<token>@…) is base64url and case-sensitive, so it
 * must not be lowercased: addressOf below lowercases the whole address, which
 * turned `r+kvC1mMgEQ…` into `r+kvc1mmgeq…`, failed signature verification, and
 * left matching to the threading headers alone. Resend delivers the recipient
 * with its case intact. Found 2026-09-16 in the first staging inbound test,
 * which only matched its order because the test reply also carried In-Reply-To.
 * The domain is still lowercased; domains are case-insensitive. */
function recipientOf(value: unknown): string {
  const raw =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && typeof (value as { address?: string }).address === "string"
        ? (value as { address: string }).address
        : "";
  const m = raw.match(/<([^>]+)>/);
  const addr = (m ? m[1] : raw).trim();
  const at = addr.lastIndexOf("@");
  return at > 0 ? `${addr.slice(0, at)}@${addr.slice(at + 1).toLowerCase()}` : addr;
}

function addressOf(from: ReceivedPayload["data"] extends infer D ? (D extends { from?: infer F } ? F : never) : never): string {
  if (typeof from === "string") {
    // "Marta Ruiz <marta@example.com>" → the address only.
    const m = from.match(/<([^>]+)>/);
    return (m ? m[1] : from).trim().toLowerCase();
  }
  if (from && typeof from === "object" && typeof (from as { address?: string }).address === "string") {
    return (from as { address: string }).address.trim().toLowerCase();
  }
  return "";
}

/** Resend's `headers` has not been pinned down in its docs as an object or a
 * list, and matching a reply to its order depends on `in-reply-to` /
 * `references` being found under exactly those lowercase keys
 * (lib/inboundMatch.ts). So accept both shapes and lowercase every name. */
function normalizeHeaders(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== "object") return null;
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (const h of raw as { name?: string; key?: string; value?: string }[]) {
      const name = (h?.name ?? h?.key ?? "").toLowerCase();
      if (name && typeof h?.value === "string") out[name] = h.value;
    }
  } else {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string") out[k.toLowerCase()] = v;
      else if (Array.isArray(v) && typeof v[0] === "string") out[k.toLowerCase()] = v.join(" ");
    }
  }
  return Object.keys(out).length ? out : null;
}

/** Fetch the parsed body Resend does not put in the webhook payload. Returns
 * empty strings on failure — the caller escalates rather than answering blind.
 *
 * RECEIVED mail lives at /emails/receiving/{id}. /emails/{id} is the endpoint for
 * mail WE sent, and for a received id it returns nothing. That is what this
 * called until 2026-09-16, found while testing inbound mail on staging, which
 * meant every inbound reply would have arrived with an empty body. */
async function fetchBody(emailId: string): Promise<{ text: string; html: string | null; headers: Record<string, string> | null }> {
  const key = process.env.RESEND_API_KEY;
  if (!key || !emailId) return { text: "", html: null, headers: null };
  try {
    const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return { text: "", html: null, headers: null };
    const j = (await res.json()) as { text?: string; html?: string; headers?: unknown; message_id?: string };
    const headers = normalizeHeaders(j.headers) ?? {};
    // message_id is a top-level field; keep it reachable for threading too.
    if (j.message_id && !headers["message-id"]) headers["message-id"] = j.message_id;
    // Some clients send HTML only, with an empty text part (a real florist reply
    // on 2026-09-16 was 10,396 chars of HTML and 0 of text, and reached the thread
    // blank). Fall back to the words in the HTML; the raw HTML is still kept.
    const text = j.text && j.text.trim() ? j.text : htmlToText(j.html);
    return { text, html: j.html ?? null, headers: Object.keys(headers).length ? headers : null };
  } catch {
    return { text: "", html: null, headers: null };
  }
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.RESEND_INBOUND_WEBHOOK_SECRET || process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return new Response("webhook not configured", { status: 500 });

  const payload = await request.text();
  const svixId = request.headers.get("svix-id") ?? "";
  const ok = verifyResendSignature(
    payload,
    {
      "svix-id": svixId,
      "svix-timestamp": request.headers.get("svix-timestamp") ?? "",
      "svix-signature": request.headers.get("svix-signature") ?? "",
    },
    secret
  );
  // Covers a bad signature and a replayed capture alike.
  if (!ok) return new Response("invalid signature", { status: 401 });

  let body: ReceivedPayload;
  try {
    body = JSON.parse(payload) as ReceivedPayload;
  } catch {
    return new Response("bad json", { status: 400 });
  }
  // Unrecognised event types are ignored, not errors — the same posture the
  // outbound webhook takes, so a new Resend event can't start failing retries.
  if (body.type !== "email.received") return new Response("ok", { status: 200 });

  const d = body.data ?? {};
  const emailId = d.email_id ?? d.id ?? "";
  // Prefer an inline body when Resend provides one; otherwise fetch it.
  const inlineText = typeof d.text === "string" && d.text.length > 0 ? d.text : null;
  const fetched = inlineText ? { text: inlineText, html: d.html ?? null, headers: d.headers ?? null } : await fetchBody(emailId);

  // EVERY recipient, not just the first. The reply-address token that says
  // which order this is about can sit on any of them once a thread has been
  // forwarded around a shop, or once the florist has cc'd a colleague.
  const toList = (Array.isArray(d.to) ? d.to : d.to ? [d.to] : [])
    .map((x) => recipientOf(x))
    .filter(Boolean);
  const to = toList[0] ?? null;

  const result = await ingestInbound({
    channel: "email",
    // svix-id is stable across retries of the same event and is already
    // required by signature verification, so it can never be absent here.
    providerEventId: svixId,
    provider: "resend",
    fromAddress: addressOf(d.from as never),
    toAddress: to,
    toAddresses: toList,
    subject: d.subject ?? null,
    bodyText: fetched.text,
    bodyHtml: fetched.html,
    headers: fetched.headers,
  });

  // A failed ingest returns 500 so Svix retries into an idempotent write
  // (provider_event_id is unique) rather than silently losing the reply.
  if (!result.ok) return new Response("ingest failed", { status: 500 });
  return new Response("ok", { status: 200 });
}

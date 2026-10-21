import { createServiceClient } from "@/lib/supabaseAdmin";
import { captureError } from "@/lib/monitor";
import { classifyInbound, type InboundHeaders } from "@/lib/inboundIntent";
import { APPROVED_FACTS } from "@/lib/cxAgent";
import { matchInboundOrder, threadKind } from "@/lib/inboundMatch";
import { runAgentTurn, escalate } from "@/lib/agentTurn";
import { stopAllForFlorist } from "@/lib/sequences/enrol";
import { FLORIST_BASE } from "@/lib/emailLinks";
import { logCommunication } from "@/lib/communications";

type Admin = ReturnType<typeof createServiceClient>;

// The ONE place an inbound message becomes a decision. Both webhooks (Resend
// Inbound for email, Telnyx for SMS) converge here, so triage, opt-out
// handling, the AI turn and the escalation gate cannot drift apart between
// channels.

export interface InboundMessage {
  channel: "email" | "sms";
  /** Stable per provider event. The unique index on it makes a provider retry a
   * no-op insert rather than a second turn fed to the model. */
  providerEventId: string;
  provider: "resend" | "telnyx";
  fromAddress: string;
  toAddress: string | null;
  subject: string | null;
  /** Every recipient. The reply-address token identifying the order can be on
   * any of them; `toAddress` is only the one we display. */
  toAddresses?: string[];
  bodyText: string;
  bodyHtml?: string | null;
  headers?: InboundHeaders | null;
}

/** Find the florist behind an inbound sender. Email by address, SMS by the last
 * nine digits of the number — enough to match across formatting differences
 * without colliding across countries in a 6,500-shop table. */
async function matchFlorist(admin: Admin, msg: InboundMessage): Promise<string | null> {
  try {
    if (msg.channel === "email") {
      const addr = msg.fromAddress.toLowerCase().trim();
      const { data } = await admin.from("florists").select("id").ilike("email", addr).limit(1).maybeSingle();
      return (data?.id as string) ?? null;
    }
    const digits = msg.fromAddress.replace(/\D/g, "");
    if (digits.length < 9) return null;
    const tail = digits.slice(-9);
    const { data } = await admin
      .from("florists")
      .select("id, phone_mobile, phone_web, phone_maps")
      .or(`phone_mobile.like.%${tail},phone_web.like.%${tail},phone_maps.like.%${tail}`)
      .limit(1)
      .maybeSingle();
    return (data?.id as string) ?? null;
  } catch (e) {
    captureError("conversations.matchFlorist", e);
    return null;
  }
}

/**
 * Ingest one inbound message and decide what happens next.
 *
 * Never throws — it is called from a webhook whose job is to acknowledge the
 * provider. Every failure path ends in an escalation, which is the correct
 * direction: a human looking at a message we could not handle is a cost; an
 * unattended model handling one it should not have is a liability.
 */
export async function ingestInbound(msg: InboundMessage): Promise<{ ok: boolean; action: string }> {
  const admin = createServiceClient();
  try {
    // Idempotency first: a provider retry must not create a second turn.
    const { data: seen } = await admin
      .from("conversation_messages")
      .select("id")
      .eq("provider_event_id", msg.providerEventId)
      .maybeSingle();
    if (seen) return { ok: true, action: "duplicate" };

    // Who wrote in, and what about. The sender address answers the first; a
    // signed reply-address token or a threading header answers the second.
    const senderFloristId = await matchFlorist(admin, msg);
    const match = await matchInboundOrder(
      admin,
      { toAddresses: msg.toAddresses ?? (msg.toAddress ? [msg.toAddress] : []), headers: msg.headers },
      senderFloristId
    );

    // A verified token (per-assignment on order mail, per-florist on recruiting
    // mail) is proof of who wrote, so it identifies a florist whose address we
    // failed to recognise: someone replying from a personal account, which
    // otherwise loses the message to "unmatched sender".
    const floristId = senderFloristId ?? match.floristId;

    // Which agent owns this thread. Joined means they are asking about work we
    // have already given them; not joined means we are still asking them to
    // join. The two must never swap: a joined florist re-pitched the joining
    // offer is the visible symptom of getting this wrong.
    const { data: floristRow } = floristId
      ? await admin.from("florists").select("joined_at").eq("id", floristId).maybeSingle()
      : { data: null };
    const kind = threadKind({ orderId: match.orderId, joined: !!floristRow?.joined_at });

    // Reuse an open thread so a back-and-forth stays one conversation rather
    // than a pile of one-message threads. Support threads are keyed by ORDER —
    // that is what makes the in-app thread and the email reply the same
    // conversation. Recruiting has no order, so it stays keyed by channel.
    let conversationId: string | null = null;
    if (floristId) {
      const q = admin
        .from("conversations")
        .select("id")
        .eq("florist_id", floristId)
        .eq("kind", kind)
        .neq("status", "closed");
      // `.eq(col, null)` renders as `col=eq.null` and matches NOTHING in
      // PostgREST — null needs `is`. Without this split, a joined florist whose
      // email we could not attach to an order would get a brand new thread per
      // message instead of one continuing conversation, and the agent would
      // read none of the history.
      const scoped =
        kind === "support"
          ? match.orderId
            ? q.eq("order_id", match.orderId)
            : q.is("order_id", null)
          : q.eq("channel", msg.channel);
      const { data: open } = await scoped
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      conversationId = (open?.id as string) ?? null;
    }

    if (!conversationId) {
      const { data: created, error } = await admin
        .from("conversations")
        .insert({
          florist_id: floristId,
          channel: msg.channel,
          kind,
          order_id: match.orderId,
          assignment_id: match.assignmentId,
          subject: msg.subject,
          status: "bot",
          last_inbound_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (error || !created) {
        captureError("conversations.create", error);
        return { ok: false, action: "create-failed" };
      }
      conversationId = created.id as string;
    } else {
      await admin
        .from("conversations")
        .update({
          last_inbound_at: new Date().toISOString(),
          cx_unread: true,
          // A thread opened in the app before the order was known, or one whose
          // first email arrived unmatched, gets its order the moment any later
          // message carries one. Never overwritten with null.
          ...(match.orderId ? { order_id: match.orderId } : {}),
          ...(match.assignmentId ? { assignment_id: match.assignmentId } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq("id", conversationId);
    }

    const disposition = classifyInbound(msg.bodyText, msg.headers, msg.subject);

    await admin.from("conversation_messages").insert({
      conversation_id: conversationId,
      direction: "in",
      channel: msg.channel,
      from_address: msg.fromAddress,
      to_address: msg.toAddress,
      subject: msg.subject,
      body_text: msg.bodyText,
      body_html: msg.bodyHtml ?? null,
      provider: msg.provider,
      provider_event_id: msg.providerEventId,
      status: disposition === "answer" ? "received" : "suppressed",
      suppress_reason: disposition === "answer" ? null : disposition,
    });

    // Also on /communications and the order page, next to what we sent. That is
    // where an operator looks for "did the florist answer?", and until
    // 2026-09-16 an inbound reply lived only in conversation_messages, so it was
    // invisible there (order #2000034's florist wrote in and nobody saw it).
    // Logged for every disposition, auto-replies and opt-outs included: it is a
    // record that mail arrived, not a decision about it. Never throws.
    await logCommunication({
      channel: msg.channel,
      audience: "florist",
      kind: msg.channel === "sms" ? "florist_reply_sms" : "florist_reply",
      orderId: match.orderId,
      floristId,
      assignmentId: match.assignmentId,
      to: msg.toAddress,
      subject: msg.subject,
      body: msg.bodyText,
      html: msg.bodyHtml ?? null,
      // An inbound reply is real mail from a real sender, never a test-mode
      // redirect, so it is not tagged as test.
      testMode: false,
      status: "received",
      provider: msg.provider,
      providerMessageId: msg.providerEventId,
      actor: msg.fromAddress,
    });

    // OPT-OUT: handled before the model exists in this function's world. An LLM
    // negotiating with someone who typed STOP is a regulatory incident.
    if (disposition === "opt_out") {
      if (floristId) {
        const col = msg.channel === "sms" ? "order_sms_opt_out" : "order_emails_opt_out";
        await admin.from("florists").update({ [col]: true }).eq("id", floristId);
        await stopAllForFlorist(admin, floristId, "opted_out");
      }
      await admin
        .from("conversations")
        .update({ status: "closed", updated_at: new Date().toISOString() })
        .eq("id", conversationId);
      return { ok: true, action: "opt_out" };
    }

    // AUTO-RESPONDER: stored for the record, never answered. An out-of-office
    // bounced into an AI reply is an infinite loop with a real business on the
    // other end.
    if (disposition === "auto_reply") return { ok: true, action: "auto_reply" };

    // An unmatched sender always goes to a human — we do not know who we would
    // be talking to, or on what basis. It now escalates ATTACHED to the order
    // when a token told us which one, so CX opens it with the context already
    // there instead of a bare address.
    if (!floristId) {
      await escalate(admin, conversationId, "unmatched-sender");
      return { ok: true, action: "escalated:unmatched-sender" };
    }

    const turn = await runAgentTurn(admin, {
      conversationId,
      floristId,
      channel: msg.channel,
      replyTo: msg.fromAddress,
      subject: msg.subject,
    });
    return { ok: true, action: turn.action };
  } catch (e) {
    captureError("conversations.ingestInbound", e);
    return { ok: false, action: "error" };
  }
}

/** Unused today but referenced by the CX surface's copy — kept beside the facts
 * the agent is allowed to assert so the two are edited together. */
export const AGENT_FACT_COUNT = APPROVED_FACTS.length;
export { FLORIST_BASE };

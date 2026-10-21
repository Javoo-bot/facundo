import { requireRole, jsonError } from "@/lib/apiAuth";
import { defaultFromAddress } from "@/lib/emailFrom";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { sendEmail } from "@/lib/email";
import { chooseReplyTo, floristReplyAddress } from "@/lib/replyToken";
import { sendSms } from "@/lib/sms";
import { resolvePersona, renderSignature, personaFromName, type Persona } from "@/lib/personas";
import { resolveFloristLocale } from "@/lib/i18n";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// CX acting on an escalated conversation: send a reply (their own words, or the
// AI's draft as edited), or close the thread.
//
// The reply goes out under the SAME persona the florist has been talking to.
// Switching to a staff member's own name mid-thread would tell the florist that
// the person they were writing to was never real — which is exactly the
// question this thread may already have been escalated for.

export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  let body: { conversationId?: string; action?: "send" | "close"; text?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }
  const { conversationId, action } = body;
  if (!conversationId || !action) return jsonError("conversationId and action are required.", 400);

  const admin = createServiceClient();
  const { data: convo } = await admin
    .from("conversations")
    .select("id, florist_id, channel, kind, status, persona_id")
    .eq("id", conversationId)
    .single();
  if (!convo) return jsonError("Conversation not found.", 404);

  if (action === "close") {
    await admin
      .from("conversations")
      .update({ status: "closed", cx_unread: false, updated_at: new Date().toISOString() })
      .eq("id", conversationId);
    return Response.json({ ok: true });
  }

  const text = (body.text ?? "").trim();
  if (!text) return jsonError("A reply needs some text.", 400);

  const { data: florist } = await admin
    .from("florists")
    .select("id, email, locale, city_id, phone_mobile, phone_web, phone_maps")
    .eq("id", convo.florist_id)
    .single();
  if (!florist) return jsonError("This conversation has no florist attached — reply by hand.", 409);

  const { data: settings } = await admin
    .from("app_settings")
    .select("test_mode, test_email, test_phone")
    .eq("id", 1)
    .single();
  const testMode = settings?.test_mode ?? true;

  const { data: city } = florist.city_id
    ? await admin.from("cities").select("country").eq("id", florist.city_id).single()
    : { data: null };
  const locale = resolveFloristLocale({ locale: florist.locale }, city?.country ?? null);
  const { data: personaRows } = await admin.from("outreach_personas").select("*").eq("active", true);
  const persona = resolvePersona(locale, (personaRows ?? []) as Persona[]);
  if (!persona) return jsonError("No active persona for this market — add one in Settings first.", 409);

  // The last inbound message tells us where to reply.
  const { data: lastIn } = await admin
    .from("conversation_messages")
    .select("from_address, subject")
    .eq("conversation_id", conversationId)
    .eq("direction", "in")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const actor = gate.email || "staff";
  let sentOk = false;

  // The in-app order chat. It has no address to reach — the florist reads it
  // inside the PWA — so "sending" is writing the message into the thread they
  // are already looking at.
  //
  // This branch was missing, and the fallthrough was SMS: `to` resolved to the
  // last inbound message's from_address, which for an app message is null, so
  // Approve & send answered 409 "No number to reply to" and nothing left the
  // building. With test_mode on it would have been worse than nothing — the
  // reply would have gone as an SMS to the staff test phone while the florist
  // waited in the chat.
  if (convo.channel === "app") {
    await admin.from("conversation_messages").insert({
      conversation_id: conversationId,
      direction: "out",
      channel: "app",
      body_text: text,
      // Human-sent, even when the text started life as an AI draft — what
      // matters for the audit is that a person pressed send.
      ai_generated: false,
      status: "sent",
      actor,
    });
    await admin
      .from("conversations")
      .update({
        status: "bot",
        cx_unread: false,
        escalated_at: null,
        escalation_reason: null,
        auto_turns: 0,
        last_outbound_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", conversationId);
    return Response.json({ ok: true });
  }

  if (convo.channel === "email") {
    const to = testMode ? settings?.test_email : (florist.email as string | null);
    if (!to) return jsonError("No address to reply to (and no test email configured).", 409);
    const r = await sendEmail({
      to,
      from: `${personaFromName(persona)} <${defaultFromAddress()}>`,
      subject: lastIn?.subject ? `Re: ${String(lastIn.subject).replace(/^re:\s*/i, "")}` : "Re: Facundo",
      body: `${text}\n\n${renderSignature(persona)}`,
      replyTo:
        convo.kind === "recruiting"
          ? chooseReplyTo(floristReplyAddress(florist.id), persona.reply_to)
          : persona.reply_to,
      context: { audience: "florist", kind: "persona_reply", floristId: florist.id, testMode, actor },
    });
    sentOk = r.ok;
  } else {
    const to = testMode ? settings?.test_phone : (lastIn?.from_address as string | null);
    if (!to) return jsonError("No number to reply to (and no test phone configured).", 409);
    const r = await sendSms({
      to,
      body: `${text}\n- ${persona.name}, Facundo`,
      context: { operation: "persona_reply", audience: "florist", kind: "persona_reply", floristId: florist.id, testMode, actor },
    });
    sentOk = r.ok;
  }

  if (!sentOk) return jsonError("The message failed to send — it has not been recorded as sent.", 502);

  await admin.from("conversation_messages").insert({
    conversation_id: conversationId,
    direction: "out",
    channel: convo.channel,
    to_address: convo.channel === "email" ? florist.email : lastIn?.from_address ?? null,
    body_text: text,
    // Human-sent, even when the text started life as an AI draft — what matters
    // for the audit is that a person pressed send.
    ai_generated: false,
    status: "sent",
    actor,
  });

  await admin
    .from("conversations")
    .update({
      status: "bot",
      cx_unread: false,
      escalated_at: null,
      escalation_reason: null,
      // A human replying RESETS the unattended-turn count: the ceiling is on
      // consecutive AI turns, and a person has just looked at this thread.
      auto_turns: 0,
      persona_id: persona.id,
      last_outbound_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId);

  return Response.json({ ok: true });
}

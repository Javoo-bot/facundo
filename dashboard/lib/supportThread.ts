// The florist's side of a support conversation, from inside the app.
//
// The second front door onto the same thread the email webhook writes to. A
// florist who asks in the app and then replies to that order's email is in ONE
// conversation, because both doors key on (florist, order) and the partial
// unique index in 2026-08-12-support-conversations.sql enforces it.
//
// AUTHORISATION IS THE POINT OF THIS FILE. Everything here starts from an
// assignment id supplied by the browser, so the very first thing every entry
// point does is prove that assignment belongs to the signed-in florist. Reads
// then select an explicit column list rather than `*`: RLS is row-level and
// cannot hide ai_raw or ai_confidence on a row the florist may legitimately
// see, and the model's private reasoning about a florist is not theirs to read.

import { createServiceClient } from "@/lib/supabaseAdmin";
import { captureError } from "@/lib/monitor";
import { runAgentTurn } from "@/lib/agentTurn";

type Admin = ReturnType<typeof createServiceClient>;

/** What the florist is shown. Deliberately narrow — see the note above. */
export const THREAD_COLUMNS = "id, direction, body_text, ai_generated, actor, created_at";

export interface ThreadMessage {
  id: string;
  direction: "in" | "out";
  body_text: string | null;
  ai_generated: boolean;
  actor: string | null;
  created_at: string;
}

export interface Thread {
  conversationId: string;
  status: "bot" | "awaiting_human" | "closed";
  messages: ThreadMessage[];
}

/** The assignment, if and only if it is this florist's. Returns null otherwise —
 * an id belonging to someone else is indistinguishable from one that does not
 * exist, which is the correct thing for the caller to say back. */
async function ownedAssignment(
  admin: Admin,
  floristId: string,
  assignmentId: string
): Promise<{ id: string; order_id: string } | null> {
  const { data } = await admin
    .from("order_assignments")
    .select("id, order_id, florist_id")
    .eq("id", assignmentId)
    .maybeSingle();
  if (!data || data.florist_id !== floristId) return null;
  return { id: data.id as string, order_id: data.order_id as string };
}

/** The live support thread for this florist and order, creating one on first
 * use. Scoped by order, never by channel: the same thread must be found whether
 * the last message arrived in the app or by email. */
async function openThread(
  admin: Admin,
  floristId: string,
  orderId: string,
  assignmentId: string
): Promise<string | null> {
  const { data: open } = await admin
    .from("conversations")
    .select("id")
    .eq("florist_id", floristId)
    .eq("kind", "support")
    .eq("order_id", orderId)
    .neq("status", "closed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (open?.id) {
    // The thread may have been created by an unmatched email before we knew
    // which assignment it was. Fill that in rather than leaving the agent with
    // no facts to read.
    await admin
      .from("conversations")
      .update({ assignment_id: assignmentId, updated_at: new Date().toISOString() })
      .eq("id", open.id)
      .is("assignment_id", null);
    return open.id as string;
  }

  const { data: created, error } = await admin
    .from("conversations")
    .insert({
      florist_id: floristId,
      channel: "app",
      kind: "support",
      order_id: orderId,
      assignment_id: assignmentId,
      status: "bot",
      last_inbound_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error || !created) {
    captureError("supportThread.openThread", error);
    return null;
  }
  return created.id as string;
}

/** Read the thread for an order. Empty (not an error) when none has started —
 * the order page renders the same component either way. */
export async function readThread(floristId: string, assignmentId: string): Promise<Thread | null> {
  const admin = createServiceClient();
  const owned = await ownedAssignment(admin, floristId, assignmentId);
  if (!owned) return null;

  const { data: conv } = await admin
    .from("conversations")
    .select("id, status")
    .eq("florist_id", floristId)
    .eq("kind", "support")
    .eq("order_id", owned.order_id)
    .neq("status", "closed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!conv) return { conversationId: "", status: "bot", messages: [] };

  const { data: messages } = await admin
    .from("conversation_messages")
    .select(THREAD_COLUMNS)
    // The florist never sees a draft the escalation gate refused to send, nor a
    // message we deliberately suppressed. Mirrors the RLS policy exactly, so
    // this holds whether the read goes through the service role or the JWT.
    .in("status", ["received", "sent"])
    .eq("conversation_id", conv.id)
    .order("created_at", { ascending: true });

  // Reading it clears the badge.
  await admin
    .from("conversations")
    .update({ florist_unread: false })
    .eq("id", conv.id)
    .eq("florist_unread", true);

  return {
    conversationId: conv.id as string,
    status: conv.status as Thread["status"],
    messages: (messages ?? []) as ThreadMessage[],
  };
}

export interface PostResult {
  ok: boolean;
  conversationId?: string;
  /** The agent's reply, when one was sent. Null means a person has it now — the
   * UI says so rather than leaving the florist looking at their own message. */
  reply?: string | null;
  escalated?: boolean;
  error?: string;
}

/**
 * The florist asks something about one of their orders.
 *
 * Writes the message first and runs the agent second, in that order and never
 * the reverse: if the model or the network fails, the question is still on
 * record and on a human's desk. Losing what a florist typed because a third
 * party timed out is not a failure mode worth having.
 */
export async function postFloristMessage(
  floristId: string,
  assignmentId: string,
  text: string
): Promise<PostResult> {
  const body = String(text ?? "").trim();
  if (!body) return { ok: false, error: "empty" };
  // Long enough for a real question, short enough not to be a paste of an
  // entire email thread into a prompt.
  if (body.length > 4000) return { ok: false, error: "too-long" };

  const admin = createServiceClient();
  try {
    const owned = await ownedAssignment(admin, floristId, assignmentId);
    if (!owned) return { ok: false, error: "not-found" };

    const conversationId = await openThread(admin, floristId, owned.order_id, assignmentId);
    if (!conversationId) return { ok: false, error: "thread-failed" };

    const { error: insertError } = await admin.from("conversation_messages").insert({
      conversation_id: conversationId,
      direction: "in",
      channel: "app",
      body_text: body,
      status: "received",
      actor: "florist",
    });
    if (insertError) {
      captureError("supportThread.insert", insertError);
      return { ok: false, error: "write-failed" };
    }

    await admin
      .from("conversations")
      .update({
        last_inbound_at: new Date().toISOString(),
        cx_unread: true,
        updated_at: new Date().toISOString(),
      })
      .eq("id", conversationId);

    const turn = await runAgentTurn(admin, {
      conversationId,
      floristId,
      channel: "app",
    });

    return {
      ok: true,
      conversationId,
      reply: turn.reply,
      escalated: turn.action !== "replied",
    };
  } catch (e) {
    captureError("supportThread.postFloristMessage", e);
    return { ok: false, error: "failed" };
  }
}

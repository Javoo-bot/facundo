// One reply, from whichever agent owns the conversation.
//
// WHY THIS IS ITS OWN MODULE: a florist can ask the same question two ways —
// by replying to the order email, or by typing it into the app — and the two
// must produce the same answer under the same guards. Before this existed the
// turn was inline in lib/conversations.ts::ingestInbound, reachable only from a
// webhook. Adding a second front door by copying it would have meant two
// escalation gates, two disclosure rules, and a slow divergence nobody notices
// until the one that drifted is the one that sends.
//
// The channel only decides how the reply LEAVES. Everything before that —
// which facts, which taxonomy, which guards, the turn cap, the disclosure — is
// identical for all three.

import { captureError } from "@/lib/monitor";
import { defaultFromAddress } from "@/lib/emailFrom";
import { llmUnavailable } from "@/lib/cxAgentGuard";
import { escalationDecision } from "@/lib/cxAgentGuard";
import {
  draftPersonaReply,
  DEFAULT_CX_AGENT_MODEL,
  CONCIERGE_RULES_HASH,
  CUPID,
  type AgentKind,
  type TurnRunContext,
} from "@/lib/cxAgent";
import { traceAgentRun } from "@/lib/agentTrace";
import { resolvePersona, renderSignature, personaFromName, type Persona } from "@/lib/personas";
import { buildRecruitingTouch } from "@/lib/recruitingContent";
import { loadSupportFacts } from "@/lib/supportFacts";
import { buildPublishedHelpLines } from "@/lib/support/publishedHelp";
import { tWithOverrides } from "@/lib/i18n";
import { resolveFloristSendLocale } from "@/lib/floristLocale";
import { loadOverrides } from "@/lib/messageOverrides";
import { sendEmail } from "@/lib/email";
import { chooseReplyTo, floristReplyAddress } from "@/lib/replyToken";
import { sendSms } from "@/lib/sms";
import { replySubject } from "@/lib/replySubject";
import type { createServiceClient } from "@/lib/supabaseAdmin";

type Admin = ReturnType<typeof createServiceClient>;

export type TurnChannel = "email" | "sms" | "app";

export interface TurnArgs {
  conversationId: string;
  floristId: string;
  channel: TurnChannel;
  /** Where an email/SMS reply goes. Ignored for `app`, where the reply is the
   * thread row itself. */
  replyTo?: string | null;
  subject?: string | null;
}

export interface TurnResult {
  action: string;
  /** The text that was sent, for a caller that can show it immediately — the
   * in-app route returns it in the same request the florist is waiting on. */
  reply: string | null;
}

/** Mark a thread as a person's job. Always the safe direction, so every failure
 * path in this file ends here. */
export async function escalate(admin: Admin, conversationId: string, reason: string): Promise<void> {
  await admin
    .from("conversations")
    .update({
      status: "awaiting_human",
      escalated_at: new Date().toISOString(),
      escalation_reason: reason,
      cx_unread: true,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId);
}

const bail = async (admin: Admin, id: string, reason: string): Promise<TurnResult> => {
  await escalate(admin, id, reason);
  return { action: `escalated:${reason}`, reply: null };
};

/**
 * Draft and, if every guard allows it, send the next reply in a conversation.
 *
 * Never throws. Every failure — no settings, no persona, no facts, a provider
 * error, a refused draft — ends as an escalation with a named reason, because a
 * human reading a thread we could not handle is a cost and an unattended model
 * handling one it should not have is a liability.
 */
export async function runAgentTurn(admin: Admin, args: TurnArgs): Promise<TurnResult> {
  const { conversationId, floristId, channel } = args;
  // Started as soon as the draft exists so it overlaps the send, and awaited in
  // `finally`: on Workers a floating promise is cancelled once the response is
  // returned (see app/[code]/route.ts). It never rejects and is a no-op where
  // LANGFUSE_* is unset, which is everywhere but the garden.
  let trace: Promise<unknown> = Promise.resolve();
  try {
    const { data: conv } = await admin
      .from("conversations")
      .select("kind, order_id, assignment_id, auto_turns, ai_disclosed_at")
      .eq("id", conversationId)
      .single();
    if (!conv) return bail(admin, conversationId, "conversation-missing");

    const kind = ((conv.kind as string) ?? "recruiting") as AgentKind;
    const autoTurns = (conv.auto_turns as number) ?? 0;
    const alreadyDisclosed = Boolean(conv.ai_disclosed_at);

    const { data: settings } = await admin
      .from("app_settings")
      .select(
        "cx_agent_enabled, support_agent_enabled, cx_agent_min_confidence, cx_agent_max_auto_turns, cx_agent_model, test_mode, test_email, test_phone"
      )
      .eq("id", 1)
      .single();

    // Each agent has its own switch. Reading the wrong one would let the
    // recruiting rollout silently turn on unattended replies about money.
    const enabled = kind === "support" ? settings?.support_agent_enabled : settings?.cx_agent_enabled;
    if (!enabled) return bail(admin, conversationId, "agent-disabled");

    // A missing key is a DEPLOYMENT fault, not a conversation that went wrong,
    // and it deserves to say so. Without this the call goes out with an empty
    // Authorization header, OpenRouter answers 401, and the thread lands on the
    // generic "agent-error" — a reason that is true, unactionable, and
    // identical to a model outage or a bad prompt.
    //
    // That is exactly how this was found: the switch was turned on, every
    // question escalated as "agent-error", and the cause (the dashboard Worker
    // has ANTHROPIC_API_KEY and never had OPENROUTER_API_KEY) was only visible
    // by listing the Worker's secrets. The reason string is the one diagnostic
    // that reaches a human without log access, so it should name the fault.
    if (!process.env.OPENROUTER_API_KEY) {
      captureError("agentTurn.config", new Error("OPENROUTER_API_KEY is not set on this deployment"));
      return bail(admin, conversationId, "agent-no-api-key");
    }

    const { data: florist } = await admin
      .from("florists")
      .select("id, name, email, locale, address, city_id, joined_at, excluded_at, order_emails_opt_out, order_sms_opt_out")
      .eq("id", floristId)
      .single();
    if (!florist) return bail(admin, conversationId, "florist-missing");

    const { data: city } = florist.city_id
      ? await admin.from("cities").select("city, country").eq("id", florist.city_id).single()
      : { data: null };
    const locale = resolveFloristSendLocale(
      { locale: florist.locale, address: florist.address },
      city?.country ?? null
    );

    const { data: personaRows } = await admin.from("outreach_personas").select("*").eq("active", true);
    const persona = resolvePersona(locale, (personaRows ?? []) as Persona[]);
    if (!persona) return bail(admin, conversationId, "no-persona");

    const { data: thread } = await admin
      .from("conversation_messages")
      .select("direction, body_text")
      .eq("conversation_id", conversationId)
      .in("status", ["received", "sent"])
      .order("created_at", { ascending: true })
      .limit(10);

    const overrides = await loadOverrides(admin, locale);

    // ---- what this agent is allowed to say ---------------------------------
    let canonicalPitch: string | undefined;
    let facts: string[] | undefined;
    let helpFacts: string[] | undefined;
    let allowedAmounts: number[] = [];

    if (kind === "support") {
      const assignmentId = conv.assignment_id as string | null;
      // A support thread with no assignment has no order, and therefore no
      // facts. There is nothing to answer from, so it goes straight to a
      // person rather than to a model with an empty list.
      if (!assignmentId) return bail(admin, conversationId, "no-order");

      const built = await loadSupportFacts(admin, assignmentId, conv.order_id as string | null);
      if (built.empty) return bail(admin, conversationId, "no-facts");
      // A colleague is already handling a reported problem on this order.
      // Bail before drafting at all — there is no reply worth generating for
      // a thread a human is already on, disclosure question included.
      if (built.hasOpenIssue) return bail(admin, conversationId, "open-issue");
      facts = built.lines;
      allowedAmounts = built.allowedAmounts;
      // General, published policy/how-to — the same for every florist, never
      // fed into allowedAmounts. See lib/support/publishedHelp.ts.
      helpFacts = buildPublishedHelpLines(overrides, locale);
    } else {
      const pitch = buildRecruitingTouch("t1", locale, overrides, {
        city: city?.city ?? null,
        hasReviews: false,
        joinUrl: null,
      });
      canonicalPitch = pitch.body;
    }

    let judgment;
    const startedAt = new Date();
    try {
      judgment = await draftPersonaReply({
        input: {
          personaName: persona.name,
          personaRole: persona.role_title,
          locale,
          kind,
          canonicalPitch,
          facts,
          helpFacts,
          thread: (thread ?? []).map((m) => ({
            direction: m.direction as "in" | "out",
            body: (m.body_text as string) ?? "",
          })),
        },
        apiKey: process.env.OPENROUTER_API_KEY ?? "",
        model: (settings?.cx_agent_model as string) || DEFAULT_CX_AGENT_MODEL,
      });
    } catch (e) {
      captureError("agentTurn.draft", e);
      // Name the fault where we can. "agent-error" is true of a bad prompt, a
      // model outage, an exhausted key and a rate limit alike, and the reason
      // string is the only diagnostic that reaches a human without Worker log
      // access — so the cases we CAN tell apart should say which they are.
      // lib/cxAgent.ts throws `OpenRouter <status>: …`, which is enough.
      return bail(admin, conversationId, llmUnavailable(e) ? "agent-llm-unavailable" : "agent-error");
    }

    // `eligible` means different things to the two agents, and getting it the
    // wrong way round would make each of them answer exactly the florists the
    // other one is for: recruiting talks to shops that have NOT joined, support
    // to shops that have.
    //
    // For support specifically, "has not joined" is NOT the same question as
    // "is this an excluded or wrong-kind-of shop" — a florist can reach this
    // branch with a real order attached (a cold offer, or a staff manual
    // override via POST /api/orders/assign, which deliberately bypasses the
    // onboarded filter) and no `joined_at` yet, because it has not accepted
    // yet: both kinds of shop join when they accept (lib/coldOffer.ts::
    // provisionalSourceOnAccept). That shop is
    // not excluded and is exactly the kind of shop this assistant serves, so
    // it gets its own reason (`not_joined`) instead of being folded into
    // `not_eligible`, which reads as "exclude this shop" to CX.
    const eligible = kind === "support" ? !florist.excluded_at : !florist.excluded_at && !florist.joined_at;
    const notJoinedYet = kind === "support" && !florist.joined_at;

    const decision = escalationDecision(judgment, {
      autoTurns,
      maxAutoTurns: (settings?.cx_agent_max_auto_turns as number) ?? 3,
      minConfidence: Number(settings?.cx_agent_min_confidence ?? 0.75),
      eligible,
      notJoinedYet,
      kind,
      allowedAmounts,
    });

    const aiContext: TurnRunContext =
      kind === "support"
        ? {
            agent: "concierge",
            prompt: judgment.prompt,
            facts: facts ?? [],
            helpFacts: helpFacts ?? [],
            allowedAmounts,
            rulesHash: CONCIERGE_RULES_HASH,
          }
        : { agent: "cupid", prompt: judgment.prompt, canonicalPitch: canonicalPitch ?? null, rulesHash: CUPID.rulesHash };

    const raw = judgment.raw as { escalation_reason?: string | null } | null;
    trace = traceAgentRun({
      agent: aiContext.agent,
      sessionId: conversationId,
      metadata: {
        intent: judgment.intent,
        confidence: judgment.confidence,
        escalate: judgment.escalate ?? false,
        escalation_reason: raw?.escalation_reason ?? null,
        guard_action: decision.action,
        guard_reason: decision.action === "escalate" ? decision.reason : null,
      },
      generations: [
        {
          name: "draft",
          model: judgment.model,
          input: judgment.prompt,
          output: judgment.raw,
          usage: judgment.usage,
          startedAt,
          endedAt: new Date(),
        },
      ],
    });

    const draftRow = {
      conversation_id: conversationId,
      direction: "out" as const,
      channel,
      to_address: channel === "app" ? null : (args.replyTo ?? null),
      subject: replySubject(args.subject),
      body_text: judgment.replyText,
      ai_generated: true,
      ai_model: judgment.model,
      ai_confidence: judgment.confidence,
      ai_intent: judgment.intent,
      ai_escalate: judgment.escalate ?? false,
      ai_raw: judgment.raw as Record<string, unknown>,
      ai_context: aiContext,
    };

    if (decision.action === "escalate") {
      // Stored as a draft either way: an escalation CX can approve in one click
      // is worth far more than a queue entry saying "something arrived".
      await admin.from("conversation_messages").insert({ ...draftRow, status: "draft" });
      await escalate(admin, conversationId, decision.reason);
      return { action: `escalated:${decision.reason}`, reply: null };
    }

    // ---- send --------------------------------------------------------------
    const testMode = settings?.test_mode ?? true;
    const signature = renderSignature({ ...persona, signature_note: null });
    const disclose = !alreadyDisclosed;
    const disclosure = disclose ? tWithOverrides(overrides, locale, "email.disclosure.proactive") : null;
    const body = [judgment.replyText, disclosure, signature].filter(Boolean).join("\n\n");

    let sentOk = false;
    if (channel === "app") {
      // Nothing leaves the building. The thread row IS the delivery, and the
      // florist is looking at it — which is also why there is no test_mode
      // redirect here: there is no third party to protect from a test message.
      sentOk = true;
    } else if (channel === "email") {
      const to = testMode ? (settings?.test_email as string | null) : (florist.email as string | null);
      if (to) {
        const r = await sendEmail({
          to,
          from: `${personaFromName(persona)} <${defaultFromAddress()}>`,
          subject: draftRow.subject ?? "Re: Facundo",
          body,
          replyTo:
            kind === "recruiting"
              ? chooseReplyTo(floristReplyAddress(floristId), persona.reply_to)
              : persona.reply_to,
          context: {
            audience: "florist",
            kind: kind === "support" ? "support_reply" : "persona_reply",
            floristId,
            orderId: (conv.order_id as string) ?? null,
            assignmentId: (conv.assignment_id as string) ?? null,
            testMode,
            actor: "system",
          },
        });
        sentOk = r.ok;
      }
    } else {
      const to = testMode ? (settings?.test_phone as string | null) : (args.replyTo ?? null);
      if (to) {
        const r = await sendSms({
          to,
          body: [judgment.replyText, disclosure, `- ${persona.name}, Facundo`].filter(Boolean).join("\n"),
          context: {
            operation: "persona_reply",
            audience: "florist",
            kind: kind === "support" ? "support_reply" : "persona_reply",
            floristId,
            testMode,
            actor: "system",
          },
        });
        sentOk = r.ok;
      }
    }

    if (!sentOk) {
      await admin.from("conversation_messages").insert({ ...draftRow, status: "draft" });
      await escalate(admin, conversationId, "send-failed");
      return { action: "escalated:send-failed", reply: null };
    }

    await admin.from("conversation_messages").insert({
      ...draftRow,
      // In the app the florist reads the disclosure and signature as part of
      // the message; over email they are appended to the body. Store what was
      // actually shown, or the CX view and the florist view disagree.
      body_text: channel === "app" ? body : judgment.replyText,
      status: "sent",
    });
    await admin
      .from("conversations")
      .update({
        auto_turns: autoTurns + 1,
        last_outbound_at: new Date().toISOString(),
        persona_id: persona.id,
        cx_unread: false,
        florist_unread: channel !== "app",
        ...(disclose ? { ai_disclosed_at: new Date().toISOString() } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", conversationId);

    return { action: "replied", reply: channel === "app" ? body : judgment.replyText };
  } catch (e) {
    captureError("agentTurn.runAgentTurn", e);
    // Even the unexpected path escalates rather than leaving a thread silent.
    await escalate(admin, conversationId, "turn-error").catch(() => {});
    return { action: "error", reply: null };
  } finally {
    await trace;
  }
}

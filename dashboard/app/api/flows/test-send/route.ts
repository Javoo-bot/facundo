import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { defaultFrom, defaultFromAddress } from "@/lib/emailFrom";
import { sendEmail } from "@/lib/email";
import { sendSms } from "@/lib/sms";
import { isLocale, DEFAULT_LOCALE, type Locale } from "@/lib/i18n";
import { loadOverrides } from "@/lib/messageOverrides";
import { messageById } from "@/lib/messages/registry";
import { buildRecruitingTouch, RECRUIT_TOUCHES, REACTIVATE_TOUCHES, type RecruitTouch } from "@/lib/recruitingContent";
import { composeRecruitingEmail } from "@/lib/recruitingEmail";
import { resolveVoiceFor } from "@/lib/messageVoice";
import { resolvePersona, personaFromName, type Persona } from "@/lib/personas";
import { FLORIST_BASE } from "@/lib/emailLinks";
import { richTextToPlain } from "@/lib/messages/richText";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Send me this one, now" — the button that closes the loop on the funnel
// editor. An editor changes a subject line, presses it, and reads the result in
// the shared test inbox; nothing about that needs a developer.
//
// Three properties this route holds, in order of how badly each would hurt:
//
//  1. It can only ever send to `app_settings.test_email`. The recipient is not
//     an input. There is no parameter to get wrong and no way to make this
//     route mail a florist.
//  2. It always carries the test banner (`testMode: true`), because that inbox
//     is shared and a test that looks exactly like a real send is precisely
//     what makes someone act on one.
//  3. It renders through the SAME composition a real send uses — the message's
//     registry builder for everything with a builder, and
//     lib/recruitingEmail.ts::composeRecruitingEmail for the funnel touches,
//     which is the function lib/sequences/tick.ts calls. A test that renders
//     its own approximation would be worth less than no test at all.
//
// `edits` is layered exactly as /api/messages/preview layers it, so a test can
// be sent on an UNPUBLISHED subject line. That is the point: you check the
// wording before it is live, not after.

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const RECRUIT_KEYS = new Set<string>([...RECRUIT_TOUCHES, ...REACTIVATE_TOUCHES]);

/** `recruit.t2` / `recruit.co1` → the touch and its copy namespace. Returns
 * null for every other registry id, which then goes through its own builder. */
function recruitTouchOf(messageId: string): { touch: RecruitTouch; ns: string } | null {
  const suffix = messageId.startsWith("recruit.") ? messageId.slice("recruit.".length) : null;
  if (!suffix || !RECRUIT_KEYS.has(suffix)) return null;
  return { touch: suffix as RecruitTouch, ns: REACTIVATE_TOUCHES.includes(suffix as RecruitTouch) ? "reactivate" : "recruit" };
}

// Sample values for the one thing a test send has no real source for: the
// order/shop behind the message. Deliberately production-shaped, and
// deliberately obvious as a sample once read.
const SAMPLE_CITY = "Girona";
const SAMPLE_JOIN_URL = `${FLORIST_BASE}/join/9f2c8a71-4d3e-4b52-9c1a-0e7f6d5b4a39`;

export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }
  const { messageId, locale: rawLocale, edits: rawEdits } = (body ?? {}) as {
    messageId?: unknown;
    locale?: unknown;
    edits?: unknown;
  };

  if (typeof messageId !== "string") return jsonError("messageId is required.", 400);
  const message = messageById(messageId);
  if (!message) return jsonError(`Unknown message: ${messageId}`, 404);

  const admin = createServiceClient();
  const { data: s } = await admin
    .from("app_settings")
    .select("test_email, test_phone, message_voice")
    .eq("id", 1)
    .maybeSingle();

  const settings = (s ?? {}) as Record<string, unknown>;
  const to = typeof settings.test_email === "string" ? settings.test_email : null;
  const toPhone = typeof settings.test_phone === "string" ? settings.test_phone : null;

  const locale: Locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const effectiveLocale: Locale = message.localized ? locale : DEFAULT_LOCALE;

  // Unsaved edits, string values only — anything else is ignored rather than
  // trusted, same as the preview route.
  const edits: Record<string, string> = {};
  if (rawEdits && typeof rawEdits === "object") {
    for (const [k, v] of Object.entries(rawEdits as Record<string, unknown>)) {
      if (typeof k === "string" && typeof v === "string") edits[k] = v;
    }
  }

  // published < draft < unsaved. The middle layer is what makes "save the
  // draft, send a test, publish when it reads right" a workflow rather than
  // three unrelated buttons.
  const published = await loadOverrides(admin, effectiveLocale);
  const { data: draftRows } = await admin
    .from("message_override_drafts")
    .select("key,value")
    .eq("locale", effectiveLocale);
  const drafts: Record<string, string> = {};
  for (const row of (draftRows ?? []) as { key: unknown; value: unknown }[]) {
    if (typeof row.key === "string" && typeof row.value === "string") drafts[row.key] = row.value;
  }
  const overrides = { ...published, ...drafts, ...edits };

  // ---- SMS ----
  if (message.channel === "sms") {
    if (!toPhone) return jsonError("No test phone number is configured — set one in Settings first.", 400);
    const { bodyText } = message.render(effectiveLocale, overrides);
    const sent = await sendSms({
      to: toPhone,
      body: bodyText,
      context: { audience: "florist", kind: `flowtest.${message.id}`, testMode: true, actor: gate.email },
    });
    if (!sent.ok) return Response.json({ ok: false, to: toPhone, error: sent.error }, { status: 502 });
    return Response.json({ ok: true, channel: "sms", to: toPhone });
  }

  // ---- email ----
  if (!to || !EMAIL_RE.test(to)) {
    return jsonError("No valid test email is configured — set one in Settings first.", 400);
  }

  const touch = recruitTouchOf(message.id);
  let subject: string;
  let html: string;
  let text: string;
  let from = defaultFrom();

  if (touch) {
    // A funnel touch. Composed through the tick's own path, including the
    // persona signature and the voice — a plain-voice email that arrives
    // branded is exactly the drift this route exists to catch.
    const { data: personaRows } = await admin.from("outreach_personas").select("*").eq("active", true);
    const persona = resolvePersona(effectiveLocale, (personaRows ?? []) as Persona[]);
    const kind = `${touch.ns}.${touch.touch}`;
    // t1 is the one company-voice touch, and it is branded by decision rather
    // than by settings — see the `voice` overrides in lib/sequences/definitions.ts.
    const isCompanyTouch = touch.touch === "t1";
    const voice = isCompanyTouch
      ? "branded"
      : resolveVoiceFor(settings as { message_voice?: Record<string, unknown> | null }, kind, "plain");

    const built = buildRecruitingTouch(
      touch.touch,
      effectiveLocale,
      overrides,
      { city: SAMPLE_CITY, hasReviews: false, joinUrl: SAMPLE_JOIN_URL },
      touch.ns
    );
    const composed = composeRecruitingEmail(built, {
      locale: effectiveLocale,
      overrides,
      voice,
      persona: isCompanyTouch ? null : persona,
      // No token to unsubscribe: this is a test to our own inbox, and minting
      // one for a florist who is not the recipient would be worse than the
      // missing line.
      unsubscribeUrl: null,
      testMode: true,
    });
    subject = composed.subject;
    html = composed.html;
    text = composed.bodyText;
    if (!isCompanyTouch && persona) from = `${personaFromName(persona)} <${defaultFromAddress()}>`;
  } else {
    // Everything else already has a builder that returns a whole email.
    const built = message.render(effectiveLocale, overrides);
    subject = built.subject;
    html = built.html;
    text = built.bodyText;
  }

  // lib/email.ts strips markup from subjects before sending; do the same here
  // so what comes back in the inbox matches what the editor showed.
  subject = richTextToPlain(subject);

  const sent = await sendEmail({
    to,
    from,
    subject,
    body: text,
    html,
    context: {
      operation: "flow_test_email",
      audience: "staff",
      kind: `flowtest.${message.id}`,
      testMode: true,
      actor: gate.email,
    },
  });

  if (!sent.ok) return Response.json({ ok: false, to, error: sent.error }, { status: 502 });
  return Response.json({ ok: true, channel: "email", to, subject });
}

import { requireRole } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { isLocale, DEFAULT_LOCALE, t, type Locale } from "@/lib/i18n";
import { loadOverrides } from "@/lib/messageOverrides";
import { messageById, MESSAGES } from "@/lib/messages/registry";
import { previewOverrides, tagPreviewHtml, stripSentinels, keysInOrder } from "@/lib/messages/previewTags";
import { richTextToPlain } from "@/lib/messages/richText";
import { smsSegments, isGsm7 } from "@/lib/smsSegments";
import { missingVars } from "@/lib/i18n/varsManifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Renders any message for the editor, with UNSAVED edits layered on top.
//
// `edits` is the point: it lets the preview show what a change looks like
// before anything is written, so the editor is live as you type. They are
// layered over the published overrides exactly as a real send would layer
// them, and the render goes through the message's real builder — so what the
// preview shows is what a send would produce with those values.
//
// GET (no body) lists the messages, so the editor doesn't hardcode them.

export async function GET(): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;
  return Response.json({
    messages: MESSAGES.map((m) => ({
      id: m.id,
      label: m.label,
      note: m.note,
      channel: m.channel,
      audience: m.audience,
      localized: m.localized,
      variables: m.variables,
    })),
  });
}

export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { messageId, locale: rawLocale, edits: rawEdits } = (body ?? {}) as {
    messageId?: unknown;
    locale?: unknown;
    edits?: unknown;
  };

  if (typeof messageId !== "string") return Response.json({ error: "messageId is required." }, { status: 400 });
  const message = messageById(messageId);
  if (!message) return Response.json({ error: `Unknown message: ${messageId}` }, { status: 404 });

  const locale: Locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  // A message that isn't localized only ever sends in English; previewing it in
  // another locale would show something we never send.
  const effectiveLocale: Locale = message.localized ? locale : DEFAULT_LOCALE;

  // Unsaved edits: string values only, and only for keys the caller actually
  // sent — anything else is ignored rather than trusted.
  const edits: Record<string, string> = {};
  if (rawEdits && typeof rawEdits === "object") {
    for (const [k, v] of Object.entries(rawEdits as Record<string, unknown>)) {
      if (typeof k === "string" && typeof v === "string") edits[k] = v;
    }
  }

  const published = await loadOverrides(createServiceClient(), effectiveLocale);
  const layered = { ...published, ...edits };

  // Render twice: once tagged (for the editor's click targets) and once plain
  // (what a real send produces). The plain pass is what the warnings below are
  // computed from, so a warning can never be an artefact of the tagging.
  const tagged = message.render(effectiveLocale, previewOverrides(layered, effectiveLocale));
  const plain = message.render(effectiveLocale, layered);

  const warnings: { key: string | null; message: string }[] = [];

  // Placeholder loss is the one edit that silently breaks a real send: the
  // recipient sees a literal {city}.
  for (const [key, value] of Object.entries(edits)) {
    const missing = missingVars(key, value);
    if (missing.length > 0) {
      warnings.push({ key, message: `Missing ${missing.map((v) => `{${v}}`).join(", ")} — the recipient will see a blank or a literal token.` });
    }
    if (value.includes("—")) {
      warnings.push({ key, message: "Contains an em dash. House style is a comma, colon or full stop, and an em dash is outside GSM-7." });
    }
  }

  // SMS costs money per segment, and one accented character doubles it.
  if (message.channel === "sms") {
    const segments = smsSegments(plain.bodyText);
    if (!isGsm7(plain.bodyText)) {
      warnings.push({ key: null, message: `Not GSM-7: this message drops to 70-character segments and costs about twice as much.` });
    }
    if (segments > 3) {
      warnings.push({ key: null, message: `${segments} segments (budget is 3). Every send costs ${segments} times the base rate.` });
    }
  }

  return Response.json({
    id: message.id,
    label: message.label,
    note: message.note,
    channel: message.channel,
    locale: effectiveLocale,
    // What the editor may offer as insertable tokens for THIS message.
    variables: message.variables,
    // Subjects are plain text at the mail layer and lib/email.ts strips markup
    // from them before sending, so the preview must show the same thing rather
    // than a bolded subject the recipient will never see.
    subject: richTextToPlain(stripSentinels(tagged.subject)),
    // Which catalog key(s) the subject came from. /messages doesn't need this
    // (its preview is click-to-focus over the whole message), but /flows shows
    // one labelled "Subject line" box per step and must know which of `keys`
    // that box writes — inferring "the first one" would break the moment a
    // touch gained a preheader.
    subjectKeys: keysInOrder(tagged.subject),
    html: message.channel === "email" ? tagPreviewHtml(tagged.html) : "",
    text: stripSentinels(tagged.bodyText),
    // Document order, so the editor's field list matches the reading order of
    // the message rather than an arbitrary catalog order.
    keys: keysInOrder(tagged.subject + tagged.html + tagged.bodyText),
    // The OVERRIDE for each key, or null when there isn't one. /messages shows
    // these raw, where blank correctly means "not overridden".
    values: Object.fromEntries(
      keysInOrder(tagged.subject + tagged.html + tagged.bodyText).map((k) => [k, layered[k] ?? null])
    ),
    // What each key ACTUALLY SAYS: the override if there is one, otherwise the
    // built-in string — the raw template, with `{city}` still in it, so a field
    // bound to this can be edited and saved back unchanged. `/flows` needs
    // this: a Subject box that renders empty because nobody has overridden the
    // subject reads as "there is no subject", which is how this was reported.
    defaults: Object.fromEntries(
      keysInOrder(tagged.subject + tagged.html + tagged.bodyText).map((k) => [
        k,
        layered[k] ?? t(effectiveLocale, k),
      ])
    ),
    segments: message.channel === "sms" ? smsSegments(plain.bodyText) : null,
    warnings,
  });
}

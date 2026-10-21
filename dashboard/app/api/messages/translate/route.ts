import { requireRole } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { flattenKeys, LOCALES, staticLookup, DEFAULT_LOCALE, type Locale } from "@/lib/i18n";
import { loadOverrides } from "@/lib/messageOverrides";
import { buildTranslationPrompt, parseTranslationReply, judgeTranslations } from "@/lib/messages/translate";
import { personaliseRecruitingEmail, DEFAULT_RECRUITING_MODEL } from "@/lib/recruitingPersonalise";
import { COPY_MARKER, sourceOf } from "@/lib/flows/customSteps";
import { agentSpec } from "@/lib/agents/registry.generated";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_KEYS = new Set(flattenKeys());

/** A DUPLICATE's keys are not in the catalog — the copy was created at
 *  runtime — but they are a catalog key with the copy marker in the step
 *  segment. Without this a duplicate could be written in English and never
 *  translated, which is the one way to end up with a funnel that sends a new
 *  message in one language and the old one in five. */
function isTranslatableKey(key: string): boolean {
  if (VALID_KEYS.has(key)) return true;
  if (!key.includes(COPY_MARKER)) return false;
  return VALID_KEYS.has(key.split(".").map((p) => (p.includes(COPY_MARKER) ? sourceOf(p) : p)).join("."));
}

// Draft the other five locales for one English string.
//
// Everything lands as a DRAFT — nothing is published, and a candidate that
// fails a guard produces no draft at all and reports why. The failure modes
// being guarded are not stylistic: a lost {placeholder} reaches a florist as a
// literal "{city}", and a non-GSM-7 SMS costs roughly double on every send
// forever.
export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { key, value } = (body ?? {}) as { key?: unknown; value?: unknown };
  if (typeof key !== "string" || !isTranslatableKey(key)) {
    return Response.json({ error: `Unknown message key: ${String(key)}` }, { status: 400 });
  }
  // The English text to translate FROM: whatever the editor currently has,
  // falling back to the published override and then the catalog.
  const admin = createServiceClient();
  const publishedEn = await loadOverrides(admin, DEFAULT_LOCALE);
  // A copy's English text lives only in message_overrides (it has no catalog
  // entry), so fall back to the key it was copied FROM rather than to nothing.
  const catalogKey = key.includes(COPY_MARKER)
    ? key.split(".").map((p) => (p.includes(COPY_MARKER) ? sourceOf(p) : p)).join(".")
    : key;
  const source =
    typeof value === "string" && value.trim()
      ? value
      : publishedEn[key] ?? staticLookup(DEFAULT_LOCALE, catalogKey) ?? "";
  if (!source) return Response.json({ error: "Nothing to translate for that key." }, { status: 400 });

  const targets = LOCALES.filter((l) => l !== DEFAULT_LOCALE) as Locale[];

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "Translation needs OPENROUTER_API_KEY. Edits are unaffected; the other locales just stay as they are." },
      { status: 503 }
    );
  }

  // Reuses the OpenRouter caller from the recruiting leg: same key, same
  // timeout and failure handling. It expects a "Subject:" prefix for that use,
  // so we go through its raw sibling by asking for JSON and parsing here.
  const prompt = buildTranslationPrompt(key, source, targets);
  const model = process.env.OPENROUTER_TRANSLATION_MODEL || DEFAULT_RECRUITING_MODEL;
  const reply = await personaliseRecruitingEmail({
    prompt,
    apiKey,
    model,
    requireSubjectLine: false,
    trace: { agent: "polyglot", sessionId: key, metadata: { key } },
  });
  if (!reply) {
    return Response.json({ error: "The translation service didn't respond. Nothing was changed." }, { status: 502 });
  }

  const verdicts = judgeTranslations(key, source, parseTranslationReply(reply, targets));
  if (verdicts.length === 0) {
    return Response.json({ error: "Couldn't read the translation service's reply. Nothing was changed." }, { status: 502 });
  }

  const accepted = verdicts.filter((v) => v.ok);
  if (accepted.length > 0) {
    const aiContext = { agent: "polyglot", prompt, model, source, rulesHash: agentSpec("polyglot").rulesHash };
    const { error } = await admin.from("message_override_drafts").upsert(
      accepted.map((v) => ({
        locale: v.locale,
        key,
        value: v.value,
        updated_at: new Date().toISOString(),
        updated_by: `${gate.email} (machine translation)`,
        ai_context: aiContext,
      })),
      { onConflict: "locale,key" }
    );
    if (error) return Response.json({ error: `Could not save drafts: ${error.message}` }, { status: 500 });
  }

  return Response.json({
    key,
    source,
    drafted: accepted.map((v) => v.locale),
    rejected: verdicts.filter((v) => !v.ok).map((v) => ({ locale: v.locale, reasons: v.reasons })),
  });
}

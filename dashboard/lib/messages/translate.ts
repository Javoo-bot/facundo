// Machine-drafted translations for the message editor.
//
// Editing the English copy leaves the other five locales showing the old text —
// the "one English change = five translations" tax the copy review kept hitting.
// This drafts the other five through the same OpenRouter integration the
// recruiting personalisation uses, into the SAME draft flow, so nothing goes
// live unreviewed.
//
// Every candidate must survive the guards below or no draft is created and the
// reason is reported. These are not stylistic preferences:
//
//   - a lost {placeholder} means a florist reads a literal "{city}";
//   - a non-GSM-7 SMS drops to 67-character segments and costs about twice as
//     much on EVERY send, forever;
//   - an em dash is both house style and outside GSM-7.
//
// Relative imports only, so `node --test` can reach it.
import { missingVars } from "../i18n/varsManifest.ts";
import { isGsm7, smsSegments } from "../smsSegments.ts";
import type { Locale } from "../i18n/index.ts";

export const MAX_SMS_SEGMENTS = 3;

export interface TranslationCandidate {
  locale: Locale;
  value: string;
}

export interface TranslationVerdict {
  locale: Locale;
  value: string;
  ok: boolean;
  reasons: string[];
}

/** Language names the model is asked for, rather than bare codes — a BCP-47
 * tag alone invites the wrong regional register. */
export const LANGUAGE_NAMES: Record<string, string> = {
  fr: "French",
  es: "Spanish",
  it: "Italian",
  de: "German (informal 'du', matching the existing catalog)",
  pt: "Portuguese (European, but natural for Brazil too)",
};

/** Is this key an SMS string? SMS is the only channel where a translation can
 * cost real money, so it carries extra guards. */
export function isSmsKey(key: string): boolean {
  return key.startsWith("sms.");
}

/** Check one candidate translation against the source. Pure. */
export function checkTranslation(key: string, source: string, candidate: string): string[] {
  const reasons: string[] = [];
  const trimmed = candidate.trim();

  if (!trimmed) {
    reasons.push("Empty translation.");
    return reasons;
  }
  // Every {var} the source carries must survive. missingVars only knows keys in
  // the manifest, so also compare against the source's own placeholders — a key
  // the manifest hasn't caught up with still gets checked.
  const sourceVars = [...source.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  const lost = sourceVars.filter((v) => !trimmed.includes(`{${v}}`));
  for (const v of lost) reasons.push(`Lost {${v}} — the recipient would see a blank or a literal token.`);
  for (const v of missingVars(key, trimmed)) {
    if (!lost.includes(v)) reasons.push(`Missing {${v}}, which this message's send site interpolates.`);
  }

  if (trimmed.includes("—")) reasons.push("Contains an em dash.");

  if (isSmsKey(key)) {
    if (!isGsm7(trimmed)) {
      reasons.push("Not GSM-7: this would drop the whole message to 70-character segments and roughly double the cost of every send.");
    }
    // The guard is on the WHOLE rendered message, but a single string longer
    // than the budget is already doomed, so catch the obvious case here too.
    if (smsSegments(trimmed) > MAX_SMS_SEGMENTS) {
      reasons.push(`${smsSegments(trimmed)} segments on its own (budget is ${MAX_SMS_SEGMENTS}).`);
    }
  }
  return reasons;
}

/** Judge a batch. Never throws. */
export function judgeTranslations(
  key: string,
  source: string,
  candidates: TranslationCandidate[]
): TranslationVerdict[] {
  return candidates.map((c) => {
    const reasons = checkTranslation(key, source, c.value);
    return { locale: c.locale, value: c.value.trim(), ok: reasons.length === 0, reasons };
  });
}

/** The instruction sent to the model. Built here (not at the call site) so the
 * guards and the instructions that try to satisfy them stay together. */
export function buildTranslationPrompt(key: string, source: string, targets: Locale[]): string {
  const sms = isSmsKey(key);
  const vars = [...new Set([...source.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))];
  return `Translate one short string of product copy from a flower-delivery service to a local florist.

SOURCE (English):
${source}

Translate it into each of these languages, keeping the same tone and roughly the same length:
${targets.map((t) => `- ${t}: ${LANGUAGE_NAMES[t] ?? t}`).join("\n")}

Hard rules:
${vars.length ? `- Keep every placeholder exactly as written, character for character: ${vars.map((v) => `{${v}}`).join(", ")}. Do not translate them, do not add spaces inside the braces, do not invent new ones.` : "- There are no placeholders. Do not invent any."}
- Never use an em dash. Use a comma, a colon or a full stop.
${sms ? "- This is an SMS. It MUST stay within the GSM-7 character set: no accented characters at all, even where the language would normally use them, and no typographic quotes or dashes. One accented character doubles the cost of every message we send. Keep it as short as the source." : ""}

Return ONLY a JSON object mapping each language code to its translation, with no commentary and no code fence. Example shape: {"fr": "...", "es": "..."}`;
}

/** Parse the model's reply into candidates. Tolerates a stray code fence,
 * which models add despite being told not to. Returns [] on anything it can't
 * read, so the caller falls back to drafting nothing. */
export function parseTranslationReply(text: string, targets: Locale[]): TranslationCandidate[] {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const obj = parsed as Record<string, unknown>;
  const out: TranslationCandidate[] = [];
  for (const locale of targets) {
    const v = obj[locale];
    if (typeof v === "string" && v.trim()) out.push({ locale, value: v });
  }
  return out;
}

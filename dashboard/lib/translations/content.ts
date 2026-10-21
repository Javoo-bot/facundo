// The pure half of localising Shopify-sourced line-item content: the cache key,
// the prompt, the reply parser, and — the part that matters — the guards that
// decide whether a candidate translation is safe to put in front of a florist.
//
// A florist ACTS on this text. They buy the stems and build the arrangement
// from it. That makes a wrong translation worse than no translation: English
// they can paste into a translator, but "15 roses" where the source says 12 is
// a bouquet built wrong, and "Róż wolności" is a flower no wholesaler stocks.
// Both are real, measured cases (see the header of
// supabase/migrations/2026-08-06-line-item-translations.sql), which is why
// every candidate — Shopify's own included — has to survive checkContent().
//
// Relative imports only, so plain `node --test` can exercise it.

export type TranslatableField = "title" | "variant" | "recipe" | "components" | "addons";

export const TRANSLATABLE_FIELDS: TranslatableField[] = ["title", "variant", "recipe", "components", "addons"];

/** Language names rather than bare codes — a bare tag invites the wrong
 *  regional register. Mirrors lib/messages/translate.ts's map, minus the
 *  copy-tone notes, which belong to our own prose and not to product data. */
export const LANGUAGE_NAMES: Record<string, string> = {
  fr: "French",
  es: "Spanish",
  it: "Italian",
  de: "German",
  pt: "Portuguese (European, but natural for Brazil too)",
};

/**
 * Stable key for a piece of English source text.
 *
 * FNV-1a run twice with different offset bases and concatenated — 128 bits of
 * output from 64 bits of state, in ~10 lines of dependency-free JS. Deliberately
 * NOT a crypto hash: this runs in both Node and the Cloudflare Workers runtime,
 * and `crypto.subtle.digest` is async, which would make every caller of this
 * module async for no benefit. There is no adversary here — the only cost of a
 * collision is one line item showing another's translation, and at our
 * cardinality (thousands of distinct strings) that is not going to happen.
 *
 * Whitespace-normalised so a trailing space in Shopify's field doesn't fork the
 * cache. Case is NOT normalised: "White Vase" and "white vase" translate the
 * same but render differently, and we key what we will store.
 */
export function sourceHash(text: string): string {
  const s = text.replace(/\s+/g, " ").trim();
  const fnv = (offset: number): string => {
    let h = offset;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      // 32-bit FNV prime (16777619) via shifts — Math.imul keeps it exact.
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  return fnv(0x811c9dc5) + fnv(0x9dc5811c);
}

/**
 * Names that must survive translation untouched.
 *
 * "Freedom" is a rose CULTIVAR, not the noun. Shopify's own translations get
 * this wrong at scale — of the 27 recipes naming it, the translation mangles it
 * in 10/21 (fr), 14/21 (de), 11/21 (it) and 18/27 (pt-BR), producing "Roses de
 * la liberté", "Freiheit Rose" and "Róż wolności". A florist cannot order any
 * of those. Spanish is the only locale that mostly keeps it.
 *
 * Kept deliberately short and evidence-based: every entry is a token we have
 * actually seen mistranslated in production data. Botanical Latin (limonium,
 * ruscus, lentiscus, eucalyptus) is NOT here — those localise legitimately
 * ("Limonium" → "Limonio") and a florist reads them fine either way.
 */
export const PRESERVED_TOKENS = ["Freedom", "Anastasia", "Athena", "Lindt", "Moët", "Prosecco"];

/** Integers in the order they'd be counted, as a sorted multiset. Stem counts
 *  and sizes ("12 Freedom rose 50cm" → 12, 50) must both survive: one is how
 *  many to buy, the other is how long they are. */
export function numberTokens(text: string): string[] {
  return (text.match(/\d+/g) ?? []).slice().sort();
}

/** Non-empty lines, trimmed. A recipe is one ingredient per line and every one
 *  of them is a thing to buy, so losing a line loses an ingredient. */
export function contentLines(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Comma-separated entries — how `components`/`addons` arrive (the joined titles
 *  of referenced products). */
export function listEntries(text: string): string[] {
  return text.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Why this candidate can't be shown, or [] when it's safe.
 *
 * Applied to EVERY candidate regardless of provider. Shopify's translations are
 * the ones we measured going wrong, so exempting them would defeat the point.
 * A rejected candidate is not an error — the caller falls back to English,
 * which is always readable, if not ideal.
 */
export function checkContent(field: TranslatableField, source: string, candidate: string): string[] {
  const reasons: string[] = [];
  const trimmed = candidate.trim();

  if (!trimmed) return ["Empty translation."];

  // A translation that changed a number changed the order. This is the guard
  // that catches Shopify's stale recipes (12 roses in English, 15 in Spanish).
  const want = numberTokens(source);
  const got = numberTokens(trimmed);
  if (want.join(",") !== got.join(",")) {
    reasons.push(`Numbers changed: source has [${want.join(", ")}], candidate has [${got.join(", ")}]. A florist would buy the wrong count.`);
  }

  // Structure. A recipe is a shopping list; a components/addons string is a set
  // of things that go in the box. Dropping an entry drops an item.
  if (field === "recipe") {
    const srcLines = contentLines(source).length;
    const gotLines = contentLines(trimmed).length;
    if (srcLines !== gotLines) {
      reasons.push(`Recipe has ${srcLines} ingredient lines, candidate has ${gotLines}.`);
    }
  } else if (field === "components" || field === "addons") {
    const srcEntries = listEntries(source).length;
    const gotEntries = listEntries(trimmed).length;
    if (srcEntries !== gotEntries) {
      reasons.push(`List has ${srcEntries} entries, candidate has ${gotEntries}.`);
    }
  }

  // Cultivar and brand names.
  for (const token of PRESERVED_TOKENS) {
    const inSource = new RegExp(`\\b${token}\\b`, "i").test(source);
    if (inSource && !new RegExp(`\\b${token}\\b`, "i").test(trimmed)) {
      reasons.push(`Lost "${token}" — it is a cultivar/brand name, not a word to translate.`);
    }
  }

  // House style, same rule the rest of our outbound copy follows.
  if (trimmed.includes("—")) reasons.push("Contains an em dash.");

  return reasons;
}

export interface ContentRequest {
  /** Opaque handle the model echoes back. The source hash, in practice. */
  id: string;
  field: TranslatableField;
  source: string;
}

/** The instruction sent to the model, built here so the guards above and the
 *  rules that try to satisfy them stay in one file. Batched: one call covers
 *  every missing string on the page. */
export function buildContentPrompt(requests: ContentRequest[], locale: string): string {
  const language = LANGUAGE_NAMES[locale] ?? locale;
  const body = requests
    .map((r) => `--- id: ${r.id} (${FIELD_DESCRIPTION[r.field]})\n${r.source}`)
    .join("\n\n");
  return `You are translating the working details of a flower order for the FLORIST who will make it. They will buy the stems and build the arrangement from your text. They are a professional; use the ordinary trade vocabulary of the target language.

Translate each block below from English into ${language}.

${body}

Hard rules:
- Keep every number exactly as it appears. Stem counts and stem lengths are instructions to buy, not prose. Never round, merge, or re-order them.
- Keep the line structure. A recipe with five lines must come back as five lines, one ingredient each, in the same order.
- Do NOT translate cultivar, variety or brand names. "Freedom" in "12 Freedom rose 50cm" is the name of a red rose, not the word freedom; it stays "Freedom". Same for names like Anastasia, Athena, Lindt, Moët, Prosecco. Translate the common noun around them ("rose", "roses", "Rosen") and leave the name alone.
- Botanical names DO translate normally where the trade uses a local form (limonium, eucalyptus, ruscus, lentiscus).
- Never use an em dash.
- If you are unsure of a term, leave that term in English rather than inventing one.

Return ONLY a JSON object mapping each id to its translation, no commentary and no code fence. Shape: {"<id>": "<translation>", ...}`;
}

const FIELD_DESCRIPTION: Record<TranslatableField, string> = {
  title: "the product name of the item",
  variant: "the size or tier of the item, e.g. Classic / Premium / Deluxe",
  recipe: "the bouquet recipe, one ingredient per line",
  components: "a comma-separated list of what the arrangement includes",
  addons: "a comma-separated list of extras that go in the box",
};

/** Parse the model's reply into id → translation. Tolerates the stray code
 *  fence models add despite being told not to. Returns an empty map on anything
 *  unreadable, so the caller falls back rather than guessing. */
export function parseContentReply(text: string, ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object") return out;
  const obj = parsed as Record<string, unknown>;
  for (const id of ids) {
    const v = obj[id];
    if (typeof v === "string" && v.trim()) out.set(id, v.trim());
  }
  return out;
}

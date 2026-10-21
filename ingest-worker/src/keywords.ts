// Localized florist search-keyword cache, backed by country_keywords.
// Port of ingest/keywords.py. Cache-first; miss → Claude structured output.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LlmClient } from "./openrouter";
import { keywordSuggestionPrompt } from "./prompts";
import { structured, KEYWORDS_SCHEMA } from "./llm";
import type { KeywordSuggestion } from "./types";
import { WORKER_AGENTS } from "./agents.generated";

const MODEL = "claude-sonnet-5";

/** Canonicalize a country string so casing variants collapse to one key.
 * ≤3 chars → upper ("us"→"US"); longer → title-case ("spain"→"Spain"). */
export function normalizeCountry(country: string): string {
  const c = country.trim();
  if (c.length <= 3) return c.toUpperCase();
  return c.toLowerCase().replace(/(^|[\s'-])\S/g, (m) => m.toUpperCase());
}

export async function getKeywordsForCountry(
  sb: SupabaseClient,
  llm: LlmClient,
  countryRaw: string
): Promise<{ keywords: string[]; language: string }> {
  const country = normalizeCountry(countryRaw);
  const { data } = await sb
    .from("country_keywords")
    .select("keywords, language")
    .eq("country", country)
    .limit(1);
  if (data && data.length > 0) {
    return { keywords: data[0].keywords as string[], language: data[0].language as string };
  }
  const prompt = keywordSuggestionPrompt(country);
  const { parsed } = await structured<KeywordSuggestion>(llm, MODEL, prompt, KEYWORDS_SCHEMA, 512, {
    agent: "scout",
    name: "keywords",
    sessionId: country,
  });
  const aiContext = { agent: "scout", prompt, model: MODEL, rulesHash: WORKER_AGENTS.scout.rulesHash };
  await sb
    .from("country_keywords")
    .upsert({ country, keywords: parsed.keywords, language: parsed.language, ai_context: aiContext }, { onConflict: "country" });
  return { keywords: parsed.keywords, language: parsed.language };
}

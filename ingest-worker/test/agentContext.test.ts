// Layer 5: what each worker agent was shown is stored next to its answer
// (Sherlock on florists, Scout on country_keywords) and every call is traced.
import { describe, it, expect, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { enrichFlorist } from "../src/enrich";
import { getKeywordsForCountry } from "../src/keywords";
import { WORKER_AGENTS } from "../src/agents.generated";
import type { Env, ScrapedFlorist } from "../src/types";

afterEach(() => vi.unstubAllGlobals());

const LANGFUSE = "https://lf.example";
const llm = {
  apiKey: "sk-test",
  traceEnv: { LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_BASE_URL: LANGFUSE },
};
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** A fetch that plays the shop's website, OpenRouter and Langfuse. */
function world(answers: Record<string, unknown>) {
  const traces: { name: string; session: string; input: string }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
    if (url.startsWith(LANGFUSE)) {
      const root = JSON.parse(init!.body!).resourceSpans[0].scopeSpans[0].spans[0];
      const a = Object.fromEntries(root.attributes.map((x: { key: string; value: Record<string, string> }) => [x.key, Object.values(x.value)[0]]));
      traces.push({ name: a["langfuse.trace.name"], session: a["langfuse.session.id"], input: a["langfuse.trace.input"] });
      return new Response("", { status: 200 });
    }
    if (url.includes("openrouter.ai")) {
      const tool = JSON.parse(init!.body!).tool_choice.function.name as string;
      return json({
        choices: [{ message: { tool_calls: [{ function: { name: tool, arguments: JSON.stringify(answers[tool]) } }] } }],
        usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.0002 },
      });
    }
    const filler = "<p>Fresh bouquets for every occasion, delivered across the city by our team of florists.</p>".repeat(30);
    return new Response(
      `<html><head><title>Pivoine Demo</title></head><body><h1>Pivoine Demo</h1>${filler}` +
        `<p>Contact: <a href="mailto:hello@pivoine-demo.fr">hello@pivoine-demo.fr</a> or call +33 5 61 00 01 01.</p>` +
        `<p>About us: Camille founded the shop in 2009.</p></body></html>`,
      { status: 200, headers: { "content-type": "text/html" } }
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return traces;
}

describe("Sherlock", () => {
  it("returns every prompt it sent in enrichment_ai_context and traces each call under the place id", async () => {
    const traces = world({
      classify_ecommerce: { is_ecommerce: false, confidence: 0.8, reasoning: "no cart" },
      select_email: { email: "hello@pivoine-demo.fr", confidence: 0.9 },
      select_phone: { phone: "+33 5 61 00 01 01", confidence: 0.9 },
      owner_info: { owner_name: "Camille", shop_highlight: null, content_language: "en" },
    });
    const florist: ScrapedFlorist = {
      place_id: "place-42", name: "Pivoine Demo", address: "Toulouse", lat: null, lng: null, rating: null,
      review_count: null, phone_maps: null, website_url: "https://rouge-pivoine.example", maps_online_order: null,
      category_name: "Florist", categories: null,
    };
    const { result } = await enrichFlorist(florist, llm, {} as Env);

    expect(result.email).toBe("hello@pivoine-demo.fr");
    const ctx = result.enrichment_ai_context!;
    expect(ctx.agent).toBe("sherlock");
    expect(ctx.rulesHash).toBe(WORKER_AGENTS.sherlock.rulesHash);
    const email = ctx.calls.find((c) => c.name === "email")!;
    expect(email.model).toBe("anthropic/claude-haiku-4.5");
    expect(email.prompt).toContain("hello@pivoine-demo.fr");

    expect(traces.length).toBe(ctx.calls.length);
    for (const t of traces) {
      expect(t.name).toBe("Sherlock");
      expect(t.session).toBe("place-42");
    }
    expect(traces.map((t) => t.input)).toEqual(ctx.calls.map((c) => c.prompt));
  });

  it("stores no context when no model ran", async () => {
    const { result } = await enrichFlorist(
      { place_id: "p", name: null, address: null, lat: null, lng: null, rating: null, review_count: null,
        phone_maps: null, website_url: null, maps_online_order: null, category_name: null, categories: null },
      llm,
      {} as Env
    );
    expect(result.enrichment_ai_context).toBeNull();
  });
});

describe("Scout", () => {
  it("stores the prompt next to the keywords it chose, and traces the call under the country", async () => {
    const traces = world({ keyword_suggestion: { keywords: ["fleuriste"], language: "fr" } });
    const upserts: Record<string, unknown>[] = [];
    const sb = {
      from: () => ({
        select: () => ({ eq: () => ({ limit: async () => ({ data: [] }) }) }),
        upsert: async (row: Record<string, unknown>) => {
          upserts.push(row);
          return { error: null };
        },
      }),
    } as unknown as SupabaseClient;

    expect(await getKeywordsForCountry(sb, llm, "france")).toEqual({ keywords: ["fleuriste"], language: "fr" });
    expect(upserts).toHaveLength(1);
    const ctx = upserts[0].ai_context as { agent: string; prompt: string; model: string; rulesHash: string };
    expect(upserts[0].country).toBe("France");
    expect(ctx.agent).toBe("scout");
    expect(ctx.prompt).toContain("France");
    expect(ctx.rulesHash).toBe(WORKER_AGENTS.scout.rulesHash);
    expect(traces).toEqual([{ name: "Scout", session: "France", input: ctx.prompt }]);
  });
});

import { describe, expect, it } from "vitest";
import { readBodyCapped } from "../src/enrich";

// Added 2026-09-04: per-florist progress logging (see workflow.ts) pinned a
// real "Worker exceeded memory limit" crash to flowstore.co.il, a Wix site
// whose homepage alone is 1.15MB of HTML. crawlSite fetches up to
// MAX_PAGES_PER_FLORIST of a site's pages, each re-parsed by Cheerio (whose
// DOM tree costs several times the raw HTML size) — batch size never
// mattered because the cost concentrates in one heavy site, not spread
// across many florists. KEEP IN STEP with ingest/enrich.py's mirror test.
describe("readBodyCapped", () => {
  it("returns the full body when it's under the cap", async () => {
    const resp = new Response("hello world");
    const result = await readBodyCapped(resp, 1_000_000);
    expect(result).toBe("hello world");
  });

  it("truncates a body larger than the cap instead of reading it all", async () => {
    const big = "x".repeat(2_000_000);
    const resp = new Response(big);
    const result = await readBodyCapped(resp, 1_500_000);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThan(big.length);
    expect(result!.length).toBeGreaterThan(0);
  });

  it("returns null for a genuinely empty body", async () => {
    const resp = new Response("");
    const result = await readBodyCapped(resp, 1_500_000);
    expect(result).toBeNull();
  });

  it("does not corrupt a multi-byte UTF-8 character straddling the cap boundary", async () => {
    // A run of 3-byte characters (Hebrew, matching the real failing case's
    // locale) padded so the cap lands mid-character if decoded naively.
    const hebrew = "פרחים ".repeat(300_000);
    const resp = new Response(hebrew);
    const result = await readBodyCapped(resp, 500_000);
    expect(result).not.toBeNull();
    // No U+FFFD replacement character from a chopped multi-byte sequence.
    expect(result).not.toContain("�");
  });

  it("falls back to resp.text() when the runtime gives no readable body stream", async () => {
    const resp = { body: null, text: async () => "fallback text" } as unknown as Response;
    const result = await readBodyCapped(resp, 1_000);
    expect(result).toBe("fallback text");
  });
});

// Browser Rendering warm-pool Durable Object + renderPage() helper.
//
// PROVISION-LATER / OFF BY DEFAULT. The Python pipeline treats "no browser" as
// a valid degraded mode (render_page returns None), and so do we: when
// ENABLE_BROWSER_RENDER !== "true" or the BROWSER binding is absent,
// renderPage() returns null and the static-first pipeline runs unchanged.
//
// This path is NOT exercised by local `wrangler dev` (Browser Rendering is a
// remote-only service on a paid plan) and is therefore unverified until
// provisioned. See docs/superpowers/specs/2026-07-09-phase2-cloudflare-ingest-design.md.
import puppeteer, { type Browser } from "@cloudflare/puppeteer";
import { MAX_CONCURRENT_RENDERS, RENDER_TIMEOUT_MS, RENDER_SETTLE_MS, USER_AGENT } from "./config";
import type { Env } from "./types";

/** Static-first callers use this. Returns rendered HTML, or null on any failure
 * / when rendering is disabled (degraded mode, matches ingest/enrich.py). */
export async function renderPage(env: Env, url: string): Promise<string | null> {
  if (env.ENABLE_BROWSER_RENDER !== "true" || !env.BROWSER) return null;
  try {
    const stub = env.BROWSER_POOL.get(env.BROWSER_POOL.idFromName("singleton"));
    const resp = await stub.fetch("https://browser-pool/render", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
    if (!resp.ok) return null;
    const { html } = (await resp.json()) as { html: string | null };
    return html ?? null;
  } catch {
    return null;
  }
}

export class BrowserPool implements DurableObject {
  private browser: Browser | null = null;
  private inFlight = 0;

  constructor(
    private state: DurableObjectState,
    private env: Env
  ) {}

  private async getBrowser(): Promise<Browser | null> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (!this.env.BROWSER) return null;
    try {
      this.browser = await puppeteer.launch(this.env.BROWSER);
      return this.browser;
    } catch {
      this.browser = null;
      return null;
    }
  }

  async fetch(req: Request): Promise<Response> {
    const { url } = (await req.json()) as { url: string };

    // Bound concurrent renders (shared across all in-flight callers hitting the
    // singleton DO), mirroring MAX_CONCURRENT_RENDERS. Best-effort spin-wait
    // with a cap so a burst degrades to null rather than blocking forever.
    let waited = 0;
    while (this.inFlight >= MAX_CONCURRENT_RENDERS && waited < 30_000) {
      await new Promise((r) => setTimeout(r, 250));
      waited += 250;
    }
    if (this.inFlight >= MAX_CONCURRENT_RENDERS) return Response.json({ html: null });

    this.inFlight += 1;
    try {
      const browser = await this.getBrowser();
      if (!browser) return Response.json({ html: null });
      const page = await browser.newPage();
      try {
        await page.setUserAgent(USER_AGENT);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: RENDER_TIMEOUT_MS });
        await new Promise((r) => setTimeout(r, RENDER_SETTLE_MS));
        const html = await page.content();
        return Response.json({ html });
      } finally {
        await page.close().catch(() => {});
      }
    } catch {
      return Response.json({ html: null });
    } finally {
      this.inFlight -= 1;
    }
  }
}

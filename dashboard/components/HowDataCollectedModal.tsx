"use client";

// Plain-language explanation of where the data comes from and its honest
// limitations — same content as docs/methodology.md's "How data is
// collected" section, kept in sync by hand (POC-simple, no shared-content
// build step).
export default function HowDataCollectedModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-lg bg-surface p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-lg font-semibold text-ink">How data is collected</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-ink-faint hover:bg-surface-2 hover:text-ink-soft"
          >
            &times;
          </button>
        </div>

        <div className="mt-4 space-y-4 text-sm text-ink-soft">
          <section>
            <h3 className="font-medium text-ink">Sources</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-ink-soft">
              <li>
                Listings come from Google Maps, scraped via the Apify actor{" "}
                <code className="rounded bg-surface-2 px-1 py-0.5 text-xs">compass/crawler-google-places</code>.
              </li>
              <li>
                The city center is geocoded once via OpenStreetMap Nominatim, then cached
                on the <code className="rounded bg-surface-2 px-1 py-0.5 text-xs">cities</code> row.
              </li>
              <li>
                Each ingest scrapes florists within a radius (in km) of that center —
                shown in the header as &ldquo;within N km of center&rdquo; — rather than
                a fixed city boundary, so nearby florists just outside city limits are
                included.
              </li>
            </ul>
          </section>

          <section>
            <h3 className="font-medium text-ink">Enrichment</h3>
            <p className="mt-1 text-ink-soft">
              For each florist with a website, we fetch the homepage plus
              <code className="mx-1 rounded bg-surface-2 px-1 py-0.5 text-xs">/contact</code>,
              <code className="mx-1 rounded bg-surface-2 px-1 py-0.5 text-xs">/about</code>,
              <code className="mx-1 rounded bg-surface-2 px-1 py-0.5 text-xs">/team</code>, and
              <code className="mx-1 rounded bg-surface-2 px-1 py-0.5 text-xs">/impressum</code> pages.
              Ecommerce, email, and phone detection run rule-based checks first (platform
              signals like Shopify/WooCommerce, cart links, product schema); when the
              signal is ambiguous, a <code className="rounded bg-surface-2 px-1 py-0.5 text-xs">claude-sonnet-5</code>{" "}
              fallback classifies the ambiguous cases.
            </p>
          </section>

          <section>
            <h3 className="font-medium text-ink">Honest edge cases</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-ink-soft">
              <li>
                Sites that block bots (HTTP 403) or have dead domains are left with null
                enrichment fields — the reason is recorded in that florist&apos;s{" "}
                <code className="rounded bg-surface-2 px-1 py-0.5 text-xs">enrichment_notes</code>
                {" "}rather than guessed.
              </li>
              <li>Google Maps results can vary slightly between scrape runs.</li>
              <li>
                Owner name is often null — it&apos;s only ever filled when the site
                clearly states it, never inferred.
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

import { describe, expect, it } from "vitest";
import {
  REPAIR_FAILURE_PATTERNS,
  UNCHECKED_NOTES_PREFIX,
  buildRepairPatch,
  needsRepair,
  patchAddsEmail,
  repairNotesFilter,
  sharedEmailCounts,
  wantedSharedCount,
  registrableDomain,
  matchNetworkId,
} from "../src/repair";
import type { EnrichmentResult, RepairTarget } from "../src/types";

/** A row in the state the 2026-08-06 outage left behind: crawled fine, every
 * LLM leg 400'd, so the contact fields are null and the notes say why. */
const outageRow: RepairTarget = {
  id: "florist-1",
  place_id: "place-1",
  name: "Pivoine Demo",
  address: "1 Rue des Fleurs",
  lat: 43.5,
  lng: 1.4,
  rating: 4.6,
  review_count: 88,
  phone_maps: "05 61 00 01 01",
  website_url: "http://www.pivoine-demo.fr/",
  category_name: "Florist",
  categories: ["Florist"],
  distance_km_from_center: 3.2,
  email: null,
  phone_web: null,
  owner_name: null,
  shop_highlight: null,
  is_ecommerce: null,
  ecommerce_signals: null,
  enrichment_notes:
    'Crawled 5 page(s) (cap 8). Email: extraction failed (400 {"message":"Your credit balance is too low"}).',
  network_id: null,
  deleted_at: null,
  excluded_at: null,
};

const freshEnrichment: EnrichmentResult = {
  has_website: true,
  is_ecommerce: true,
  ecommerce_signals: { platform: "woocommerce" },
  email: "contact@pivoine-demo.fr",
  phone_web: "05 61 00 01 01",
  owner_name: "Camille",
  shop_highlight: "Bouquets sur mesure",
  content_language: "fr",
  enrichment_notes: "Crawled 5 page(s). Email: 2 candidate(s) → contact@pivoine-demo.fr.",
  enrichment_ai_context: {
    agent: "sherlock",
    rulesHash: "0123456789abcdef",
    calls: [{ name: "email", model: "anthropic/claude-haiku-4.5", prompt: "Pick the primary email..." }],
  },
};

describe("needsRepair", () => {
  it("accepts a row left broken by the outage", () => {
    expect(needsRepair(outageRow)).toBe(true);
  });

  it("accepts each recorded failure shape enrich.ts can write", () => {
    const shapes = [
      "Homepage http://x.fr/ was unreachable (static and headless both failed).",
      "Enrichment exceeded its time budget or raised — skipped for this florist.",
      "Ecommerce: LLM classification failed (500 upstream).",
      "Link-in-bio target https://x.fr was unreachable.",
    ];
    for (const notes of shapes) {
      expect(needsRepair({ ...outageRow, enrichment_notes: notes })).toBe(true);
    }
  });

  it("rejects a clean crawl that correctly found no address", () => {
    // The one purely wasteful case: the model looked and there is genuinely no
    // primary email. Re-asking costs money to re-confirm a null.
    expect(
      needsRepair({
        ...outageRow,
        enrichment_notes:
          "Crawled 8 page(s). Email: 3 candidate(s) → none (no genuine primary email) (confidence 0.91).",
      })
    ).toBe(false);
  });

  it("rejects a row that already has an email", () => {
    expect(needsRepair({ ...outageRow, email: "hello@shop.fr" })).toBe(false);
  });

  it("rejects a row with no website to crawl", () => {
    expect(needsRepair({ ...outageRow, website_url: null })).toBe(false);
  });

  it("rejects soft-deleted and excluded rows", () => {
    expect(needsRepair({ ...outageRow, deleted_at: "2026-08-01T00:00:00Z" })).toBe(false);
    expect(needsRepair({ ...outageRow, excluded_at: "2026-08-01T00:00:00Z" })).toBe(false);
  });

  it("ACCEPTS a row with no notes at all — enrichment never reached it", () => {
    // Bare rows are persisted at step [6/8] and enriched at [7/8]. A run that
    // dies in between leaves NULL notes forever and nothing retries them.
    // Bordeaux's 2026-08-06 run did exactly that: 133 bare rows, failed at
    // [7/8], 85 florists left with a website, no email and no notes. Treating
    // this as "nothing to do" found 2 of them.
    expect(needsRepair({ ...outageRow, enrichment_notes: null })).toBe(true);
    expect(needsRepair({ ...outageRow, enrichment_notes: "" })).toBe(true);
  });

  it("still rejects a never-enriched row that is deleted, excluded or has no site", () => {
    // The NULL-notes case must not bypass the other guards.
    expect(needsRepair({ ...outageRow, enrichment_notes: null, website_url: null })).toBe(false);
    expect(needsRepair({ ...outageRow, enrichment_notes: null, email: "a@b.fr" })).toBe(false);
    expect(needsRepair({ ...outageRow, enrichment_notes: null, deleted_at: "2026-08-01T00:00:00Z" })).toBe(false);
    expect(needsRepair({ ...outageRow, enrichment_notes: null, excluded_at: "2026-08-01T00:00:00Z" })).toBe(false);
  });

  it("matches the failure marker regardless of case", () => {
    expect(needsRepair({ ...outageRow, enrichment_notes: "Extraction FAILED (400)." })).toBe(true);
  });

  it("ACCEPTS a free-layer import row left 'Unchecked' — enrichment never ran, just a non-null placeholder", () => {
    // Girona, 2026-10-13/14: 9 free-place-layer (Overture Maps) shops carry
    // "Unchecked — email, phone and owner unknown until the paid check." in
    // enrichment_notes. That is non-null, so the old `!enrichment_notes`
    // never-reached branch missed it and nothing ever repaired these rows.
    expect(
      needsRepair({ ...outageRow, enrichment_notes: "Unchecked — email, phone and owner unknown until the paid check." })
    ).toBe(true);
    expect(needsRepair({ ...outageRow, enrichment_notes: "UNCHECKED." })).toBe(true);
  });

  it("does not treat a real note that merely mentions 'unchecked' mid-sentence as the free-layer placeholder", () => {
    // The marker is a prefix (the free-layer import always writes it first),
    // not a substring — a real crawl note using the word elsewhere must not
    // be swept in as "never ran".
    expect(
      needsRepair({ ...outageRow, enrichment_notes: "Crawled 3 page(s). Owner info left unchecked by the model." })
    ).toBe(false);
  });
});

describe("repairNotesFilter", () => {
  it("ORs the never-enriched case, the free-layer placeholder and every failure pattern", () => {
    expect(repairNotesFilter()).toBe(
      "enrichment_notes.is.null,enrichment_notes.ilike.unchecked*,enrichment_notes.ilike.*failed*,enrichment_notes.ilike.*unreachable*,enrichment_notes.ilike.*time budget*"
    );
  });

  it("agrees with needsRepair on the never-enriched case", () => {
    // The SQL filter and the in-process re-check must not disagree: a row the
    // query selects but needsRepair rejects is enriched for nothing.
    expect(repairNotesFilter()).toContain("enrichment_notes.is.null");
    expect(needsRepair({ ...outageRow, enrichment_notes: null })).toBe(true);
  });

  it("agrees with needsRepair on the free-layer 'Unchecked' placeholder", () => {
    expect(repairNotesFilter()).toContain(`enrichment_notes.ilike.${UNCHECKED_NOTES_PREFIX}*`);
    expect(needsRepair({ ...outageRow, enrichment_notes: "Unchecked — email, phone and owner unknown until the paid check." })).toBe(true);
  });

  it("is not keyed on any vendor's error text", () => {
    // The whole point: the next outage will not say "Anthropic" or "credit
    // balance", and the same job has to cover it.
    const filter = repairNotesFilter().toLowerCase();
    for (const vendor of ["anthropic", "credit balance", "openrouter", "400"]) {
      expect(filter).not.toContain(vendor);
    }
    expect(REPAIR_FAILURE_PATTERNS).toEqual(["failed", "unreachable", "time budget"]);
  });
});

describe("buildRepairPatch", () => {
  it("fills every field that was null", () => {
    const patch = buildRepairPatch(outageRow, freshEnrichment, "FR");
    expect(patch.email).toBe("contact@pivoine-demo.fr");
    expect(patch.owner_name).toBe("Camille");
    expect(patch.shop_highlight).toBe("Bouquets sur mesure");
    expect(patch.is_ecommerce).toBe(true);
    expect(patch.ecommerce_signals).toEqual({ platform: "woocommerce" });
    expect(patch.enrichment_notes).toBe(freshEnrichment.enrichment_notes);
  });

  it("never overwrites a value that is already set", () => {
    // This is the whole safety property: a staff correction, or an address the
    // florist gave us themselves, must survive a repair.
    const corrected: RepairTarget = {
      ...outageRow,
      email: "owner@pivoine-demo.fr",
      phone_web: "+33999999999",
      owner_name: "Corrected By Staff",
      shop_highlight: "Kept",
      is_ecommerce: false,
      ecommerce_signals: { platform: "shopify" },
    };
    const patch = buildRepairPatch(corrected, freshEnrichment, "FR");
    expect(patch.email).toBeUndefined();
    expect(patch.phone_web).toBeUndefined();
    expect(patch.owner_name).toBeUndefined();
    expect(patch.shop_highlight).toBeUndefined();
    expect(patch.is_ecommerce).toBeUndefined();
    expect(patch.ecommerce_signals).toBeUndefined();
  });

  it("treats is_ecommerce=false as set, not as absent", () => {
    // A falsy-vs-null bug here would silently flip a shop we had judged as not
    // selling online back to true.
    const patch = buildRepairPatch({ ...outageRow, is_ecommerce: false }, freshEnrichment, "FR");
    expect(patch.is_ecommerce).toBeUndefined();
  });

  it("always writes the notes, so stale failure text cannot survive a repair", () => {
    const patch = buildRepairPatch(outageRow, freshEnrichment, "FR");
    expect(patch.enrichment_notes).not.toContain("credit balance");
  });

  it("writes the notes even when nothing else was recovered", () => {
    const nothing: EnrichmentResult = {
      ...freshEnrichment,
      is_ecommerce: null,
      ecommerce_signals: null,
      email: null,
      phone_web: null,
      owner_name: null,
      shop_highlight: null,
      enrichment_notes: "Homepage http://www.pivoine-demo.fr/ was unreachable.",
    };
    const patch = buildRepairPatch(outageRow, nothing, "FR");
    expect(Object.keys(patch)).toEqual(["enrichment_notes", "enrichment_ai_context"]);
  });

  it("normalizes a recovered phone the same way ingest does", () => {
    const patch = buildRepairPatch(outageRow, freshEnrichment, "FR");
    expect(patch.phone_web).toBe("+33 5 61 00 01 01");
  });

  it("keeps an unparseable phone verbatim, like the ingest row builder", () => {
    // normalizePhone's documented contract is never to fabricate or drop data:
    // an unparseable number passes through for a human to look at, rather than
    // silently becoming null.
    const patch = buildRepairPatch(outageRow, { ...freshEnrichment, phone_web: "n/a" }, "FR");
    expect(patch.phone_web).toBe("n/a");
  });

  it("never emits a Maps-sourced column — we did not re-scrape them", () => {
    const patch = buildRepairPatch(outageRow, freshEnrichment, "FR") as unknown as Record<string, unknown>;
    for (const col of [
      "name",
      "address",
      "lat",
      "lng",
      "rating",
      "review_count",
      "phone_maps",
      "category_name",
      "categories",
      "distance_km_from_center",
      "website_url",
      "has_website",
    ]) {
      expect(patch).not.toHaveProperty(col);
    }
  });

  it("never emits a lifecycle or ownership column", () => {
    // Notably deleted_at: buildRow hardcodes it to null, which is exactly why
    // the repair path uses update() instead of upsert(buildRow(...)).
    const patch = buildRepairPatch(outageRow, freshEnrichment, "FR") as unknown as Record<string, unknown>;
    for (const col of [
      "deleted_at",
      "excluded_at",
      "lifecycle_stage",
      "joined_at",
      "trust_tier",
      "locale",
      "drafted_email",
      "city_id",
      "place_id",
      "id",
    ]) {
      expect(patch).not.toHaveProperty(col);
    }
  });
});

describe("what Sherlock was shown", () => {
  it("a repair writes the fresh attempt's context, and clears a stale one when no model ran", () => {
    expect(buildRepairPatch(outageRow, freshEnrichment, "FR").enrichment_ai_context).toEqual(freshEnrichment.enrichment_ai_context);
    expect(buildRepairPatch(outageRow, { ...freshEnrichment, enrichment_ai_context: null }, "FR").enrichment_ai_context).toBeNull();
  });
});

describe("patchAddsEmail", () => {
  it("is true only when an address was actually recovered", () => {
    expect(patchAddsEmail(buildRepairPatch(outageRow, freshEnrichment, "FR"))).toBe(true);
    expect(patchAddsEmail(buildRepairPatch(outageRow, { ...freshEnrichment, email: null }, "FR"))).toBe(
      false
    );
    expect(patchAddsEmail({ enrichment_notes: "x", enrichment_ai_context: null, email: "" })).toBe(false);
  });
});

describe("sharedEmailCounts", () => {
  it("counts how many shops answer at each address", () => {
    const counts = sharedEmailCounts([
      { email: "contact@reseau-demo.fr" },
      { email: "contact@reseau-demo.fr" },
      { email: "solo@shop.fr" },
    ]);
    expect(counts.get("contact@reseau-demo.fr")).toBe(2);
    expect(counts.get("solo@shop.fr")).toBe(1);
  });

  it("folds case and surrounding whitespace", () => {
    const counts = sharedEmailCounts([
      { email: "Contact@Reseau-demo.fr" },
      { email: "  contact@reseau-demo.fr  " },
    ]);
    expect(counts.get("contact@reseau-demo.fr")).toBe(2);
  });

  it("does NOT fold Gmail dots or +tags", () => {
    // Deliberate: for a business address the local part usually means
    // something, and merging two real inboxes silently drops a prospect.
    const counts = sharedEmailCounts([
      { email: "shop@gmail.com" },
      { email: "s.h.o.p@gmail.com" },
      { email: "shop+orders@gmail.com" },
    ]);
    expect(counts.get("shop@gmail.com")).toBe(1);
    expect(counts.size).toBe(3);
  });

  it("ignores rows with no address", () => {
    const counts = sharedEmailCounts([{ email: null }, { email: "" }, { email: "   " }, {}]);
    expect(counts.size).toBe(0);
  });
});

describe("wantedSharedCount", () => {
  it("returns the tallied count for a shared address", () => {
    const counts = sharedEmailCounts([{ email: "a@b.fr" }, { email: "a@b.fr" }]);
    expect(wantedSharedCount("a@b.fr", counts)).toBe(2);
    expect(wantedSharedCount("A@B.fr ", counts)).toBe(2);
  });

  it("treats no address as unshared, not as zero", () => {
    // The column means "how many shops answer here". Zero would read as
    // 'nobody', which emailSkipReason would not flag but also cannot act on.
    const counts = sharedEmailCounts([]);
    expect(wantedSharedCount(null, counts)).toBe(1);
    expect(wantedSharedCount("", counts)).toBe(1);
    expect(wantedSharedCount("unseen@shop.fr", counts)).toBe(1);
  });
});

describe("registrableDomain", () => {
  it("reduces a deep URL to its eTLD+1", () => {
    expect(
      registrableDomain(
        "https://www.reseau-demo.fr/trouvez-votre-fleuriste/saint-fiacre-fleuriste/?utm_source=google_my_business"
      )
    ).toBe("reseau-demo.fr");
    expect(registrableDomain("https://www.artisansfleuristes-demo.com/livraison/31-toulouse-cattleya")).toBe(
      "artisansfleuristes-demo.com"
    );
  });

  it("handles a bare hostname, a port, and a trailing dot", () => {
    expect(registrableDomain("shop.example.fr")).toBe("example.fr");
    expect(registrableDomain("https://example.fr:8443/x")).toBe("example.fr");
    expect(registrableDomain("https://example.fr./")).toBe("example.fr");
  });

  it("keeps three labels for a two-part public suffix", () => {
    // The bug this rule exists for: treating 'com.ar' as the registrable name
    // collapsed every Argentine shop into one 46-shop 'network'.
    expect(registrableDomain("https://shop.blumennetz-demo.co.uk/x")).toBe("blumennetz-demo.co.uk");
    expect(registrableDomain("https://flores-demo.com.ar")).toBe("flores-demo.com.ar");
    expect(registrableDomain("https://tienda.flores-demo.com.ar")).toBe("flores-demo.com.ar");
  });

  it("returns null for anything without a usable host", () => {
    for (const bad of [null, undefined, "", "   ", "localhost", "not a url"]) {
      expect(registrableDomain(bad)).toBeNull();
    }
  });
});

describe("matchNetworkId", () => {
  const registry = new Map([
    ["reseau-demo.fr", "net-reseau-demo"],
    ["artisansfleuristes-demo.com", "net-artisans-demo"],
  ]);

  it("links a shop whose 'website' is its page on a network's site", () => {
    expect(
      matchNetworkId("https://www.reseau-demo.fr/trouvez-votre-fleuriste/saint-fiacre-fleuriste/", registry)
    ).toBe("net-reseau-demo");
  });

  it("does not link an unrelated domain", () => {
    expect(matchNetworkId("https://www.pivoine-demo.fr/", registry)).toBeNull();
    expect(matchNetworkId(null, registry)).toBeNull();
  });

  it("does not match a lookalike domain by substring", () => {
    // 'reseau-demo.fr.evil.com' must not read as Reseau Demo.
    expect(matchNetworkId("https://reseau-demo.fr.evil.com/x", registry)).toBeNull();
    expect(matchNetworkId("https://notreseau-demo.fr/x", registry)).toBeNull();
  });
});

describe("buildRepairPatch — network linking", () => {
  const registry = new Map([["reseau-demo.fr", "net-reseau-demo"]]);

  it("links the network as it writes the address it just scraped from it", () => {
    // The case the dry run caught: enrichment recovers contact@reseau-demo.fr for a
    // Toulouse shop. Writing the address without the flag is how one order's
    // offers end up in one head-office inbox.
    const onNetwork: RepairTarget = {
      ...outageRow,
      website_url: "https://www.reseau-demo.fr/trouvez-votre-fleuriste/saint-fiacre-fleuriste/",
    };
    const patch = buildRepairPatch(
      onNetwork,
      { ...freshEnrichment, email: "contact@reseau-demo.fr" },
      "FR",
      registry
    );
    expect(patch.email).toBe("contact@reseau-demo.fr");
    expect(patch.network_id).toBe("net-reseau-demo");
  });

  it("never re-links a florist a human already assigned to a network", () => {
    const patch = buildRepairPatch(
      { ...outageRow, website_url: "https://www.reseau-demo.fr/x/", network_id: "assigned-by-hand" },
      freshEnrichment,
      "FR",
      registry
    );
    expect(patch.network_id).toBeUndefined();
  });

  it("leaves an ordinary shop unlinked", () => {
    const patch = buildRepairPatch(outageRow, freshEnrichment, "FR", registry);
    expect(patch.network_id).toBeUndefined();
  });

  it("links even when no address was recovered", () => {
    // The flag is about the SITE, not the address — a shop on a network domain
    // is flagged whether or not this crawl found a mailbox.
    const patch = buildRepairPatch(
      { ...outageRow, website_url: "https://www.reseau-demo.fr/x/" },
      { ...freshEnrichment, email: null },
      "FR",
      registry
    );
    expect(patch.email).toBeUndefined();
    expect(patch.network_id).toBe("net-reseau-demo");
  });

  it("does nothing without a registry, so the default stays inert", () => {
    const patch = buildRepairPatch(
      { ...outageRow, website_url: "https://www.reseau-demo.fr/x/" },
      freshEnrichment,
      "FR"
    );
    expect(patch.network_id).toBeUndefined();
  });
});

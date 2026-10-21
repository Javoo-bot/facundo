import { describe, expect, it } from "vitest";
import { categoryMatchesFlorist, hasNonFloristMarker, isRelevanceOutage, looksLikeRealBusiness } from "../src/relevance";

const SPAIN_KEYWORDS = ["florist", "floristeria", "floristería"];

describe("categoryMatchesFlorist", () => {
  it("matches the primary category", () => {
    expect(categoryMatchesFlorist("Florist", ["Florist"], SPAIN_KEYWORDS)).toBe(true);
  });

  it("matches a localized category", () => {
    expect(categoryMatchesFlorist("Floristería", ["Floristería", "Regalos"], SPAIN_KEYWORDS)).toBe(true);
  });

  it("matches when the keyword is only a secondary category", () => {
    expect(categoryMatchesFlorist("Gift shop", ["Gift shop", "Florist"], SPAIN_KEYWORDS)).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(categoryMatchesFlorist("FLORISTERIA", ["FLORISTERIA"], SPAIN_KEYWORDS)).toBe(true);
  });

  it("rejects an unrelated category", () => {
    expect(categoryMatchesFlorist("Supermarket", ["Supermarket", "Grocery store"], SPAIN_KEYWORDS)).toBe(false);
  });

  it("rejects missing category data", () => {
    expect(categoryMatchesFlorist(null, null, SPAIN_KEYWORDS)).toBe(false);
    expect(categoryMatchesFlorist(null, [], SPAIN_KEYWORDS)).toBe(false);
  });
});

// --- Regressions from the 2026-08-06 noise incident ------------------------

describe("non-florist markers revoke the free keyword pass", () => {
  const FR = ["fleuriste", "fleuriste proche de moi", "magasin de fleurs", "boutique de fleurs", "florist"];

  it('does not free-pass a CBD shop on "Magasin de fleurs séchées"', () => {
    // The exact leak: the FR keyword "magasin de fleurs" is a PREFIX of
    // "Magasin de fleurs séchées", the secondary category every CBD shop
    // carries — so 12 cannabis shops were kept with no LLM call at all.
    const cats = ["Magasin de cannabis", "Magasin de cosmétiques", "Magasin de fleurs séchées", "Herboristerie"];
    expect(hasNonFloristMarker("Magasin de cannabis", cats)).toBe(true);
    expect(categoryMatchesFlorist("Magasin de cannabis", cats, FR)).toBe(false);
  });

  it("does not free-pass a wholesaler", () => {
    expect(categoryMatchesFlorist("Fleuriste grossiste", ["Fleuriste grossiste"], FR)).toBe(false);
    expect(categoryMatchesFlorist("Floristería mayorista", ["Floristería mayorista"], ["floristería"])).toBe(false);
  });

  it("still free-passes a genuine florist", () => {
    expect(categoryMatchesFlorist("Fleuriste", ["Fleuriste"], FR)).toBe(true);
    expect(categoryMatchesFlorist("Floristería", ["Floristería", "Tienda de regalos"], ["floristería"])).toBe(true);
  });

  it("a marker only revokes the free pass — it does not decide the outcome", () => {
    // These fall through to the LLM rather than being dropped, because some
    // wholesalers do sell retail and a hard drop is a permanent false negative.
    expect(hasNonFloristMarker("Fleuriste grossiste", null)).toBe(true);
    expect(hasNonFloristMarker("Fleuriste", ["Fleuriste"])).toBe(false);
  });

  it("still returns false for places with no category at all (streets, communes)", () => {
    expect(categoryMatchesFlorist(null, [], FR)).toBe(false);
    expect(categoryMatchesFlorist(null, null, FR)).toBe(false);
  });
});

describe("isRelevanceOutage", () => {
  it("flags a total outage — the 2026-08-06 case", () => {
    // Palma: every relevance call threw on an exhausted account, the run
    // reported success, and 290 unfiltered places were persisted.
    expect(isRelevanceOutage(200, 200)).toBe(true);
    expect(isRelevanceOutage(3, 3)).toBe(true);
  });

  it("flags losing more than half of a meaningful sample", () => {
    expect(isRelevanceOutage(10, 5)).toBe(true);
    expect(isRelevanceOutage(100, 60)).toBe(true);
  });

  it("tolerates isolated failures — one bad call must not fail a city", () => {
    expect(isRelevanceOutage(200, 1)).toBe(false);
    expect(isRelevanceOutage(100, 49)).toBe(false);
    expect(isRelevanceOutage(10, 4)).toBe(false);
  });

  it("does not flag a tiny all-failed sample, or a clean run", () => {
    expect(isRelevanceOutage(2, 2)).toBe(false);   // too small to call systemic
    expect(isRelevanceOutage(0, 0)).toBe(false);   // nothing was ambiguous
    expect(isRelevanceOutage(50, 0)).toBe(false);
  });
});

describe("primary category settles the dried-flowers ambiguity", () => {
  const FR = ["fleuriste", "magasin de fleurs", "florist"];
  const ES = ["floristería", "floristeria"];

  it("keeps the free pass for a real florist that ALSO sells dried flowers", () => {
    // "Exemple Fleurs | Fleuriste" — primary Fleuriste, secondary dried
    // flowers. Marker-only logic would have sent 19 of these to the LLM.
    expect(categoryMatchesFlorist("Fleuriste", ["Fleuriste", "Magasin de fleurs séchées"], FR)).toBe(true);
    expect(categoryMatchesFlorist("Floristería", ["Floristería", "Tienda de flores secas"], ES)).toBe(true);
  });

  it("still refuses the CBD shop, whose PRIMARY is cannabis", () => {
    expect(categoryMatchesFlorist("Magasin de cannabis", ["Magasin de cannabis", "Magasin de fleurs séchées"], FR)).toBe(false);
  });

  it("still refuses a wholesaler, whose primary is both a keyword and a marker", () => {
    expect(categoryMatchesFlorist("Fleuriste grossiste", ["Fleuriste grossiste"], FR)).toBe(false);
    expect(categoryMatchesFlorist("Floristería mayorista", ["Floristería mayorista"], ES)).toBe(false);
  });

  // Real case (2026-09-04, order #2000033): "Pompes Funèbres Exemple" got the
  // free pass and a real order offer sent to it, because "Fleuriste" was one
  // of 8 secondary Maps categories on a business whose PRIMARY is a funeral
  // home. Revokes the free pass (sends to the LLM), same as CBD/wholesale —
  // does not hard-drop, since some funeral homes genuinely also run a florist.
  it("revokes the free pass for a funeral home carrying Fleuriste as a secondary category", () => {
    const categories = [
      "Entreprise de pompes funèbres",
      "Magasin de bougies",
      "Fournisseur d'arômes et de parfums",
      "Fleuriste",
      "Organisation de cérémonie funéraire civile",
    ];
    expect(hasNonFloristMarker("Entreprise de pompes funèbres", categories)).toBe(true);
    expect(categoryMatchesFlorist("Entreprise de pompes funèbres", categories, FR)).toBe(false);
  });
});

// Real case (2026-09-04, order #2000033): "Mesterrieux", "Neuffons", "Loubens"
// etc. — Landerrouet-sur-Ségur candidates named after neighboring communes,
// address "<postcode>, France" (no street), category_name null, categories
// []. classifyRelevance's LLM, given nothing but a bare place name, waved
// every one through as a florist. looksLikeRealBusiness catches these BEFORE
// the LLM call.
describe("looksLikeRealBusiness", () => {
  it("is false for a place with no category at all (the phantom-village case)", () => {
    expect(looksLikeRealBusiness(null, [])).toBe(false);
    expect(looksLikeRealBusiness(null, null)).toBe(false);
    expect(looksLikeRealBusiness("", [])).toBe(false);
  });

  it("is true when there's a primary category", () => {
    expect(looksLikeRealBusiness("Fleuriste", [])).toBe(true);
  });

  it("is true when there's at least one secondary category, even with no primary", () => {
    expect(looksLikeRealBusiness(null, ["Fleuriste"])).toBe(true);
  });

  it("is true for the real La Fleur Exemple case (has a category, just no website)", () => {
    expect(looksLikeRealBusiness("Fleuriste", ["Fleuriste"])).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import { regionToLocale } from "../src/locale";

describe("regionToLocale", () => {
  it("maps supported non-English regions to their locale", () => {
    expect(regionToLocale("ES")).toBe("es");
    expect(regionToLocale("FR")).toBe("fr");
    expect(regionToLocale("IT")).toBe("it");
    expect(regionToLocale("DE")).toBe("de");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(regionToLocale("es")).toBe("es");
    expect(regionToLocale("  de ")).toBe("de");
  });

  it("returns null for English/unmapped/absent regions (florist stays unset → EN)", () => {
    expect(regionToLocale("US")).toBeNull();
    expect(regionToLocale("GB")).toBeNull();
    expect(regionToLocale("XX")).toBeNull();
    expect(regionToLocale(null)).toBeNull();
    expect(regionToLocale("")).toBeNull();
  });

  // Added 2026-09-16 alongside dashboard/lib/i18n/locales.ts and
  // ingest/locales.py — these three maps must stay identical.
  it("covers Austria and the Spanish-speaking Americas", () => {
    expect(regionToLocale("AT")).toBe("de");
    for (const r of ["AR", "BO", "CL", "CO", "CR", "CU", "DO", "EC", "GT", "HN",
                     "MX", "NI", "PA", "PE", "PR", "PY", "SV", "UY", "VE"]) {
      expect(regionToLocale(r)).toBe("es");
    }
  });

  it("maps Andorra to Spanish and Morocco/Tunisia to French (decided 2026-09-16)", () => {
    expect(regionToLocale("AD")).toBe("es");
    expect(regionToLocale("MA")).toBe("fr");
    expect(regionToLocale("TN")).toBe("fr");
  });

  // Guard, not an oversight: a country code cannot decide these, and a wrong
  // guess is worse than EN (CH -> "fr" would send French to Zurich and Basel).
  it("leaves multilingual countries unmapped on purpose", () => {
    expect(regionToLocale("CH")).toBeNull();
    expect(regionToLocale("BE")).toBeNull();
    expect(regionToLocale("LU")).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { countryToRegion, normalizePhone } from "../src/phones";

describe("countryToRegion", () => {
  it("resolves common country names and codes", () => {
    expect(countryToRegion("Spain")).toBe("ES");
    expect(countryToRegion("US")).toBe("US");
    expect(countryToRegion("United States")).toBe("US");
    expect(countryToRegion("UK")).toBe("GB");
    expect(countryToRegion("ES")).toBe("ES");
  });

  it("returns null for null/empty/garbage input", () => {
    expect(countryToRegion(null)).toBeNull();
    expect(countryToRegion("")).toBeNull();
    expect(countryToRegion("   ")).toBeNull();
    expect(countryToRegion("Not A Real Country Xyz")).toBeNull();
  });
});

describe("normalizePhone", () => {
  it("normalizes a valid ES local number with region ES", () => {
    const result = normalizePhone("612 345 678", "ES");
    expect(result).not.toBeNull();
    expect(result!.startsWith("+34")).toBe(true);
  });

  it("normalizes an already-international ES number", () => {
    const result = normalizePhone("+34 612 345 678", null);
    expect(result).not.toBeNull();
    expect(result!.startsWith("+34")).toBe(true);
  });

  it("returns falsy/garbage input unchanged", () => {
    expect(normalizePhone(null, "ES")).toBeNull();
    expect(normalizePhone("", "ES")).toBe("");
    expect(normalizePhone("not a phone number", "ES")).toBe("not a phone number");
  });
});

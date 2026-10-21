import { describe, it, expect } from "vitest";
import { providerOutages, buildReport, EMPTY_COHORT, type ProviderFailureRow, type ActivityStats } from "../src/digestMetrics";
import { buildSubject, buildTextBody, buildHtmlBody, outageSentences } from "../src/digestEmail";

// Error strings exactly as stored in production external_ops, 2026-08-07..09-16.
const ACCOUNT_DOWN = "The request cannot be fulfilled because your account has been deactivated. It may be out of funds.";
const PER_NUMBER = [
  "Invalid destination number",
  "Mobile-only setting is active but the destination is not mobile",
  "The 'to' address should be a single valid number.",
  "Alphanumeric sender ID Facundo is not registered for the destination number +306900000001",
];

const row = (error: string | null, created_at: string, provider = "telnyx"): ProviderFailureRow => ({ provider, error, created_at });

const PERIOD = { fromDay: "2026-09-11", toDay: "2026-09-11", timezone: "Europe/Madrid" };
const ACTIVITY: ActivityStats = { network: EMPTY_COHORT, newShops: EMPTY_COHORT, refusalReasons: [] };

describe("providerOutages", () => {
  it("counts the account-deactivated signature as an outage", () => {
    const out = providerOutages([
      row(ACCOUNT_DOWN, "2026-09-11T09:00:00Z"),
      row(ACCOUNT_DOWN, "2026-09-11T14:45:12Z"),
      row(ACCOUNT_DOWN, "2026-09-11T11:30:00Z"),
    ]);
    expect(out).toEqual([{ provider: "telnyx", channel: "SMS", failures: 3, firstAt: "2026-09-11T09:00:00Z", lastAt: "2026-09-11T14:45:12Z" }]);
  });

  // A single rejected number is about that florist, not about our account.
  it("never treats a per-recipient rejection as an outage", () => {
    expect(providerOutages(PER_NUMBER.map((e) => row(e, "2026-09-11T10:00:00Z")))).toEqual([]);
    expect(providerOutages([row(null, "2026-09-11T10:00:00Z")])).toEqual([]);
  });

  it("only matches the signature for its own provider", () => {
    expect(providerOutages([row(ACCOUNT_DOWN, "2026-09-11T10:00:00Z", "resend")])).toEqual([]);
  });
});

describe("the digest says an outage out loud", () => {
  const outageReport = buildReport({
    period: PERIOD, outcomes: [], activity: ACTIVITY,
    providerFailures: [row(ACCOUNT_DOWN, "2026-09-11T09:00:00Z"), row(ACCOUNT_DOWN, "2026-09-11T14:45:12Z"), row(PER_NUMBER[0], "2026-09-11T10:00:00Z")],
  });
  const normalReport = buildReport({ period: PERIOD, outcomes: [], activity: ACTIVITY });

  it("leads the subject only on a day with an outage", () => {
    expect(buildSubject(outageReport)).toBe("SMS DOWN · Florist app yesterday values");
    expect(buildSubject(normalReport)).toBe("Florist app yesterday values");
  });

  it("states count, time span and the fix, in local time", () => {
    const [sentence] = outageSentences(outageReport);
    expect(sentence).toContain("2 SMS messages failed");
    expect(sentence).toContain("11:00"); // 09:00Z in Madrid
    expect(sentence).toContain("16:45"); // 14:45Z in Madrid
    expect(sentence).toContain("Reactivate or top up the Telnyx account");
  });

  it("appears near the top of both the text and HTML bodies, and nowhere on a normal day", () => {
    const text = buildTextBody(outageReport);
    expect(text).toContain("FIX FIRST: A PROVIDER ACCOUNT IS DOWN");
    expect(text.indexOf("FIX FIRST")).toBeLessThan(400);
    expect(buildHtmlBody(outageReport)).toContain("Fix first: a provider account is down");
    expect(buildTextBody(normalReport)).not.toContain("FIX FIRST");
    expect(buildHtmlBody(normalReport)).not.toContain("provider account is down");
  });
});

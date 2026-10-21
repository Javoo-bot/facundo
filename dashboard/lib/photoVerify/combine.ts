import type { ProviderResult, Verdict, VerificationResult } from "./types";

// Pure consensus logic — no SDKs, no network, so it unit-tests in isolation.
//
// Money-gating philosophy: HOLD unless the providers agree it's clearly good.
// A provider only casts a decisive pass/fail vote when it is confident; a
// low-confidence read, a partial delivery, or any disagreement between providers
// all resolve to `review` (the 30% is held for a human), never a silent release.

// Minimum self-reported confidence for a provider's vote to count as decisive.
export const CONFIDENCE_FLOOR = 0.7;

function vote(r: ProviderResult): Verdict {
  if (r.confidence < CONFIDENCE_FLOOR) return "review"; // unsure → hand to a human
  if (!r.matched) return "fail"; // confidently the wrong arrangement
  if (r.itemsMissing.length > 0) return "review"; // partial order → hold until complete
  return "pass"; // confident, matched, nothing missing
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Fold the per-provider judgments into one verdict + confidence + reasoning.
export function combineVerdicts(results: ProviderResult[]): Omit<VerificationResult, "calls"> {
  const usable = results.filter((r) => r.ok);

  // No provider gave a usable answer (all disabled/errored) → hold, don't guess.
  if (usable.length === 0) {
    return {
      verdict: "review",
      confidence: 0,
      providers: results,
      reasoning: "No AI provider returned a usable verdict — holding the 30% for manual review.",
    };
  }

  const votes = usable.map(vote);
  const avgConfidence = round2(usable.reduce((s, r) => s + r.confidence, 0) / usable.length);

  let verdict: Verdict;
  if (votes.includes("review")) {
    verdict = "review"; // any low-confidence / partial read holds the whole thing
  } else if (votes.every((v) => v === "pass")) {
    verdict = "pass"; // unanimous, confident, complete
  } else if (votes.every((v) => v === "fail")) {
    verdict = "fail"; // unanimous, confident wrong-arrangement
  } else {
    verdict = "review"; // pass vs fail disagreement → hold for a human
  }

  return { verdict, confidence: avgConfidence, providers: results, reasoning: reason(usable, verdict) };
}

function reason(usable: ProviderResult[], verdict: Verdict): string {
  const parts = usable.map((r) => {
    const conf = `${Math.round(r.confidence * 100)}%`;
    const missing = r.itemsMissing.length ? `, missing: ${r.itemsMissing.join(", ")}` : "";
    return `${r.provider} ${r.matched ? "match" : "no-match"} @${conf}${missing}`;
  });
  const head =
    verdict === "pass"
      ? "Providers agree the photo matches the order."
      : verdict === "fail"
        ? "Providers agree the photo does NOT match the order."
        : "Inconclusive (low confidence, partial, or disagreement) — held for CX.";
  return `${head} [${parts.join(" | ")}]`;
}

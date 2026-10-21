// Pure mode decision for lib/waves.ts, factored out to a relative-imports-only
// sibling (waves.ts uses "@/..." aliases throughout, which plain `node --test`
// can't resolve — same pattern as reachoutSend.ts -> offerEmailContent.ts).

/** What the wave engine should do with the leading candidate of an order that
 * needs its next offer: `"send"` it now, `"file"` a pending approval for a
 * human, or `"skip"` (manual — humans drive every send).
 *
 * Deliberately ignores the candidate's lifecycle stage — `auto` sends to a
 * prospect exactly like an onboarded shop; if we ever want an "auto only for
 * onboarded" safety rail, it must be its own explicit setting, not hidden
 * inside this decision. */
export function nextOfferAction(mode: "manual" | "semi" | "auto"): "send" | "file" | "skip" {
  if (mode === "manual") return "skip";
  if (mode === "auto") return "send";
  return "file";
}

// The recruiting funnel as an ordered cascade of shops — the arithmetic only.
//
// Pure and alias-free so `node --test` reaches it directly. Everything the
// /statistics/funnel page decides — which step is the leak, what each gap
// means, whether the numbers can be trusted at all — is computed here and
// asserted in visualFunnel.test.mjs, so the component stays a renderer.
//
// The SHAPE (which steps, in what order) is code, not rows, for the same reason
// lib/sequences/definitions.ts is: the shape is logic, and the cold reach-out
// funnel reuses this file unchanged rather than forking a second definition.

/** Raw counts from `get_visual_funnel_stats`, one shop per unit. Every stage is
 * a subset of the one before it — the SQL builds the predicates that way (see
 * that migration's header, choice 2), so nothing here has to repair a funnel
 * that widens. */
export interface VisualFunnelStats {
  picked: number;
  messaged: number;
  delivered: number;
  seen: number;
  clicked: number;
  joined: number;
  /** Shops we never actually sent to (no address, opted out, cap, no persona). */
  never_messaged: number;
  skipped_only: number;
  bounced: number;
  opted_out: number;
  /** Sent, then complete silence: no provider event, no click. On the Ongage
   * transport (staging) this is every shop — see `trackingBlind` below. */
  no_feedback: number;
  /** Raw email clicks INCLUDING link scanners; `clicked` excludes them. */
  clicked_raw: number;
  /** Shops still mid-sequence, so their funnel is not finished. */
  still_running: number;
}

export type FunnelStepId = "picked" | "messaged" | "delivered" | "seen" | "clicked" | "joined";

export interface FunnelStepDef {
  id: FunnelStepId;
  /** Plain language, for a CX operator who has never read this codebase. */
  label: string;
  /** One line saying exactly what the count means. */
  hint: string;
  /** What it means when a shop is lost BETWEEN the step above and this one.
   * Null on the first step, which has nothing above it. */
  lostMeans: string | null;
}

export const FUNNEL_STEPS: FunnelStepDef[] = [
  {
    id: "picked",
    label: "Shops picked",
    hint: "Shops we started outreach on in this period.",
    lostMeans: null,
  },
  {
    id: "messaged",
    label: "Message sent",
    hint: "We actually got a message out to them.",
    lostMeans: "No email address, already opted out, or the send was skipped.",
  },
  {
    id: "delivered",
    label: "Delivered",
    hint: "It reached them — or something later proved it did.",
    lostMeans: "Bounced, or the provider never confirmed it arrived.",
  },
  {
    id: "seen",
    label: "Opened it",
    hint: "They opened the email, or tapped the link in the text.",
    lostMeans: "It arrived and they never opened it.",
  },
  {
    id: "clicked",
    label: "Clicked the link",
    hint: "A real person clicked — scanner clicks are not counted.",
    lostMeans: "They read it and did not click.",
  },
  {
    id: "joined",
    label: "Signed up",
    hint: "They joined Facundo after we first contacted them.",
    lostMeans: "They clicked through and did not finish signing up.",
  },
];

export interface FunnelRow extends FunnelStepDef {
  /** Shops that reached this step. */
  count: number;
  /** 0..1 of the width to draw. Never wider than the step above, so a funnel
   * always reads as a funnel; `count` is always the true number. */
  width: number;
  /** True when `count` exceeded the step above and the bar was capped to it.
   * Only reachable on "Signed up" (a shop can join without a click we saw),
   * and the UI says so rather than hiding the anomaly. */
  clamped: boolean;
  /** Share of the FIRST step. Null on an empty funnel. */
  shareOfStart: number | null;
  /** Share of the step above — the conversion INTO this step. Null on step 1
   * and whenever the step above is 0. */
  shareOfPrev: number | null;
  /** Shops lost between the step above and this one. Null on step 1. */
  lost: number | null;
}

function share(n: number, d: number): number | null {
  if (d <= 0) return null;
  return n / d;
}

/**
 * The cascade: one row per step, with the loss into each one.
 *
 * `width` is capped to the row above so the drawing is monotone even if the
 * data is not; `count` is never adjusted. Those are different jobs — one is
 * geometry, the other is a fact — and conflating them is how a chart ends up
 * lying to make itself tidy.
 */
export function buildFunnel(stats: VisualFunnelStats): FunnelRow[] {
  const start = stats.picked;
  const rows: FunnelRow[] = [];
  let prevCount: number | null = null;
  let prevWidth = 1;

  for (const def of FUNNEL_STEPS) {
    const count = Math.max(0, stats[def.id]);
    const rawWidth = start > 0 ? count / start : 0;
    const width = Math.min(rawWidth, prevWidth);
    rows.push({
      ...def,
      count,
      width,
      clamped: prevCount !== null && count > prevCount,
      shareOfStart: share(count, start),
      shareOfPrev: prevCount === null ? null : share(count, prevCount),
      lost: prevCount === null ? null : Math.max(0, prevCount - count),
    });
    prevCount = count;
    prevWidth = width;
  }
  return rows;
}

/** End-to-end conversion: shops that signed up, over shops we picked. */
export function overallConversion(stats: VisualFunnelStats): number | null {
  return share(stats.joined, stats.picked);
}

export interface BiggestDrop {
  /** The step shops failed to reach. */
  step: FunnelRow;
  /** How many were lost getting into it. */
  lost: number;
  /** Share of the step above that was lost, 0..1. */
  rate: number | null;
  /** True when the loss is not really measured — see `trackingBlind`. Ranking a
   * blind step as "the leak" would send the team to fix copy when the actual
   * problem is that nothing is reporting opens. */
  unreliable: boolean;
}

/**
 * The one answer the page exists to give: which step is losing shops.
 *
 * Ranked by shops lost, not by rate. "Where are we losing florists" is a
 * question about people — a 90% drop on a step 4 shops reached is a smaller
 * problem than a 60% drop on a step 900 reached, and pointing at the first
 * would be arithmetically true and operationally useless. Ties break toward the
 * worse rate, then toward the earlier step (fix the top of the funnel first).
 */
export function biggestDrop(stats: VisualFunnelStats, rows = buildFunnel(stats)): BiggestDrop | null {
  const blind = trackingBlind(stats);
  let best: BiggestDrop | null = null;
  for (const row of rows) {
    if (row.lost === null || row.lost <= 0) continue;
    const rate = row.shareOfPrev === null ? null : 1 - row.shareOfPrev;
    const candidate: BiggestDrop = {
      step: row,
      lost: row.lost,
      rate,
      // A drop into "Delivered" or "Opened it" is only as real as our delivery
      // feedback: with no webhook, every sent shop looks like it vanished.
      unreliable: blind.blindShops >= row.lost && (row.id === "delivered" || row.id === "seen"),
    };
    if (!best) {
      best = candidate;
      continue;
    }
    if (candidate.lost > best.lost) best = candidate;
    else if (candidate.lost === best.lost && (candidate.rate ?? 0) > (best.rate ?? 0)) best = candidate;
  }
  return best;
}

export interface TrackingBlind {
  /** Shops we sent to and then heard nothing about at all. */
  blindShops: number;
  /** Share of the shops we messaged, 0..1. Null when we messaged none. */
  share: number | null;
  /** True once the blind spot is big enough that the open/click steps below it
   * cannot be read as behaviour. Half is the line: below it the measured shops
   * still carry a usable signal, above it the funnel is mostly guesswork. */
  dominant: boolean;
}

/**
 * How much of the funnel is unmeasured rather than lost.
 *
 * This exists because the two look identical on a chart and mean opposite
 * things. `email_events` is fed by the Resend webhook alone; staging runs
 * Ongage, which reports no delivery, open or click feedback whatsoever
 * (lib/emailTransport.ts). There, every sent shop falls off a cliff at
 * "Delivered" — and a team reading that as a 0% open rate would go and rewrite
 * perfectly good subject lines. Saying "we cannot see" is the honest version,
 * and it is the same rule the rest of /statistics follows: null means unknown,
 * never zero.
 */
export function trackingBlind(stats: VisualFunnelStats): TrackingBlind {
  const s = share(stats.no_feedback, stats.messaged);
  return {
    blindShops: stats.no_feedback,
    share: s,
    dominant: stats.no_feedback > 0 && s !== null && s > 0.5,
  };
}

/**
 * Scanner clicks: the gap between raw email clicks and the ones the funnel
 * believed. Not a failure — the filter working — but a step whose raw clicks
 * are mostly machines is being read by robots, and that is worth seeing.
 */
export function scannerClicks(stats: VisualFunnelStats): { machines: number; share: number | null } {
  const machines = Math.max(0, stats.clicked_raw - stats.clicked);
  return { machines, share: share(machines, stats.clicked_raw) };
}

/**
 * Percentages, formatted for reading rather than for precision.
 *
 * One decimal below 10% because this funnel's interesting numbers live down
 * there — an overall conversion of 0.4% must not round to "0%" on the one page
 * whose job is to show it. Null renders as an em dash: unknown, not zero.
 */
export function formatPct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  const pct = v * 100;
  if (pct > 0 && pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

/** `1,234` — grouped so a four-digit shop count is legible at a glance. */
export function formatCount(n: number): string {
  return n.toLocaleString("en-GB");
}

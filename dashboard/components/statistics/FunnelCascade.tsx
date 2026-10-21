"use client";
import {
  buildFunnel,
  biggestDrop,
  formatCount,
  formatPct,
  type FunnelRow,
  type VisualFunnelStats,
} from "@/lib/visualFunnel";

// The cascade: six steps left to right, and between each pair the one number
// that matters — what share of the step before carried on.
//
// ---- Why the ring
//
// It is the shape of the Klaviyo/Mailchimp campaign funnel the team chose, with
// the decoration taken out and a measurement put in its place. Theirs is a
// stock 3-D torus whose size and thickness encode nothing; here the ring is a
// GAUGE: the filled arc is the share that carried on from the previous step,
// so THE GAP IN THE RING IS THE DROP, at the same scale on every step. The
// fourth ring being two-thirds empty is the finding, visible before a single
// number is read.
//
// ---- Why the conversion sits on the arrow, not on the step
//
// "31%" is a fact about a TRANSITION, not about either step it joins. Printed
// under "Opened it" it silently invites the wrong denominator (31% of what —
// everyone? the ones we mailed?). Printed on the arrow, above the literal
// "of 1,092" it divides by, there is nothing left to guess. That is also the
// distinction PostHog exposes as a toggle between "% of first step" and "% of
// previous step"; we have room to show the second where it happens and the
// first as a quiet subline under the step.
//
// ---- Why one colour
//
// Six steps of one measure is a sequential job, not a categorical one. Every
// ring is the same accent; red is spent once, on the worst transition, because
// that is the answer the page exists to give.

/** Ring geometry. Fixed for every step — the arc carries the number, so a ring
 * that also changed size would encode the same quantity twice at two different
 * accuracies, and the eye would believe the less accurate one. */
const RING_R = 42;
const RING_C = 2 * Math.PI * RING_R;

export default function FunnelCascade({ stats }: { stats: VisualFunnelStats }) {
  const rows = buildFunnel(stats);
  const worst = biggestDrop(stats, rows);

  return (
    <div className="fn-flow">
      {rows.map((row, i) => (
        <FlowPart
          key={row.id}
          row={row}
          prev={i > 0 ? rows[i - 1] : null}
          isWorst={worst?.step.id === row.id && worst.lost > 0}
        />
      ))}
    </div>
  );
}

/** One step, plus the arrow that leads into it. Kept as a single component so a
 * step and its transition can never be rendered out of step with each other. */
function FlowPart({ row, prev, isWorst }: { row: FunnelRow; prev: FunnelRow | null; isWorst: boolean }) {
  return (
    <>
      {prev && <Link row={row} prev={prev} isWorst={isWorst} />}
      <div className="fn-step">
        <Ring row={row} isFirst={prev === null} isWorst={isWorst} />
        <span className="fn-label">{row.label}</span>
        <span className="fn-sub">
          {row.shareOfStart === null || prev === null ? "everyone" : `${formatPct(row.shareOfStart)} of all`}
        </span>
      </div>
    </>
  );
}

function Link({ row, prev, isWorst }: { row: FunnelRow; prev: FunnelRow; isWorst: boolean }) {
  const lost = row.lost ?? 0;

  // Nothing reached the step above, so there is no rate to state and nothing
  // was lost here. Drawing "0% of 0 · none lost" would be three pieces of
  // furniture around a fact that is simply absent.
  if (prev.count === 0) {
    return (
      <div className="fn-link" title={`Nothing reached ${prev.label.toLowerCase()}, so there is nothing to convert here.`}>
        <span className="fn-link-pct" style={{ color: "var(--ink-faint)" }}>&mdash;</span>
        <span className="fn-link-rule" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div
      className={`fn-link${isWorst ? " is-worst" : ""}`}
      // The sentence the arrow is drawing, for a screen reader and for anyone
      // who hovers rather than squints.
      title={`${formatCount(prev.count)} ${prev.label.toLowerCase()} → ${formatCount(row.count)} ${row.label.toLowerCase()} (${formatPct(row.shareOfPrev)}). ${formatCount(lost)} dropped: ${row.lostMeans ?? ""}`}
    >
      <span className="fn-link-pct">{formatPct(row.shareOfPrev)}</span>
      <span className="fn-link-of">of {formatCount(prev.count)}</span>
      <span className="fn-link-rule" aria-hidden="true" />
      <span className="fn-link-drop">
        {lost > 0 ? `${formatCount(lost)} dropped` : "none lost"}
      </span>
    </div>
  );
}

function Ring({ row, isFirst, isWorst }: { row: FunnelRow; isFirst: boolean; isWorst: boolean }) {
  // The first step has nothing above it, so its ring is full: 100% of itself.
  // Every other step's ring is its share of the step above — and when that
  // share is UNKNOWN because nothing reached the step above, the ring is EMPTY,
  // never full. Defaulting a null share to 1 would draw a complete green ring
  // around the number 0, which reads as perfect conversion and is the exact
  // opposite of what happened. Real case, not hypothetical: staging currently
  // has 201 shops messaged and no delivery feedback, so steps 4 to 6 all follow
  // a zero.
  const filled = isFirst ? 1 : row.shareOfPrev ?? 0;
  const offset = RING_C * (1 - Math.min(1, Math.max(0, filled)));
  const lostRate = 1 - Math.min(1, filled);

  // The unfilled arc IS the drop, so the track is tinted red in proportion —
  // with a floor, because a 6% loss tinted at 6% would be invisible and read as
  // "no loss" rather than "a small one", and a floor on the WORST step too, so
  // the ring the page is pointing at is never the faintest one on screen.
  const tint = lostRate <= 0 ? 0 : Math.min(34, Math.max(isWorst ? 30 : 14, Math.round(lostRate * 34)));
  const track = tint === 0 ? "var(--surface-2)" : `color-mix(in srgb, var(--crit) ${tint}%, var(--surface-2))`;

  const value = formatCount(row.count);

  return (
    <div className="fn-ring">
      <svg
        viewBox="0 0 100 100"
        role="img"
        aria-label={
          `${row.label}: ${value} shops` +
          (row.shareOfPrev === null ? "" : `, ${formatPct(row.shareOfPrev)} of the step before`)
        }
      >
        <circle cx="50" cy="50" r={RING_R} fill="none" stroke={track} strokeWidth="9" />
        {filled > 0 && (
          <circle
            cx="50"
            cy="50"
            r={RING_R}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="9"
            strokeLinecap="round"
            strokeDasharray={RING_C}
            strokeDashoffset={offset}
            transform="rotate(-90 50 50)"
          />
        )}
      </svg>
      <span className={`fn-ring-val${value.length > 4 ? " is-long" : ""}`} title={row.hint}>
        {value}
      </span>
    </div>
  );
}

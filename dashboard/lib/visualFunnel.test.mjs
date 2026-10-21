import test from "node:test";
import assert from "node:assert/strict";
import {
  FUNNEL_STEPS,
  buildFunnel,
  overallConversion,
  biggestDrop,
  trackingBlind,
  scannerClicks,
  formatPct,
  formatCount,
} from "./visualFunnel.ts";

/** A healthy-ish cohort with tracking working: the big loss is at "Opened it",
 * which is what the team expects and what the page has to be able to confirm. */
function stats(over = {}) {
  return {
    picked: 1000,
    messaged: 940,
    delivered: 900,
    seen: 280,
    clicked: 120,
    joined: 30,
    never_messaged: 60,
    skipped_only: 55,
    bounced: 40,
    opted_out: 12,
    no_feedback: 0,
    clicked_raw: 190,
    still_running: 210,
    ...over,
  };
}

test("buildFunnel returns one row per step, in funnel order", () => {
  const rows = buildFunnel(stats());
  assert.deepEqual(rows.map((r) => r.id), FUNNEL_STEPS.map((s) => s.id));
  assert.deepEqual(rows.map((r) => r.count), [1000, 940, 900, 280, 120, 30]);
});

test("buildFunnel computes loss into each step and both share bases", () => {
  const rows = buildFunnel(stats());
  assert.equal(rows[0].lost, null, "the first step has nothing above it");
  assert.equal(rows[0].shareOfPrev, null);
  assert.equal(rows[0].shareOfStart, 1);

  const seen = rows[3];
  assert.equal(seen.lost, 620, "900 delivered - 280 opened");
  assert.equal(seen.shareOfPrev, 280 / 900);
  assert.equal(seen.shareOfStart, 280 / 1000);
});

test("buildFunnel widths never widen, even when a count does", () => {
  // A shop can join without a click we ever saw (missed webhook, or staff
  // finished the signup by hand), so `joined` is the one step that can exceed
  // the one above it.
  const rows = buildFunnel(stats({ clicked: 10, joined: 30 }));
  const clicked = rows[4];
  const joined = rows[5];
  assert.equal(joined.count, 30, "the true number is never adjusted");
  assert.equal(joined.clamped, true);
  assert.ok(joined.width <= clicked.width, "the bar is capped to the step above");
  assert.equal(joined.lost, 0, "a negative loss floors at zero rather than going below");
});

test("buildFunnel survives an empty funnel without producing NaN", () => {
  const rows = buildFunnel(stats({ picked: 0, messaged: 0, delivered: 0, seen: 0, clicked: 0, joined: 0 }));
  for (const row of rows) {
    assert.equal(row.count, 0);
    assert.equal(row.width, 0);
    assert.ok(row.shareOfStart === null || Number.isFinite(row.shareOfStart));
    assert.ok(row.shareOfPrev === null || Number.isFinite(row.shareOfPrev));
  }
  assert.equal(overallConversion(stats({ picked: 0, joined: 0 })), null, "unknown, not zero");
});

test("overallConversion is joined over picked", () => {
  assert.equal(overallConversion(stats()), 30 / 1000);
});

test("biggestDrop names the step that lost the most shops", () => {
  const drop = biggestDrop(stats());
  assert.equal(drop.step.id, "seen", "620 lost at 'Opened it' beats every other gap");
  assert.equal(drop.lost, 620);
  assert.equal(drop.unreliable, false);
});

test("biggestDrop ranks by shops lost, not by the worst rate", () => {
  // 'Signed up' loses 100% of a step only 5 shops reached; 'Opened it' loses
  // 62% of 900. The second is the operational problem.
  const drop = biggestDrop(stats({ clicked: 5, joined: 0 }));
  assert.equal(drop.step.id, "seen");
});

test("biggestDrop returns null when nothing was lost anywhere", () => {
  const flat = stats({ messaged: 10, delivered: 10, seen: 10, clicked: 10, joined: 10, picked: 10 });
  assert.equal(biggestDrop(flat), null);
});

test("biggestDrop flags a delivery/open drop that is really a tracking blind spot", () => {
  // Everything we sent went dark: no provider events at all. The cliff at
  // 'Delivered' is missing feedback, not 940 shops refusing our mail.
  const blind = stats({ delivered: 0, seen: 0, clicked: 0, joined: 0, no_feedback: 940 });
  const drop = biggestDrop(blind);
  assert.equal(drop.step.id, "delivered");
  assert.equal(drop.unreliable, true, "must not be reported as the leak to go and fix");
});

test("biggestDrop does not excuse a real drop below the measured steps", () => {
  // Feedback is arriving for everyone, so the loss at 'Clicked the link' is
  // behaviour and is reported as such.
  const drop = biggestDrop(stats({ seen: 900, clicked: 30, joined: 10, no_feedback: 0 }));
  assert.equal(drop.step.id, "clicked");
  assert.equal(drop.unreliable, false);
});

test("trackingBlind measures the unmeasured share of what we sent", () => {
  assert.deepEqual(trackingBlind(stats({ messaged: 940, no_feedback: 0 })), {
    blindShops: 0,
    share: 0,
    dominant: false,
  });

  const ongage = trackingBlind(stats({ messaged: 940, no_feedback: 940 }));
  assert.equal(ongage.blindShops, 940);
  assert.equal(ongage.share, 1);
  assert.equal(ongage.dominant, true, "a transport with no webhook makes the funnel unreadable");

  const partial = trackingBlind(stats({ messaged: 100, no_feedback: 20 }));
  assert.equal(partial.dominant, false, "a fifth missing still leaves a usable signal");
});

test("trackingBlind reports an unknown share rather than zero when nothing was sent", () => {
  assert.equal(trackingBlind(stats({ messaged: 0, no_feedback: 0 })).share, null);
});

test("scannerClicks is the gap between raw clicks and believed clicks", () => {
  const s = scannerClicks(stats());
  assert.equal(s.machines, 70, "190 raw - 120 that passed the scanner filter");
  assert.equal(s.share, 70 / 190);
});

test("scannerClicks floors at zero and reports an unknown share with no raw clicks", () => {
  assert.deepEqual(scannerClicks(stats({ clicked_raw: 0, clicked: 0 })), { machines: 0, share: null });
  // Defensive: SMS short-link hits count as engaged but are never email_events,
  // so `clicked` can legitimately exceed `clicked_raw`.
  assert.equal(scannerClicks(stats({ clicked_raw: 5, clicked: 40 })).machines, 0);
});

test("formatPct keeps a decimal under 10% so a small conversion is not rounded away", () => {
  assert.equal(formatPct(0.004), "0.4%");
  assert.equal(formatPct(0.031), "3.1%");
  assert.equal(formatPct(0.62), "62%");
  assert.equal(formatPct(1), "100%");
});

test("formatPct renders unknown as an em dash, never as zero", () => {
  assert.equal(formatPct(null), "—");
  assert.equal(formatPct(Number.NaN), "—");
  assert.equal(formatPct(0), "0%", "a measured zero is still zero");
});

test("formatCount groups thousands", () => {
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(1234), "1,234");
});

test("every step carries an explanation of the loss into it", () => {
  assert.equal(FUNNEL_STEPS[0].lostMeans, null);
  for (const step of FUNNEL_STEPS.slice(1)) {
    assert.ok(step.lostMeans && step.lostMeans.length > 0, `${step.id} must say what a drop means`);
  }
  for (const step of FUNNEL_STEPS) {
    assert.ok(step.hint && step.hint.length > 0, `${step.id} must say what it counts`);
  }
});

test("a step following an empty one reports an UNKNOWN rate, not a full one", () => {
  // Staging's real shape on 2026-09-02: 201 shops messaged, no delivery
  // feedback at all, so every step below Delivered follows a zero. The renderer
  // draws each ring from shareOfPrev, and a null that it read as "1" would put
  // a complete green ring around the number 0 — perfect conversion, exactly
  // backwards. Null here is the contract that stops that.
  const rows = buildFunnel(
    stats({ picked: 201, messaged: 201, delivered: 0, seen: 0, clicked: 0, joined: 0,
            never_messaged: 0, skipped_only: 0, bounced: 0, opted_out: 0,
            no_feedback: 201, clicked_raw: 0, still_running: 201 })
  );
  const [picked, messaged, delivered, seen] = rows;
  assert.equal(picked.shareOfPrev, null, "the first step has no step above it");
  assert.equal(messaged.shareOfPrev, 1);
  assert.equal(delivered.shareOfPrev, 0, "a measured zero: 0 of 201");
  assert.equal(seen.shareOfPrev, null, "unknown: nothing reached the step above");
  assert.equal(seen.width, 0, "and its bar is empty, not inherited from above");
  assert.equal(delivered.lost, 201);
  assert.equal(seen.lost, 0, "nothing was left to lose");
});

test("staging's blind cohort reads as a reporting gap, not as a verdict", () => {
  const staging = stats({ picked: 201, messaged: 201, delivered: 0, seen: 0, clicked: 0, joined: 0,
                          never_messaged: 0, skipped_only: 0, bounced: 0, opted_out: 0,
                          no_feedback: 201, clicked_raw: 0, still_running: 201 });
  const drop = biggestDrop(staging);
  assert.equal(drop.step.id, "delivered");
  assert.equal(drop.lost, 201);
  assert.equal(drop.unreliable, true);
  assert.equal(trackingBlind(staging).dominant, true);
  assert.equal(overallConversion(staging), 0);
});

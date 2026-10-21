// Wording for the daily automation digest. Pure: no I/O, no clock, no env, so
// every line here is exercised by test/digest.test.ts against fixed inputs.
//
// SHAPE OF THE EMAIL, and why.
//
// The reader gets five seconds, and the question they have is always the same:
// what happened to the orders CX took on? So the card is one funnel, drawn as
// bars, with the drop written between the steps; then, directly underneath,
// why the orders that stopped at Matched never got an offer; then the two shop
// cohorts, side by side.
//
// WHAT WENT, AND WHY (CX review, 2026-08-28, on the 27 Aug send).
//
//   The three-step funnel + the six-dot stage strip. Two blocks telling the
//   same story in two vocabularies. The dots also could not show the DROP,
//   which was the whole story of that day: six of eight orders died between
//   Matched and Offer sent and the strip rendered that as "8" then "2".
//
//   "Staff actions per order: 4.1". A count of our own clicks averaged over
//   orders with nothing in common. Nobody could act on it.
//
//   "Reached by the loop alone" / "Reached only after a person stepped in".
//   The bar colours say this now. The second label was also wrong: it was the
//   furthest any order got by ANY route, person or not.
//
//   "Closed in Shopify, not by the loop" and the "Where they went" block.
//   Dropped at CX's request. The funnel is the account of the orders now.
//
//   The 7-day trailing rate, "Shops offered", and every share with a zero
//   denominator. See digestMetrics.ts::CohortActivity for the modelling error
//   they shared.
//
// NAMES. Stage labels name an event a reader recognises, not a phase of our
// pipeline: Taken on, Matched, Offer sent, Florist accepted, Out for delivery,
// Delivered. See digestStages.ts for why they deliberately differ from the
// order page's stepper today.
//
// HOUSE STYLE: no dash as punctuation in anything a recipient reads, in any
// spelling (see dashboard/lib/i18n/i18n.test.mjs and lib/floristCopy.test.mjs).
// Use a comma, a colon or a full stop. Guarded by "uses no dash punctuation in
// what the recipient reads" in test/digest.test.ts.

import type { CohortActivity, DigestReport, DigestPeriod } from "./digestMetrics";
import { STAGES } from "./digestStages";
import {
  BACKOFFICE_BASE,
  renderBarLegend,
  renderBars,
  renderColumns,
  renderEmailShell,
  renderFactsBlock,
  renderHeadline,
  renderInlineCta,
  renderParagraph,
  renderSectionLabel,
  type BarRow,
  type Column,
  type FactRow,
} from "./emailShell";

/**
 * A share as a whole percent, or null when the denominator is zero.
 *
 * Null rather than 0 is load-bearing. "0% ran without us" and "no orders were
 * taken in at all" are completely different facts, and quiet days are common.
 * Printing 0% would report a failure that did not happen. CLAUDE.md's rule
 * against fabricating a value applies to derived numbers too.
 *
 * Nothing in the email prints the null case any more: every call site below
 * either has a non-zero denominator by construction, or renders words instead
 * of a chart (see `cohortColumn`). That is deliberate. CX's rule after the 27
 * Aug review is that a reader must never meet a "?" or an "n/a": where a count
 * is genuinely nothing, the mail says 0, and where a SHARE has nothing to
 * divide by, the mail does not show a share at all.
 */
export function share(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 100);
}

/** A share for humans: `50%`, or `n/a` when there was nothing to divide by. */
export function formatShare(value: number | null): string {
  return value === null ? "n/a" : `${value}%`;
}

/** `2026-08-20` -> `Thu 20 Aug`. Pinned to UTC so it cannot drift a day. */
function shortDay(dayIso: string): string {
  const [y, m, d] = dayIso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC", weekday: "short", day: "numeric", month: "short",
  }).format(new Date(Date.UTC(y, m - 1, d))).replace(",", "");
}

/** How many calendar days the period covers. */
export function periodDays(period: DigestPeriod): number {
  const [fy, fm, fd] = period.fromDay.split("-").map(Number);
  const [ty, tm, td] = period.toDay.split("-").map(Number);
  const ms = Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd);
  return Math.round(ms / 86_400_000) + 1;
}

/**
 * How the period reads in the subject and the headline.
 *
 * A single day is "Thu 20 Aug". A Monday run covers three days and reads
 * "Fri 7 Aug to Sun 9 Aug", so nobody mistakes the weekend catch-up for a
 * one-day figure and wonders why the numbers tripled.
 */
export function formatPeriod(period: DigestPeriod): string {
  if (period.fromDay === period.toDay) return shortDay(period.fromDay);
  return `${shortDay(period.fromDay)} to ${shortDay(period.toDay)}`;
}

/** `1 order` / `8 orders`. */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * The line under the headline.
 *
 * On a Monday it has one job: say out loud that this is three days, not one.
 * The counts triple on that email and the reader has to know that before they
 * read a single number. Naming the three days is enough to do it; the sentence
 * that used to follow, explaining that nothing is sent at the weekend, was
 * telling a daily reader something they already know (CX, 2026-08-31).
 *
 * On an ordinary day it carries the two numbers the funnel below builds to, so
 * somebody who reads nothing else still has them.
 */
export function buildSubheading(r: DigestReport): string {
  const days = periodDays(r.period);
  if (days > 1) {
    return `${days} days together: Friday, Saturday and Sunday.`;
  }
  if (r.takenIn === 0) return "No orders were taken on in this period.";
  const delivered = r.delivered === 0 ? "none delivered yet" : `${r.delivered} delivered`;
  return `CX took on ${plural(r.takenIn, "order")}. A florist accepted ${r.accepted}, ${delivered}.`;
}

/**
 * The subject line. Deliberately minimal and fixed.
 *
 * It carried the funnel counts at one point ("6 taken on, 0 automatic, ..."),
 * which scanned well but made every day's subject different and noisy. Two
 * fixed strings instead, so the only thing the subject has to tell you is
 * WHICH period this is: the weekend catch-up, or an ordinary yesterday.
 *
 * The exact dates are not lost, they move one line down into the headline and
 * subheading, where there is room for them.
 */
export function buildSubject(r: DigestReport): string {
  const base = periodDays(r.period) > 1 ? "Florist app weekend values" : "Florist app yesterday values";
  // An outage leads the subject: it is the one thing in here that is not a
  // number to read later but something to fix today. Absent on a normal day,
  // so the ordinary subject is byte-for-byte unchanged.
  const down = outageChannels(r);
  return down ? `${down} DOWN · ${base}` : base;
}

function outageChannels(r: DigestReport): string | null {
  const outages = r.providerOutages ?? [];
  return outages.length ? [...new Set(outages.map((o) => o.channel))].join(" + ") : null;
}

/** "62 SMS failed because the Telnyx account was deactivated, …". One line
 * per provider, in plain words, with the fix. */
export function outageSentences(r: DigestReport): string[] {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: r.period.timezone, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
  return (r.providerOutages ?? []).map((o) => {
    const name = o.provider.charAt(0).toUpperCase() + o.provider.slice(1);
    const span = o.firstAt === o.lastAt ? `at ${fmt.format(new Date(o.firstAt))}` : `between ${fmt.format(new Date(o.firstAt))} and ${fmt.format(new Date(o.lastAt))}`;
    return `${o.failures} ${o.channel} ${o.failures === 1 ? "message" : "messages"} failed ${span} because the ${name} account was deactivated (it may be out of funds). They were not delivered. Reactivate or top up the ${name} account.`;
  });
}

/** Short, factual, no judgement. The period, not a verdict. */
export function buildHeadline(r: DigestReport): string {
  return formatPeriod(r.period);
}

/** The hidden inbox-preview line: the funnel in one sentence. */
export function buildPreheader(r: DigestReport): string {
  if (r.takenIn === 0) return "No orders were taken on in this period.";
  const stalled = r.noOffer.total > 0 ? ` ${r.noOffer.total} never got an offer sent.` : "";
  return `${r.takenIn} taken on.${stalled} ${r.accepted} accepted, ${r.delivered} delivered.`;
}

/**
 * What the reader is told about the orders that fell out between one stage and
 * the next.
 *
 * The rule, and it is the whole reason these are not one generic string: name
 * the step they did NOT reach, never the step they are sitting on. "6 did not
 * reach Offer sent" says what is missing; "6 stopped at Matched" makes the
 * reader work out what should have come next.
 */
function dropNote(fromIndex: number, n: number): string {
  const were = n === 1 ? "was" : "were";
  switch (STAGES[fromIndex].id) {
    case "created":
      return `${n} never got matched to a florist`;
    case "matched":
      return `${n} did not reach Offer sent`;
    case "outreach":
      return `${n} ${were} offered and no florist took it`;
    case "fulfilment":
      return `${n} accepted, not out for delivery yet`;
    default:
      return `${n} out for delivery, not delivered yet`;
  }
}

/**
 * The funnel: one bar per stage, coloured by who got the orders there.
 *
 * Green is how many reached that stage with NO staff involvement, amber is the
 * rest of the ones that reached it. The gap between the colours IS the manual
 * work, per stage, which is what the two deleted "reached by" rows used to say
 * in words for the furthest stage only.
 */
export function funnelBars(r: DigestReport): BarRow[] {
  const a = r.automation;
  const pct = (n: number) => (r.takenIn > 0 ? Math.round((n / r.takenIn) * 100) : 0);

  return STAGES.map((stage, i) => {
    const through = a.passedThrough[i] ?? 0;
    // Clamped: `passedThroughAlone` can never legitimately exceed
    // `passedThrough`, and if a future change makes it so, a bar wider than its
    // track is a silent lie rather than a crash.
    const alone = Math.min(a.passedThroughAlone[i] ?? 0, through);
    const next = a.passedThrough[i + 1];
    const dropped = next === undefined ? 0 : through - next;
    return {
      label: stage.label,
      count: String(through),
      // The first bar is the denominator, so "100%" beside it says nothing.
      share: i === 0 ? undefined : `(${pct(through)}%)`,
      alonePct: pct(alone),
      helpedPct: pct(through - alone),
      drop: dropped > 0 ? dropNote(i, dropped) : undefined,
    };
  });
}

/**
 * Why the orders that stopped at Matched never had an offer sent.
 *
 * All three lines are printed, zeros included, because they add up to the drop
 * line in the funnel directly above and a reader has to be able to check that.
 * A zero here is a real answer, not a gap.
 */
export function noOfferRows(r: DigestReport): FactRow[] {
  return [
    {
      label: "Only new shops nearby, so a person has to send it",
      value: String(r.noOffer.newShopsOnly),
      emphasis: false,
    },
    { label: "Network shops nearby, offer not sent yet", value: String(r.noOffer.notSentYet) },
    { label: "Waiting for a person for another reason", value: String(r.noOffer.other) },
  ];
}

/**
 * One cohort's column: a small funnel over the offers sent in the period.
 *
 * Every number is a share of the SAME set of offers, the ones at the top of
 * that column, so nothing here can print more than 100%. A cohort that got no
 * offers at all gets a sentence rather than three empty bars, which read as a
 * broken image rather than as a quiet day.
 */
function cohortColumn(
  heading: string,
  note: string,
  tone: "green" | "amber",
  c: CohortActivity,
  days: number,
): Column {
  if (c.offersSent === 0) {
    return { heading, note, tone, lines: [days > 1 ? "No offers went out." : "No offers went out yesterday."] };
  }
  const pct = (n: number) => Math.round((n / c.offersSent) * 100);
  return {
    heading,
    note,
    tone,
    bars: [
      // Same rule as the funnel: the top of a funnel is its own denominator,
      // so "100%" next to it is noise the reader has to look past.
      { label: "Offers sent", count: String(c.offersSent), pct: 100 },
      { label: "Answered", count: String(c.answered), share: `(${pct(c.answered)}%)`, pct: pct(c.answered) },
      { label: "Accepted", count: String(c.accepted), share: `(${pct(c.accepted)}%)`, pct: pct(c.accepted) },
      // Not a funnel step — a diagnosis. A high number here points at the
      // response window rather than at the florists, and that is the one
      // failure in this table that looks identical to indifference.
      { label: "Ran out of time", count: String(c.timedOut), share: `(${pct(c.timedOut)}%)`, pct: pct(c.timedOut) },
    ],
  };
}

export function offerColumns(r: DigestReport): [Column, Column] {
  const days = periodDays(r.period);
  return [
    cohortColumn(
      "Network shops",
      "Already signed up. The app may offer these on its own.",
      "green",
      r.activity.network,
      days,
    ),
    cohortColumn(
      "New shops",
      "First contact. These only go out when a person sends them.",
      "amber",
      r.activity.newShops,
      days,
    ),
  ];
}

/** The heading over the two cohort columns, period aware. */
function offersLabel(r: DigestReport): string {
  return periodDays(r.period) > 1 ? "Offers we sent" : "Offers we sent yesterday";
}

/** The heading over the funnel, which names its own denominator. */
function funnelLabel(r: DigestReport): string {
  return `What happened to the ${plural(r.takenIn, "order")}`;
}

export function buildTextBody(r: DigestReport): string {
  const pad = (label: string) => label.padEnd(52);
  const lines: string[] = [
    `Facundo automation funnel, ${formatPeriod(r.period)} (${r.period.timezone})`,
    buildSubheading(r),
  ];

  const outages = outageSentences(r);
  if (outages.length) {
    lines.push("", "FIX FIRST: A PROVIDER ACCOUNT IS DOWN");
    for (const sentence of outages) lines.push(`  ${sentence}`);
  }

  if (r.takenIn > 0) {
    lines.push("", funnelLabel(r).toUpperCase());
    for (const bar of funnelBars(r)) {
      lines.push(`  ${pad(bar.label)} ${bar.count}${bar.share ? ` ${bar.share}` : ""}`);
      // The colours do not survive plain text, so the drop lines carry the
      // whole shape of the funnel here. Indented under the bar they follow.
      if (bar.drop) lines.push(`      ${bar.drop}`);
    }
    lines.push("", "  Green in the HTML version means the app acted on its own, amber means a person had to step in.");
  }

  if (r.noOffer.total > 0) {
    lines.push("", `WHY THOSE ${r.noOffer.total} NEVER GOT AN OFFER`);
    for (const row of noOfferRows(r)) lines.push(`  ${pad(row.label)} ${row.value}`);
  }

  for (const column of offerColumns(r)) {
    lines.push("", `${offersLabel(r).toUpperCase()}: ${column.heading.toUpperCase()}`);
    for (const line of column.lines ?? []) lines.push(`  ${line}`);
    for (const bar of column.bars ?? []) {
      lines.push(`  ${pad(bar.label)} ${bar.count}${bar.share ? ` ${bar.share}` : ""}`);
    }
  }

  if (r.activity.refusalReasons.length > 0) {
    lines.push("", "WHY THEY REFUSED");
    for (const reason of r.activity.refusalReasons) {
      lines.push(`  ${pad(reason.reason)} ${reason.count}`);
    }
  }

  if (r.escalationReasons.length > 0) {
    lines.push("", "WHY THEY NEED A PERSON");
    for (const reason of r.escalationReasons) {
      lines.push(`  ${pad(reason.reason)} ${reason.count}`);
    }
  }

  return lines.join("\n");
}

export function buildHtmlBody(r: DigestReport): string {
  const [network, newShops] = offerColumns(r);

  let content = renderHeadline(buildHeadline(r)) + renderParagraph(buildSubheading(r));

  const outages = outageSentences(r);
  if (outages.length) {
    content += renderSectionLabel("Fix first: a provider account is down") + outages.map(renderParagraph).join("");
  }

  if (r.takenIn > 0) {
    content +=
      renderSectionLabel(funnelLabel(r)) + renderBars(funnelBars(r)) + renderBarLegend();
  }

  if (r.noOffer.total > 0) {
    content +=
      renderSectionLabel(`Why those ${r.noOffer.total} never got an offer`) +
      renderFactsBlock(noOfferRows(r)) +
      // Straight to the list, filtered to the stage they are stuck at. No
      // count in the label: this opens every order sitting at Matched, which
      // on most days is more than today's.
      renderInlineCta("Open the orders sitting at Matched", `${BACKOFFICE_BASE}/orders?status=matched`);
  }

  content += renderSectionLabel(offersLabel(r)) + renderColumns(network, newShops);

  if (r.activity.refusalReasons.length > 0) {
    content +=
      renderSectionLabel("Why they refused") +
      renderFactsBlock(r.activity.refusalReasons.map((e) => ({ label: e.reason, value: String(e.count) })));
  }

  if (r.escalationReasons.length > 0) {
    content +=
      renderSectionLabel("Why they need a person") +
      renderFactsBlock(r.escalationReasons.map((e) => ({ label: e.reason, value: String(e.count) })));
  }

  return renderEmailShell(content, {
    preheader: buildPreheader(r),
    cta: { label: "Open statistics", url: `${BACKOFFICE_BASE}/statistics` },
  });
}

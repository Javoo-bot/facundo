import { describe, it, expect } from "vitest";
import {
  buildReport,
  escalationReason,
  localHour,
  reportingPeriod,
  addDays,
  EMPTY_COHORT,
  type ActivityStats,
  type DigestPeriod,
  type OrderOutcome,
} from "../src/digestMetrics";
import { tally, type AssignmentRow } from "../src/dailyDigest";
import { STAGES, furthest, passedThrough, stageFromEvidence } from "../src/digestStages";
import {
  share,
  formatShare,
  formatPeriod,
  buildSubject,
  buildHeadline,
  buildPreheader,
  buildTextBody,
  buildHtmlBody,
  buildSubheading,
  periodDays,
  funnelBars,
  noOfferRows,
} from "../src/digestEmail";
import { DEFAULT_RECIPIENTS, noOfferReason, parseReplayPeriod } from "../src/dailyDigest";

const DAY: DigestPeriod = { fromDay: "2026-08-20", toDay: "2026-08-20", timezone: "Europe/Madrid" };
const WEEKEND: DigestPeriod = { fromDay: "2026-08-14", toDay: "2026-08-16", timezone: "Europe/Madrid" };

/** An order that entered the working set. Defaults to the happy path. */
const outcome = (over: Partial<OrderOutcome> = {}): OrderOutcome => ({
  orderId: Math.random().toString(36).slice(2),
  status: "delivered",
  staffTouched: false,
  reached: "delivered",
  reachedAlone: "delivered",
  staffActions: 0,
  noOfferReason: null,
  deliveredAt: "2026-08-20T10:00:00Z",
  dueAt: "2026-08-20T00:00:00Z",
  candidates: 1,
  expired: 0,
  declined: 0,
  ...over,
});

/** An order CX put on the worklist that then received nothing at all. */
const stalled = (over: Partial<OrderOutcome> = {}): OrderOutcome =>
  outcome({
    status: "closed", reached: "created", reachedAlone: "created",
    deliveredAt: null, candidates: 0, ...over,
  });

const NO_ACTIVITY: ActivityStats = {
  network: { ...EMPTY_COHORT },
  newShops: { ...EMPTY_COHORT },
  refusalReasons: [],
};

const report = (
  outcomes: OrderOutcome[],
  period = DAY,
  activity: ActivityStats = NO_ACTIVITY,
) => buildReport({ period, outcomes, activity });

/** The real production shape for the 14 days to 2026-08-20, as verified by SQL. */
const REAL = report(
  [
    ...Array.from({ length: 18 }, () => outcome({ status: "closed", staffTouched: true, staffActions: 12, reached: "outreach", reachedAlone: "matched", deliveredAt: null })),
    ...Array.from({ length: 11 }, () => stalled()),
    // reachedAlone is "matched" on every one of these because that is the truth
    // in production: no order has ever passed Matched unattended.
    outcome({ status: "delivered", reachedAlone: "matched", staffActions: 25, deliveredAt: "2026-08-19T10:00:00Z", dueAt: "2026-08-19T00:00:00Z" }),
    outcome({ status: "delivered", reachedAlone: "matched", staffActions: 22, deliveredAt: "2026-08-14T10:00:00Z", dueAt: "2026-08-14T00:00:00Z" }),
    outcome({ status: "delivered", staffTouched: true, reachedAlone: "matched", staffActions: 30, deliveredAt: "2026-08-19T10:00:00Z", dueAt: "2026-08-18T00:00:00Z" }),
    ...Array.from({ length: 6 }, () => outcome({ status: "reaching_out", reached: "outreach", reachedAlone: "matched", deliveredAt: null })),
  ],
);

describe("share", () => {
  it("returns null rather than 0 when nothing was taken in", () => {
    // "0% ran without us" and "we took nothing on" are different facts.
    expect(share(0, 0)).toBeNull();
    expect(share(0, 5)).toBe(0);
    expect(share(19, 38)).toBe(50);
  });

  it("prints n/a for an unknown share, never 0%", () => {
    expect(formatShare(null)).toBe("n/a");
    expect(formatShare(0)).toBe("0%");
  });
});

describe("reportingPeriod", () => {
  // 2026-08-17 is a Monday; the 15th and 16th are Sat/Sun.
  const at = (iso: string) => new Date(iso);

  it("does not send on Saturday or Sunday", () => {
    expect(reportingPeriod(at("2026-08-15T09:00:00Z"), "Europe/Madrid")).toBeNull();
    expect(reportingPeriod(at("2026-08-16T09:00:00Z"), "Europe/Madrid")).toBeNull();
  });

  it("covers Friday, Saturday and Sunday on a Monday", () => {
    // Without this, two days of the funnel would never be reported at all.
    const period = reportingPeriod(at("2026-08-17T06:00:00Z"), "Europe/Madrid");
    expect(period).toEqual({ fromDay: "2026-08-14", toDay: "2026-08-16", timezone: "Europe/Madrid" });
  });

  it("covers yesterday from Tuesday to Friday", () => {
    for (const [day, expected] of [
      ["2026-08-18", "2026-08-17"], // Tue
      ["2026-08-19", "2026-08-18"], // Wed
      ["2026-08-20", "2026-08-19"], // Thu
      ["2026-08-21", "2026-08-20"], // Fri
    ]) {
      const period = reportingPeriod(at(`${day}T06:00:00Z`), "Europe/Madrid");
      expect(period).toEqual({ fromDay: expected, toDay: expected, timezone: "Europe/Madrid" });
    }
  });

  it("uses the Madrid date, not the UTC one, to pick the period", () => {
    // 22:30 UTC on Sunday the 16th is already 00:30 Monday in Madrid, so this
    // must produce Monday's Friday-to-Sunday period, not "no send".
    const period = reportingPeriod(at("2026-08-16T22:30:00Z"), "Europe/Madrid");
    expect(period).toEqual({ fromDay: "2026-08-14", toDay: "2026-08-16", timezone: "Europe/Madrid" });
  });
});

describe("localHour", () => {
  it("reads the Madrid hour across both DST offsets", () => {
    // Summer (UTC+2): 06:00 UTC is 08:00 local, the send hour.
    expect(localHour(new Date("2026-08-21T06:00:00Z"), "Europe/Madrid")).toBe(8);
    expect(localHour(new Date("2026-08-21T05:59:00Z"), "Europe/Madrid")).toBe(7);
    // Winter (UTC+1): the same 06:00 UTC is only 07:00 local. This is the case
    // a fixed 06:00-UTC Cloudflare cron would get wrong for half the year.
    expect(localHour(new Date("2026-01-15T06:00:00Z"), "Europe/Madrid")).toBe(7);
    expect(localHour(new Date("2026-01-15T07:00:00Z"), "Europe/Madrid")).toBe(8);
  });
});

describe("buildReport", () => {
  it("counts the ideal run as 5 in, 5 accepted, 5 delivered by the loop alone", () => {
    const r = report(Array.from({ length: 5 }, () => outcome()));
    expect(r.takenIn).toBe(5);
    expect(r.accepted).toBe(5);
    expect(r.delivered).toBe(5);
    expect(r.onTime).toBe(5);
    expect(r.automation.alone.stage).toBe("delivered");
    expect(r.automation.neverMoved).toBe(0);
    // Every stage was reached by the app alone, so the bars are wholly green.
    expect(r.automation.passedThroughAlone).toEqual(r.automation.passedThrough);
  });

  // THE REGRESSION THIS METRIC EXISTS FOR. The old `!staffTouched` test scored
  // an untouched, unmoved order as automation, which on 11 Aug 2026 published
  // 67% for a day whose four "successes" had no events at all.
  it("does not credit an order that nobody touched because nothing happened", () => {
    const r = report(Array.from({ length: 4 }, () => stalled()));
    expect(r.takenIn).toBe(4);
    expect(r.automation.alone.stage).toBe("created");
    expect(r.automation.movedAlone).toBe(0);
    expect(r.automation.neverMoved).toBe(4);
  });

  it("separates what the loop did alone from what it did after we stepped in", () => {
    const r = report([
      outcome({ reached: "fulfilment", reachedAlone: "matched", staffActions: 6, status: "accepted", deliveredAt: null }),
    ]);
    expect(r.automation.alone.stage).toBe("matched");
    expect(r.automation.reached.stage).toBe("fulfilment");
    // The two arrays ARE the two colours of one bar: the app got this order to
    // Matched by itself, a person carried it the rest of the way.
    expect(r.automation.passedThrough).toEqual([1, 1, 1, 1, 0, 0]);
    expect(r.automation.passedThroughAlone).toEqual([1, 1, 0, 0, 0, 0]);
  });

  it("never claims the app reached further alone than the orders got at all", () => {
    // A bar drawn wider than its own track would be a silent lie about who did
    // the work, so the invariant is asserted rather than left to the renderer.
    const r = report([
      outcome({ reached: "outreach", reachedAlone: "matched", deliveredAt: null, status: "reaching_out" }),
      stalled(),
    ]);
    r.automation.passedThroughAlone.forEach((alone, i) => {
      expect(alone).toBeLessThanOrEqual(r.automation.passedThrough[i]);
    });
  });

  it("qualifies the furthest stage with its count, so one order cannot carry a bad day", () => {
    // The real 11 Aug 2026 shape: one delivered, four that never moved.
    const r = report([
      outcome({ reached: "delivered", reachedAlone: "matched", staffActions: 25 }),
      ...Array.from({ length: 4 }, () => stalled()),
    ]);
    expect(r.automation.reached).toEqual({ stage: "delivered", count: 1 });
    expect(r.automation.neverMoved).toBe(4);
    // The stage names moved out of a facts row and into the funnel's drop
    // lines, which say the same thing where the reader is already looking.
    expect(buildTextBody(r)).toContain("4 never got matched to a florist");
  });

  it("counts an accept as reaching Fulfilment even when it went no further", () => {
    const r = report([outcome({ status: "accepted", reached: "fulfilment", reachedAlone: "created", deliveredAt: null })]);
    expect(r.accepted).toBe(1);
    expect(r.delivered).toBe(0);
  });

  it("splits delivered orders into on time and late", () => {
    const r = report([
      outcome({ deliveredAt: "2026-08-20T10:00:00Z", dueAt: "2026-08-20T00:00:00Z" }),
      outcome({ deliveredAt: "2026-08-21T10:00:00Z", dueAt: "2026-08-20T00:00:00Z" }),
    ]);
    expect(r.onTime).toBe(1);
    expect(r.late).toBe(1);
  });

  it("reports unknown timing rather than assuming on time", () => {
    // order_assignments.delivered_at is null on most delivered legs in
    // production. Guessing here would silently inflate the on-time rate.
    const r = report([outcome({ deliveredAt: null }), outcome({ dueAt: null })]);
    expect(r.delivered).toBe(2);
    expect(r.timingUnknown).toBe(2);
    expect(r.onTime).toBe(0);
    expect(r.late).toBe(0);
  });

  it("puts every order taken in into exactly one outcome bucket", () => {
    const r = report([
      outcome({ status: "delivered" }),
      outcome({ status: "escalated", candidates: 0, deliveredAt: null }),
      outcome({ status: "cancelled", deliveredAt: null }),
      outcome({ status: "closed", deliveredAt: null }),
      outcome({ status: "reaching_out", deliveredAt: null }),
    ]);
    // The buckets must sum to takenIn, or the funnel above them is not trustworthy.
    expect(r.delivered + r.escalated + r.cancelled + r.closedUpstream + r.inProgress).toBe(r.takenIn);
    expect(r.delivered).toBe(1);
    expect(r.escalated).toBe(1);
    expect(r.cancelled).toBe(1);
    expect(r.closedUpstream).toBe(1);
    expect(r.inProgress).toBe(1);
  });

  it("groups escalations by derived reason, commonest first", () => {
    const r = report([
      outcome({ status: "escalated", candidates: 0, deliveredAt: null }),
      outcome({ status: "escalated", candidates: 0, deliveredAt: null }),
      outcome({ status: "escalated", candidates: 3, expired: 3, deliveredAt: null }),
    ]);
    expect(r.escalationReasons).toEqual([
      { reason: "No florist found nearby", count: 2 },
      { reason: "No florist answered", count: 1 },
    ]);
  });
});

describe("escalationReason", () => {
  it("derives the reason from the offers, because none is stored", () => {
    // Only 3 `escalated` events exist in the whole database and 2 are demo
    // rows, while 26 orders sit at that status with no event at all. The
    // reason has to come from real offer state or not be shown.
    expect(escalationReason(outcome({ candidates: 0 }))).toBe("No florist found nearby");
    expect(escalationReason(outcome({ candidates: 3, expired: 3 }))).toBe("No florist answered");
    expect(escalationReason(outcome({ candidates: 2, declined: 2 }))).toBe("Every florist declined");
    expect(escalationReason(outcome({ candidates: 3, expired: 1, declined: 1 }))).toBe("Stalled part-way");
  });
});

describe("rendering", () => {
  it("uses a minimal fixed subject that names the period", () => {
    expect(buildSubject(REAL)).toBe("Florist app yesterday values");
    expect(buildSubject(report([outcome()], WEEKEND))).toBe("Florist app weekend values");
  });

  it("keeps the exact dates in the body, since the subject no longer carries them", () => {
    expect(buildHeadline(REAL)).toBe("Thu 20 Aug");
    expect(buildTextBody(REAL)).toContain("Thu 20 Aug");
    expect(buildHtmlBody(report([outcome()], WEEKEND))).toContain("Fri 14 Aug to Sun 16 Aug");
  });

  it("says so plainly when nothing was taken in", () => {
    const empty = report([]);
    // The subject is fixed, so the empty case has to be carried by the
    // preheader and the body instead.
    expect(buildSubject(empty)).toBe("Florist app yesterday values");
    expect(buildPreheader(empty)).toBe("No orders were taken on in this period.");
    expect(buildSubheading(empty)).toBe("No orders were taken on in this period.");
  });

  it("uses a plain period as the headline, not a verdict", () => {
    // The old headline read "0 of 3 orders ran hands-off", which was a
    // judgement about a number the reader had not seen yet.
    expect(buildHeadline(REAL)).toBe("Thu 20 Aug");
    expect(buildHeadline(report([], WEEKEND))).toBe("Fri 14 Aug to Sun 16 Aug");
  });

  it("says in the subject and the subheading that Monday covers three days", () => {
    const monday = report([outcome()], WEEKEND);
    // The counts triple on a Monday. The reader has to know that before
    // reading a single number, so it is said twice.
    expect(buildSubject(monday)).toBe("Florist app weekend values");
    expect(buildSubheading(monday)).toBe("3 days together: Friday, Saturday and Sunday.");
    // The explanation that followed it was telling a daily reader something
    // they already know.
    expect(buildTextBody(monday)).not.toContain("Nothing is sent at the weekend");
    expect(buildTextBody(monday)).toContain("Friday, Saturday and Sunday");
    expect(buildHtmlBody(monday)).toContain("Friday, Saturday and Sunday");
  });

  it("pluralises the order count", () => {
    expect(buildSubheading(report([outcome()]))).toContain("took on 1 order.");
    expect(buildSubheading(report([outcome(), outcome()]))).toContain("took on 2 orders.");
  });

  it("says nothing about three days on an ordinary weekday", () => {
    expect(buildSubject(REAL)).toBe("Florist app yesterday values");
    expect(buildSubheading(REAL)).not.toContain("Friday, Saturday");
    expect(periodDays(DAY)).toBe(1);
    expect(periodDays(WEEKEND)).toBe(3);
  });

  it("labels a Monday catch-up as a range so it is not read as one day", () => {
    expect(formatPeriod(WEEKEND)).toBe("Fri 14 Aug to Sun 16 Aug");
    expect(formatPeriod(DAY)).toBe("Thu 20 Aug");
  });

  it("walks the whole funnel, and names what fell out of each gap", () => {
    const body = buildTextBody(REAL);
    expect(body).toContain("WHAT HAPPENED TO THE 38 ORDERS");
    expect(body).toMatch(/Taken on\s+38/);
    expect(body).toMatch(/Matched\s+27 \(71%\)/);
    expect(body).toMatch(/Offer sent\s+27 \(71%\)/);
    expect(body).toMatch(/Florist accepted\s+3 \(8%\)/);
    // The drop is the story, and it names the step they did NOT reach.
    expect(body).toContain("11 never got matched to a florist");
    expect(body).toContain("24 were offered and no florist took it");
  });

  it("prints no share beside the first bar, which is its own denominator", () => {
    expect(funnelBars(REAL)[0]).toMatchObject({ count: "38", share: undefined });
    expect(funnelBars(REAL)[1]).toMatchObject({ count: "27", share: "(71%)" });
  });

  it("keeps the count and its share apart, as two things to read", () => {
    // They shipped as one bold run of digits, "4 100%", which read as a single
    // number nobody could parse. The count is the fact, the share is context.
    const html = buildHtmlBody(REAL);
    expect(html).not.toContain("27 71%");
    expect(html).toContain(">27<");
    expect(html).toContain("(71%)");
  });

  it("drops the sections that have nothing in them", () => {
    // A clean day should not carry zero rows the reader has to scan past.
    const body = buildTextBody(report(Array.from({ length: 3 }, () => outcome())));
    expect(body).not.toMatch(/WHY THEY REFUSED/);
    expect(body).not.toMatch(/WHY THEY NEED A PERSON/);
    expect(body).not.toMatch(/NEVER GOT AN OFFER/);
  });

  it("no longer carries the KPIs that were dropped as noise", () => {
    const body = buildTextBody(REAL) + buildHtmlBody(REAL);
    for (const gone of [
      "Orders received",
      "Left alone by the working-set gate",
      "Approvals decided",
      "Approvals still pending",
      "Issues opened",
      "previous 7 days",
      "Not right now",
      "Holding steady",
      "How to read this",
      // Cut after the CX review of the 2026-08-27 send. See digestEmail.ts's
      // header for what each one was and why it went.
      "Staff actions per order",
      "Reached by the loop alone",
      "Reached only after a person stepped in",
      "Closed in Shopify",
      "Where they went",
      "Shops offered",
      "Last 7 days",
      // The reader must never meet an unknown. A count that is nothing prints
      // 0, and a share with nothing under the line is not printed at all.
      "n/a",
      "?",
    ]) {
      expect(body).not.toContain(gone);
    }
  });

  it("uses the branded Facundo shell", () => {
    const html = buildHtmlBody(REAL);
    expect(html).toContain("#1F7A55");
    expect(html).toContain("facundo-logo-email.png");
    expect(html).toContain("https://bo.fc.example.net/statistics");
    expect(html).toContain('role="presentation"');
    expect(html).not.toContain("display:flex");
  });

  it("ships a hidden preheader ahead of the visible content", () => {
    const preheader = buildPreheader(REAL);
    expect(preheader).toBe("38 taken on. 3 accepted, 3 delivered.");
    const html = buildHtmlBody(REAL);
    expect(html).toMatch(/display:none;max-height:0;overflow:hidden/);
    // Must precede the visible body or the client will not use it.
    expect(html.indexOf(preheader)).toBeLessThan(html.indexOf("Thu 20 Aug"));
  });

  it("escapes html", () => {
    const html = buildHtmlBody(REAL);
    expect(html).not.toContain("<script");
    // Labels are escaped, not interpolated raw.
    expect(html).toContain("Florist accepted");
  });
});

describe("house style", () => {
  const visibleText = (html: string): string =>
    html
      .replace(/<style[\s\S]*?<\/style>/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&");

  const recipientFacing = (r: typeof REAL): string[] => [
    buildSubject(r), buildHeadline(r), buildPreheader(r), buildTextBody(r), visibleText(buildHtmlBody(r)),
  ];

  // House rule, documented against the em dash in dashboard/lib/i18n/i18n.test.mjs
  // and dashboard/lib/floristCopy.test.mjs: no dash used as PUNCTUATION in
  // outbound copy, use a comma, colon or full stop. Extended to the "--" and
  // spaced "-" spellings, which are the same violation and are what actually
  // shipped once. A hyphen inside a word is fine, and a dash at the start of a
  // line is a bullet, so only dashes with text on the left are caught.
  const DASH_PUNCTUATION = [
    { name: "em dash", re: /\S[^\n]*—/ },
    { name: "double hyphen", re: /\S[^\n]*\s--(\s|$)/ },
    { name: "spaced hyphen", re: /\S[^\n]*\s-\s/ },
  ];

  const CASES: Array<[string, typeof REAL]> = [
    ["the real production shape", REAL],
    ["a clean run", report(Array.from({ length: 5 }, () => outcome()))],
    ["nothing taken in", report([])],
    ["a Monday catch-up", report([outcome()], WEEKEND)],
    ["escalations of every kind", report([
      outcome({ status: "escalated", candidates: 0, deliveredAt: null }),
      outcome({ status: "escalated", candidates: 2, expired: 2, deliveredAt: null }),
      outcome({ status: "escalated", candidates: 2, declined: 2, deliveredAt: null }),
      outcome({ status: "escalated", candidates: 3, expired: 1, declined: 1, deliveredAt: null }),
    ])],
  ];

  for (const [label, r] of CASES) {
    it(`uses no dash punctuation in what the recipient reads (${label})`, () => {
      for (const text of recipientFacing(r)) {
        for (const line of text.split("\n")) {
          for (const { name, re } of DASH_PUNCTUATION) {
            expect(re.test(line), `${name} used as punctuation: ${line.trim()}`).toBe(false);
          }
        }
      }
    });
  }

  it("carries no explanatory footnote", () => {
    // Removed on request: it was a paragraph of prose under a table of numbers,
    // and nobody reads that. The labels have to carry their own meaning.
    const body = buildTextBody(REAL) + buildHtmlBody(REAL);
    expect(body).not.toContain("How to read this");
  });
});

describe("offers, split by who the florist is", () => {
  // The real 7 days to 26 Aug 2026, verified against prod with demo orders,
  // flagged test shops and the unflagged demo shops excluded. The split is the
  // whole point: aggregated these 130 offers read as a 4.6% acceptance rate,
  // which is true of nobody. Network shops accept 4 of 7; strangers 2 of 123.
  //
  // Counted as a COHORT: all three numbers describe the offers SENT in the
  // period, so accepted <= answered <= offersSent always holds.
  const ACTIVITY: ActivityStats = {
    network: { offersSent: 7, answered: 5, accepted: 4, timedOut: 0 },
    newShops: { offersSent: 123, answered: 3, accepted: 2, timedOut: 0 },
    refusalReasons: [{ reason: "On holiday", count: 1 }, { reason: "Price too low", count: 1 }],
  };
  const r = report([outcome()], DAY, ACTIVITY);

  it("reports the two cohorts separately, never as one rate", () => {
    const body = buildTextBody(r);
    expect(body).toMatch(/OFFERS WE SENT YESTERDAY: NETWORK SHOPS/);
    expect(body).toMatch(/OFFERS WE SENT YESTERDAY: NEW SHOPS/);
    // 4 of 7 against 2 of 123. The aggregate would have been 6 of 130, 5%,
    // which describes neither cohort.
    expect(body).toMatch(/Accepted\s+4 \(57%\)/);
    expect(body).toMatch(/Accepted\s+2 \(2%\)/);
    expect(body).not.toMatch(/Accepted\s+6 \(5%\)/);
  });

  it("draws each cohort as a funnel over its own offers, so nothing can exceed 100%", () => {
    // The bug this replaces: offers were counted by send date and replies by
    // reply date, so a florist answering an older offer produced "1 (n/a)" on
    // 27 Aug and "8 of 6 (133%)" the row below it.
    const body = buildTextBody(r);
    // The top of a cohort funnel carries no share: it is its own denominator.
    expect(body).toMatch(/Offers sent\s+7$/m);
    expect(body).toMatch(/Answered\s+5 \(71%\)/);
    for (const cohort of [ACTIVITY.network, ACTIVITY.newShops]) {
      expect(cohort.accepted).toBeLessThanOrEqual(cohort.answered);
      expect(cohort.answered).toBeLessThanOrEqual(cohort.offersSent);
    }
  });

  it("surfaces silence, which is the real failure mode for strangers", () => {
    // 123 offers, 3 answers. The zeros are the point, so they are printed.
    const silent = report([outcome()], DAY, {
      ...ACTIVITY,
      newShops: { offersSent: 24, answered: 0, accepted: 0, timedOut: 0 },
    });
    expect(buildTextBody(silent)).toMatch(/Answered\s+0 \(0%\)/);
  });

  it("lists the refusal reasons, commonest first", () => {
    const body = buildTextBody(r);
    expect(body).toMatch(/WHY THEY REFUSED/);
    expect(body).toMatch(/On holiday\s+1/);
  });

  it("says a cohort got no offers in words, not as three empty bars", () => {
    // Three bars at zero read as a broken image. On 2026-08-27 the network
    // column was exactly this: no offers went out at all that day.
    const quiet = buildTextBody(report([outcome()]));
    expect(quiet).toMatch(/OFFERS WE SENT YESTERDAY: NETWORK SHOPS/);
    expect(quiet).toContain("No offers went out yesterday.");
    expect(quiet).not.toMatch(/WHY THEY REFUSED/);
  });

  it("does not say yesterday on a Monday, which covers three days", () => {
    const monday = report([outcome()], WEEKEND, ACTIVITY);
    expect(buildTextBody(monday)).toMatch(/OFFERS WE SENT: NETWORK SHOPS/);
    expect(buildTextBody(monday)).not.toContain("OFFERS WE SENT YESTERDAY");
  });

  it("no longer reports email opens, which nobody acted on", () => {
    const body = buildTextBody(r);
    expect(body).not.toMatch(/EMAIL/);
    expect(body).not.toMatch(/Opened, at least/);
  });

  it("renders the two cohorts as columns that survive Outlook", () => {
    const html = buildHtmlBody(r);
    expect(html).toContain("Network shops");
    expect(html).toContain("New shops");
    // A table, not a grid: Outlook ignores display:grid and would stack them,
    // losing the comparison the split exists to make.
    expect(html).not.toContain("display:grid");
    expect(html).toMatch(/<td width="50%"/);
  });
});

describe("the 6 that never got an offer", () => {
  // The question CX asked of the 2026-08-27 send: six of eight orders stopped
  // at Matched and the mail said only that they stopped.
  const r = report([
    ...Array.from({ length: 4 }, () =>
      outcome({ reached: "matched", reachedAlone: "matched", status: "matched", deliveredAt: null, noOfferReason: "newShopsOnly" })),
    outcome({ reached: "matched", reachedAlone: "matched", status: "matched", deliveredAt: null, noOfferReason: "notSentYet" }),
    outcome({ reached: "matched", reachedAlone: "matched", status: "escalated", deliveredAt: null, noOfferReason: "other" }),
    outcome(),
  ]);

  it("adds up to the drop line in the funnel above it", () => {
    // The reader has to be able to check the block against the funnel, so the
    // three reasons sum to the orders that stopped at Matched, and that number
    // is the funnel's own drop between Matched and Offer sent.
    expect(r.noOffer.total).toBe(6);
    expect(r.noOffer.newShopsOnly + r.noOffer.notSentYet + r.noOffer.other).toBe(6);
    const bars = funnelBars(r);
    expect(bars[1].drop).toBe("6 did not reach Offer sent");
  });

  it("prints a zero rather than hiding a reason nothing landed on", () => {
    // CX's rule after the 27 Aug review: a count that is nothing is a 0, never
    // a blank and never a question mark.
    const rows = noOfferRows(report([
      outcome({ reached: "matched", status: "matched", deliveredAt: null, noOfferReason: "newShopsOnly" }),
    ]));
    expect(rows.map((row) => row.value)).toEqual(["1", "0", "0"]);
  });

  it("shows the block only when something actually stopped there", () => {
    expect(buildTextBody(r)).toContain("WHY THOSE 6 NEVER GOT AN OFFER");
    expect(buildTextBody(REAL)).not.toContain("NEVER GOT AN OFFER");
  });

  it("links to the orders it is talking about", () => {
    expect(buildHtmlBody(r)).toContain("https://bo.fc.example.net/orders?status=matched");
  });

  it("counts an order once, whatever else is true of it", () => {
    // An escalated order might ALSO have only new shops nearby. "A person
    // already owns this" is the more useful of the two facts, so it wins, and
    // the order is not counted twice.
    const newShop = [{ florists: { lifecycle_stage: "prospect" } }];
    expect(noOfferReason("escalated", newShop)).toBe("other");
    expect(noOfferReason("matched", newShop)).toBe("newShopsOnly");
    expect(noOfferReason("matched", [{ florists: { lifecycle_stage: "production" } }])).toBe("notSentYet");
    // Same predicate as the wave engine's send gate: onboarding shops count as
    // network, so the email cannot say a shop is a stranger while the engine
    // treats it as one of ours.
    expect(noOfferReason("matched", [{ florists: { lifecycle_stage: "onboarding" } }])).toBe("notSentYet");
    // An embedded row can arrive as an array from supabase-js.
    expect(noOfferReason("matched", [{ florists: [{ lifecycle_stage: "production" }] }])).toBe("notSentYet");
    expect(noOfferReason("matched", [])).toBe("other");
  });
});

describe("stage evidence", () => {
  it("walks consecutively and stops at the first gap", () => {
    expect(stageFromEvidence({ matched: true, outreach: true, fulfilment: false, delivery: false, delivered: false }))
      .toBe("outreach");
  });

  it("does not treat a Shopify close as a delivery", () => {
    // 26 of the 27 orders closed between 11 and 26 Aug 2026 had no delivery
    // photo: they were fulfilled elsewhere. Counting them as Delivered would
    // credit the loop with work it never did.
    expect(stageFromEvidence({ matched: true, outreach: true, fulfilment: true, delivery: false, delivered: false }))
      .toBe("fulfilment");
  });

  it("reports the furthest stage with how many orders got there", () => {
    expect(furthest(["created", "outreach", "outreach"])).toEqual({ stage: "outreach", count: 2 });
  });

  it("counts pass-through cumulatively", () => {
    expect(passedThrough(["created", "outreach"])).toEqual([2, 1, 1, 0, 0, 0]);
  });

  it("has not drifted from the order page's stage model", () => {
    // dashboard/lib/orderStages.ts is the original; this is the Worker's copy,
    // duplicated because the Worker cannot import across the package boundary.
    expect(STAGES.map((s) => s.id)).toEqual([
      "created", "matched", "outreach", "fulfilment", "delivery", "delivered",
    ]);
  });
});

describe("recipients", () => {
  it("goes to the CX list now the format is signed off", () => {
    expect(DEFAULT_RECIPIENTS).toEqual([
      "owner@fc.example.com",
      "marketing@fc.example.com",
      "editor@fc.example.com",
      "ops2@fc.example.com",
      "staff@fc.example.com",
    ]);
  });
});

describe("digest replay", () => {
  // The reason this exists rather than DIGEST_FORCE: force bypasses the
  // dedupe, and the cron ticks every minute, so it would send an email a
  // minute to the whole CX list until somebody noticed.
  it("reads a period key strictly, because a half-parsed one reports wrong days", () => {
    expect(parseReplayPeriod("2026-08-28..2026-08-30", "Europe/Madrid")).toEqual({
      fromDay: "2026-08-28", toDay: "2026-08-30", timezone: "Europe/Madrid",
    });
    // A single day is a legitimate replay of an ordinary weekday send.
    expect(parseReplayPeriod("2026-08-27..2026-08-27", "Europe/Madrid")?.toDay).toBe("2026-08-27");
  });

  it("refuses anything that is not a period, rather than guessing", () => {
    for (const bad of ["", "yesterday", "2026-08-28", "2026-08-28..", "28-08-2026..30-08-2026",
      // Backwards: would report a range no calendar has.
      "2026-08-30..2026-08-28"]) {
      expect(parseReplayPeriod(bad, "Europe/Madrid")).toBeNull();
    }
  });

  it("accepts a tag, so the same days can be previewed again after a change", () => {
    // The dedupe is keyed on the whole value, so a new tag permits exactly one
    // more send. Leaving the value alone stays inert.
    expect(parseReplayPeriod("2026-08-28..2026-08-30@v2", "Europe/Madrid")).toEqual({
      fromDay: "2026-08-28", toDay: "2026-08-30", timezone: "Europe/Madrid",
    });
    expect(parseReplayPeriod("2026-08-28..2026-08-30@bars-fix.2", "Europe/Madrid")?.toDay).toBe("2026-08-30");
    // Still strict about the part that decides which days get reported.
    expect(parseReplayPeriod("2026-08-28..2026-08-30@", "Europe/Madrid")).toBeNull();
    expect(parseReplayPeriod("2026-08-28..2026-08-30@a b", "Europe/Madrid")).toBeNull();
  });

  it("tolerates the whitespace a copied value carries", () => {
    expect(parseReplayPeriod(" 2026-08-28..2026-08-30 ", "Europe/Madrid")?.fromDay).toBe("2026-08-28");
  });
});

describe("addDays", () => {
  it("crosses month and year boundaries", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-08-17", -3)).toBe("2026-08-14");
  });
});

describe("offers that ran out of time", () => {
  it("counts only the ones nobody answered, as a subset of those sent", () => {
    // A shop that read the offer and refused is NOT a timeout: it is a "no",
    // and the two call for opposite responses. Only silence-then-expiry counts.
    const rows = [
      { order_id: "o1", florist_id: "f1", status: "expired", sent_at: "2026-09-01T09:00:00Z", accepted_at: null, declined_at: null, decline_reason: null, florists: { lifecycle_stage: "found" } },
      { order_id: "o2", florist_id: "f2", status: "expired", sent_at: "2026-09-01T09:00:00Z", accepted_at: null, declined_at: "2026-09-01T09:30:00Z", decline_reason: "Too busy", florists: { lifecycle_stage: "found" } },
      { order_id: "o3", florist_id: "f3", status: "accepted", sent_at: "2026-09-01T09:00:00Z", accepted_at: "2026-09-01T09:10:00Z", declined_at: null, decline_reason: null, florists: { lifecycle_stage: "found" } },
      { order_id: "o4", florist_id: "f4", status: "sent", sent_at: "2026-09-01T09:00:00Z", accepted_at: null, declined_at: null, decline_reason: null, florists: { lifecycle_stage: "found" } },
    ];
    const c = tally(rows as AssignmentRow[]);
    expect(c.offersSent).toBe(4);
    expect(c.timedOut).toBe(1);          // only o1
    expect(c.answered).toBe(2);          // o2 refused, o3 accepted
    expect(c.timedOut).toBeLessThanOrEqual(c.offersSent);
  });
});

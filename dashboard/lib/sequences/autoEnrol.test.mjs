import test from "node:test";
import assert from "node:assert/strict";
import {
  autoEnrolBlockReason,
  autoEnrolEligible,
  autoEnrolSince,
  AUTO_ENROL_LOOKBACK_DAYS,
  AUTO_ENROL_PER_TICK,
} from "./autoEnrol.ts";

const NOW = Date.parse("2026-08-19T09:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (d) => new Date(NOW - d * DAY).toISOString();

const ON = { sequence_enabled: true, sequence_auto_enrol_scraped: true };

// A freshly scraped shop exactly as ingest leaves it: found, emailed, untouched.
const fresh = (over = {}) => ({
  lifecycle_stage: "found",
  email: "hello@fleurs.example",
  ingested_at: ago(1),
  joined_at: null,
  excluded_at: null,
  deleted_at: null,
  order_emails_opt_out: false,
  is_test_shop: false,
  everEnrolled: false,
  ...over,
});

test("a freshly scraped shop with an email is eligible when both switches are on", () => {
  assert.equal(autoEnrolBlockReason(fresh(), ON, NOW), null);
  assert.equal(autoEnrolEligible(fresh(), ON, NOW), true);
});

// THE story's decision: ingest automatic, enrolment opt-in. Off = today's behaviour.
test("the opt-in switch off blocks everything, whatever the shop looks like", () => {
  assert.equal(autoEnrolBlockReason(fresh(), { sequence_enabled: true, sequence_auto_enrol_scraped: false }, NOW), "disabled");
  assert.equal(autoEnrolBlockReason(fresh(), { sequence_enabled: true }, NOW), "disabled");
});

test("the master funnel switch off blocks it even with the opt-in on (fails closed)", () => {
  assert.equal(autoEnrolBlockReason(fresh(), { sequence_enabled: false, sequence_auto_enrol_scraped: true }, NOW), "disabled");
  assert.equal(autoEnrolBlockReason(fresh(), null, NOW), "disabled");
  assert.equal(autoEnrolBlockReason(fresh(), undefined, NOW), "disabled");
});

test("no email → cannot enter the funnel", () => {
  assert.equal(autoEnrolBlockReason(fresh({ email: null }), ON, NOW), "no-email");
  assert.equal(autoEnrolBlockReason(fresh({ email: "   " }), ON, NOW), "no-email");
});

test("excluded, deleted, joined, opted-out and test shops are never auto-enrolled", () => {
  assert.equal(autoEnrolBlockReason(fresh({ excluded_at: ago(2) }), ON, NOW), "excluded");
  assert.equal(autoEnrolBlockReason(fresh({ deleted_at: ago(2) }), ON, NOW), "excluded");
  assert.equal(autoEnrolBlockReason(fresh({ joined_at: ago(2) }), ON, NOW), "joined");
  assert.equal(autoEnrolBlockReason(fresh({ order_emails_opt_out: true }), ON, NOW), "opted-out");
  assert.equal(autoEnrolBlockReason(fresh({ is_test_shop: true }), ON, NOW), "test-shop");
});

// Only the untouched: a human who already targeted the shop, or a send that
// already went out, means this is no longer "new".
test("only lifecycle_stage=found qualifies", () => {
  for (const stage of ["targeted", "contacted", "engaged", "onboarding", "production", "lost"]) {
    assert.equal(autoEnrolBlockReason(fresh({ lifecycle_stage: stage }), ON, NOW), "not-found-stage", stage);
  }
  // A null stage reads as the column default.
  assert.equal(autoEnrolBlockReason(fresh({ lifecycle_stage: null }), ON, NOW), null);
});

// The guard against the infinite-funnel failure: a shop that finished (or was
// stopped out of) a run while still at `found` must not be restarted from the top.
test("a shop that was EVER enrolled is not re-enrolled", () => {
  assert.equal(autoEnrolBlockReason(fresh({ everEnrolled: true }), ON, NOW), "already-enrolled");
});

// The guard against "turning the switch on empties the whole backlog into the funnel".
test("only shops ingested inside the lookback window count as freshly scraped", () => {
  assert.equal(autoEnrolBlockReason(fresh({ ingested_at: ago(AUTO_ENROL_LOOKBACK_DAYS - 1) }), ON, NOW), null);
  assert.equal(autoEnrolBlockReason(fresh({ ingested_at: ago(AUTO_ENROL_LOOKBACK_DAYS + 1) }), ON, NOW), "too-old");
  assert.equal(autoEnrolBlockReason(fresh({ ingested_at: null }), ON, NOW), "too-old");
  assert.equal(autoEnrolBlockReason(fresh({ ingested_at: "not a date" }), ON, NOW), "too-old");
});

test("the query's lower bound and the pure rule agree on the window", () => {
  const since = Date.parse(autoEnrolSince(NOW));
  assert.equal(NOW - since, AUTO_ENROL_LOOKBACK_DAYS * DAY);
  // Exactly on the boundary is inside the window for both.
  assert.equal(autoEnrolBlockReason(fresh({ ingested_at: autoEnrolSince(NOW) }), ON, NOW), null);
});

// Order of checks: the cheapest, most-final reasons win, so a disabled switch
// never reports "no-email" and an excluded shop never reports "too-old".
test("reason precedence is stable", () => {
  assert.equal(autoEnrolBlockReason(fresh({ email: null, excluded_at: ago(1) }), { sequence_enabled: true }, NOW), "disabled");
  assert.equal(autoEnrolBlockReason(fresh({ email: null, excluded_at: ago(1) }), ON, NOW), "excluded");
  assert.equal(autoEnrolBlockReason(fresh({ email: null, ingested_at: ago(100) }), ON, NOW), "no-email");
});

test("the per-tick cap is a small number (a rate, not a flood)", () => {
  assert.ok(AUTO_ENROL_PER_TICK > 0 && AUTO_ENROL_PER_TICK <= 50);
});

// --- hardening (2026-08-19 QA round) ---------------------------------------

// A bounce stops the live run and stamps the florist; automation must not
// start a NEW run to an address we already know is dead.
test("a bounced address is never auto-enrolled", () => {
  assert.equal(autoEnrolBlockReason(fresh({ email_bounced_at: ago(30) }), ON, NOW), "bounced");
});

// Head-office / directory inboxes: the matcher already refuses to treat these
// as the shop's identity (lib/match.ts::emailIdentifies); recruiting
// automation follows the same rule. Staff can still send by hand.
test("a network (head-office) address is never auto-enrolled", () => {
  assert.equal(autoEnrolBlockReason(fresh({ network_id: "net-1" }), ON, NOW), "network-address");
});

test("an address shared across several listings is never auto-enrolled", () => {
  assert.equal(autoEnrolBlockReason(fresh({ email_shared_count: 2 }), ON, NOW), "shared-address");
  assert.equal(autoEnrolBlockReason(fresh({ email_shared_count: 33 }), ON, NOW), "shared-address");
  // 1, 0 and null all mean "only this listing".
  assert.equal(autoEnrolBlockReason(fresh({ email_shared_count: 1 }), ON, NOW), null);
  assert.equal(autoEnrolBlockReason(fresh({ email_shared_count: 0 }), ON, NOW), null);
  assert.equal(autoEnrolBlockReason(fresh({ email_shared_count: null }), ON, NOW), null);
});

// everEnrolled is judged per INBOX by the sweep (reconcile.ts): a second
// listing of an inbox whose first listing already ran the funnel — weeks ago,
// run finished — is passed in as everEnrolled=true and must be refused.
test("a sibling listing of an already-run inbox is refused via everEnrolled", () => {
  assert.equal(autoEnrolBlockReason(fresh({ everEnrolled: true }), ON, NOW), "already-enrolled");
});

// ---- country scope ----
//
// `sequence_auto_enrol_scraped` is otherwise GLOBAL. Measured on prod the day
// this shipped, flipping it for a Spain campaign would have enrolled 720 shops
// of which 16 were Spanish — Denmark, France and Israel took 56% between them.
// Since the daily send cap is the scarce resource, "also mail France" is not a
// harmless superset; it is Spain getting 2% of its own campaign.

const ES = { ...ON, sequence_auto_enrol_countries: ["ES"] };

test("no allow-list means every country, exactly as before the column existed", () => {
  // An un-migrated row reads as null here, and must not become more
  // restrictive by accident.
  for (const countries of [null, undefined, []]) {
    const settings = { ...ON, sequence_auto_enrol_countries: countries };
    assert.equal(autoEnrolEligible(fresh({ country: "FR" }), settings, NOW), true, `countries=${JSON.stringify(countries)}`);
    assert.equal(autoEnrolEligible(fresh({ country: null }), settings, NOW), true);
  }
});

test("an allow-list admits the listed country and refuses the rest", () => {
  assert.equal(autoEnrolEligible(fresh({ country: "ES" }), ES, NOW), true);
  for (const c of ["FR", "DK", "IL", "CH", "SE"]) {
    assert.equal(autoEnrolBlockReason(fresh({ country: c }), ES, NOW), "country-excluded", c);
  }
});

test("country matching ignores case and stray spacing", () => {
  // The allow-list is typed by a person; `cities.country` is written by the
  // ingest pipeline. Neither should have to know how the other spells it.
  for (const c of ["es", "ES", " es ", "Es"]) {
    assert.equal(autoEnrolEligible(fresh({ country: c }), ES, NOW), true, `florist country ${JSON.stringify(c)}`);
  }
  assert.equal(autoEnrolEligible(fresh({ country: "ES" }), { ...ON, sequence_auto_enrol_countries: [" es "] }, NOW), true);
});

test("an unknown country cannot satisfy an explicit allow-list", () => {
  // A florist whose city row is missing has no country. With a list set, that
  // is "not in it" — silence must not read as consent to mail them.
  for (const c of [null, undefined, "", "   "]) {
    assert.equal(autoEnrolBlockReason(fresh({ country: c }), ES, NOW), "country-excluded", JSON.stringify(c));
  }
});

test("country scope is checked before shop-level refusals", () => {
  // A French test shop should read as out-of-campaign, not as a test shop:
  // the skip counts are how staff find out why a run enrolled nobody, and
  // "country-excluded" is the honest answer.
  assert.equal(autoEnrolBlockReason(fresh({ country: "FR", is_test_shop: true }), ES, NOW), "country-excluded");
});

test("the allow-list does not override the master switches", () => {
  const off = { sequence_enabled: false, sequence_auto_enrol_scraped: true, sequence_auto_enrol_countries: ["ES"] };
  assert.equal(autoEnrolBlockReason(fresh({ country: "ES" }), off, NOW), "disabled");
});

test("a listed-country shop still has to pass every other rule", () => {
  // Scoping narrows the campaign; it must not widen eligibility.
  assert.equal(autoEnrolBlockReason(fresh({ country: "ES", is_test_shop: true }), ES, NOW), "test-shop");
  assert.equal(autoEnrolBlockReason(fresh({ country: "ES", joined_at: ago(1) }), ES, NOW), "joined");
  assert.equal(autoEnrolBlockReason(fresh({ country: "ES", email_shared_count: 3 }), ES, NOW), "shared-address");
  assert.equal(autoEnrolBlockReason(fresh({ country: "ES", ingested_at: ago(AUTO_ENROL_LOOKBACK_DAYS + 1) }), ES, NOW), "too-old");
});

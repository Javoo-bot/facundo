// Two sweeps that repair state the send paths cannot finish on their own.
//
// Both are SWEEPS rather than callbacks, deliberately. An order stops being
// "live" for a florist in half a dozen ways — it expires, they decline, someone
// else accepts, staff withdraw or reassign it, the order is cancelled or
// deleted — and hanging a resume hook off each one guarantees the next path
// added forgets. A sweep asks the only question that matters ("does this
// florist have a live offer right now?") and is idempotent, so it cannot be
// missed and cannot double-fire.
//
// The pure predicates are at the bottom and unit-tested; the exported functions
// are the thin I/O around them.

import { createServiceClient } from "@/lib/supabaseAdmin";
import { captureError } from "@/lib/monitor";
import { enrol, resumeRecruitingFor } from "./enrol.ts";
import { LIVE_OFFER_STATUSES, coldFollowUpEligible, type ColdFollowUpFlorist } from "./liveOffer.ts";
import { reactivationKind } from "./reactivation.ts";
import { contactKey } from "./contactIdentity.ts";
import {
  autoEnrolBlockReason,
  autoEnrolSince,
  AUTO_ENROL_PER_TICK,
  type AutoEnrolSettings,
} from "./autoEnrol.ts";

type Admin = ReturnType<typeof createServiceClient>;

/**
 * Un-pause recruiting for anyone whose order offer is over.
 *
 * Without this, `pauseRecruitingFor` (called on every offer send) is a one-way
 * door: the run parks at `paused` forever, and because the partial unique index
 * counts `paused` as live, that florist can never be re-enrolled either. The
 * whole funnel silently dies for anyone who was ever offered an order.
 */
export async function resumePausedRecruiting(admin: Admin, limit = 200): Promise<number> {
  try {
    const { data: paused } = await admin
      .from("sequence_enrolments")
      .select("id, florist_id")
      .eq("sequence_id", "recruit_cold")
      .eq("status", "paused")
      .limit(limit);
    if (!paused?.length) return 0;

    const floristIds = [...new Set(paused.map((p) => p.florist_id as string))];
    const { data: liveOffers } = await admin
      .from("order_assignments")
      .select("florist_id")
      .in("florist_id", floristIds)
      .in("status", [...LIVE_OFFER_STATUSES]);
    const stillBusy = new Set((liveOffers ?? []).map((a) => a.florist_id as string));

    let resumed = 0;
    for (const floristId of floristIds) {
      if (stillBusy.has(floristId)) continue;
      resumed += await resumeRecruitingFor(admin, floristId);
    }
    return resumed;
  } catch (e) {
    captureError("sequences.resumePausedRecruiting", e);
    return 0;
  }
}

/**
 * A real order we offered to a shop outside the network has gone elsewhere.
 * Enrol them in the short follow-up that says so — the strongest recruiting
 * email we have, because it points at something that actually happened.
 *
 * Only for shops that did NOT take it: a florist who accepted is in the network
 * now and `enrol` would be refused anyway (the tick stops any run for a joined
 * florist), but filtering here keeps the intent obvious.
 */
export async function enrolLapsedColdOffers(admin: Admin, limit = 100): Promise<number> {
  try {
    const { data: lapsed } = await admin
      .from("order_assignments")
      .select("id, order_id, florist_id, status, florists(joined_at, excluded_at, deleted_at)")
      .eq("offer_audience", "cold")
      .in("status", ["declined", "expired", "reassigned", "released"])
      .limit(limit);
    if (!lapsed?.length) return 0;

    let enrolled = 0;
    for (const a of lapsed) {
      // PostgREST returns an embed as either an object or a one-element
      // array depending on the relationship it infers; both shapes occur here.
      const fl = a.florists as unknown as ColdFollowUpFlorist | ColdFollowUpFlorist[] | null;
      const florist = Array.isArray(fl) ? fl[0] : fl;
      if (!coldFollowUpEligible(florist)) continue;

      // Idempotent: the partial unique index means an existing live run for
      // this florist makes this a benign no-op rather than a second funnel.
      const r = await enrol(admin, {
        floristId: a.florist_id as string,
        sequenceId: "cold_offer_followup",
        orderId: a.order_id as string,
        assignmentId: a.id as string,
      });
      if (r.ok) enrolled++;
    }
    return enrolled;
  } catch (e) {
    captureError("sequences.enrolLapsedColdOffers", e);
    return 0;
  }
}

/**
 * Enrol network florists who have gone quiet.
 *
 * A sweep rather than an event hook because "went quiet" has no event — it is
 * the ABSENCE of one. Nothing fires when a florist stops accepting orders, so
 * the only way to notice is to look.
 *
 * Bounded per tick (`limit`) on purpose: this reads the whole joined-florist
 * set, and the first run after enabling it would otherwise enrol every dormant
 * shop at once. The daily send cap would catch the sends, but the enrolments
 * themselves would all be created in one minute, which makes the first day's
 * numbers unreadable.
 */
export async function enrolReactivations(admin: Admin, limit = 50): Promise<number> {
  try {
    const { data: joined } = await admin
      .from("florists")
      .select("id, joined_at, excluded_at, deleted_at, order_emails_opt_out")
      .not("joined_at", "is", null)
      .is("deleted_at", null)
      .is("excluded_at", null)
      .limit(500);
    if (!joined?.length) return 0;

    const ids = joined.map((f) => f.id as string);

    // One query for the whole batch rather than per florist: the last time each
    // of them took an order, and whether they were ever offered one at all.
    const { data: assignments } = await admin
      .from("order_assignments")
      .select("florist_id, status, accepted_at")
      .in("florist_id", ids);

    const lastAccepted = new Map<string, string>();
    const everOffered = new Set<string>();
    for (const a of assignments ?? []) {
      const fid = a.florist_id as string;
      everOffered.add(fid);
      if (a.status !== "accepted" && a.status !== "delivered") continue;
      const at = a.accepted_at as string | null;
      if (!at) continue;
      const prev = lastAccepted.get(fid);
      if (!prev || at > prev) lastAccepted.set(fid, at);
    }

    // Anyone already in a live run of either sequence is skipped — enrol() would
    // refuse anyway, but not querying them keeps the loop cheap.
    const { data: live } = await admin
      .from("sequence_enrolments")
      .select("florist_id")
      .in("florist_id", ids)
      .in("status", ["active", "paused"]);
    const busy = new Set((live ?? []).map((e) => e.florist_id as string));

    const now = Date.now();
    let enrolled = 0;
    for (const f of joined) {
      if (enrolled >= limit) break;
      const fid = f.id as string;
      if (busy.has(fid)) continue;

      const kind = reactivationKind(
        {
          joined_at: f.joined_at as string | null,
          excluded_at: f.excluded_at as string | null,
          deleted_at: f.deleted_at as string | null,
          order_emails_opt_out: f.order_emails_opt_out as boolean | null,
          lastAcceptedAt: lastAccepted.get(fid) ?? null,
          hasBeenOffered: everOffered.has(fid),
        },
        now
      );
      if (!kind) continue;

      const r = await enrol(admin, { floristId: fid, sequenceId: kind });
      if (r.ok) enrolled++;
    }
    return enrolled;
  } catch (e) {
    captureError("sequences.enrolReactivations", e);
    return 0;
  }
}

/**
 * Enrol freshly scraped shops in the recruiting funnel — the opt-in behind
 * `app_settings.sequence_auto_enrol_scraped`.
 *
 * A sweep, not a callback from the ingest worker, for the same reason as the
 * two above: the worker cannot call enrol() (it lives here, with the
 * per-inbox dedupe), a scrape can finish while the switch is off and be
 * turned on later, and a sweep that asks "is there an untouched new shop?"
 * is idempotent and cannot be missed. Before this, ingest-on-empty scraped an
 * uncovered area automatically and then nobody ever wrote to the shops it
 * found — they sat at `found` until a human pressed Send on /discovery.
 *
 * Bounded three ways on purpose: the lookback window (only shops ingested in
 * the last AUTO_ENROL_LOOKBACK_DAYS — turning the switch on must not pour the
 * historical backlog into the funnel), the per-tick cap (rows per minute), and
 * — downstream, unchanged — the daily send cap on the emails themselves.
 *
 * Returns how many were enrolled. The per-reason skip counts are returned too
 * so the tick can say WHY a run enrolled nobody.
 */
export async function enrolNewlyScrapedShops(
  admin: Admin,
  settings: AutoEnrolSettings | null | undefined,
  limit = AUTO_ENROL_PER_TICK
): Promise<{ enrolled: number; skipped: Record<string, number> }> {
  const skipped: Record<string, number> = {};
  // Cheap early exit — the pure rule would say "disabled" for every row, but
  // there is no point reading the rows to find that out.
  if (!settings?.sequence_enabled || !settings?.sequence_auto_enrol_scraped) return { enrolled: 0, skipped };
  try {
    const now = Date.now();
    // The query narrows to what the pure rule could possibly accept; the rule
    // is still applied per row so the two can never disagree, and so a column
    // the query does not filter on (opt-out, test shop) is still honoured.
    // Every PERMANENT refusal the pure rule knows is also a query filter, so
    // a row that can never qualify does not occupy one of the 200 slots. With
    // only the rule doing the work, a big ingest whose newest 200 rows were
    // all head-office / shared / bounced addresses would be re-read every tick
    // while older eligible shops behind them never got a turn. The rule still
    // runs per row — the query narrows, the rule decides.
    // `cities!inner(country)` is an INNER join on purpose: a florist whose city
    // row is missing has no country, and an explicit allow-list must not treat
    // "unknown" as a pass. With no allow-list set the join is still inner, but
    // every florist has a city_id (NOT NULL), so nothing is lost.
    const allowedCountries = settings.sequence_auto_enrol_countries ?? null;
    let freshQuery = admin
      .from("florists")
      .select("id, lifecycle_stage, email, ingested_at, joined_at, excluded_at, deleted_at, order_emails_opt_out, is_test_shop, email_bounced_at, network_id, email_shared_count, cities!inner(country)")
      .eq("lifecycle_stage", "found")
      .not("email", "is", null)
      .is("deleted_at", null)
      .is("excluded_at", null)
      .is("joined_at", null)
      .is("email_bounced_at", null)
      .is("network_id", null)
      .or("email_shared_count.is.null,email_shared_count.lte.1")
      .or("order_emails_opt_out.is.null,order_emails_opt_out.eq.false")
      .or("is_test_shop.is.null,is_test_shop.eq.false")
      .gte("ingested_at", autoEnrolSince(now));
    // Narrow in the QUERY as well as in the rule, for the same reason every
    // other permanent refusal is a filter here: without it, a big non-listed
    // ingest (France scrapes far more than Spain) fills all 200 slots every
    // tick and the listed country's shops never get a turn. The pure rule still
    // decides per row, so the two cannot disagree.
    if (allowedCountries && allowedCountries.length > 0) {
      freshQuery = freshQuery.in("cities.country", allowedCountries);
    }
    const { data: fresh } = await freshQuery
      .order("ingested_at", { ascending: false })
      .limit(200);
    if (!fresh?.length) return { enrolled: 0, skipped };

    // Anyone who has EVER been enrolled — live or finished — is not new. A
    // shop that completed a funnel still at `found` (the tick now bumps stage
    // on send, but older rows predate that) must not be restarted from the
    // top every time the window includes it.
    //
    // Judged per INBOX, not per row: `florists` is one row per map listing, so
    // the same shop (or chain) is several rows sharing one address. enrol()'s
    // own dedupe only looks at LIVE runs — enough for a double click, not for
    // "listing B of the same inbox shows up a month after listing A's run
    // ended". Any enrolment, ever, for any listing with this address counts.
    const ids = fresh.map((f) => f.id as string);
    // Only plain addresses take part in the sibling lookup: anything with a
    // comma, quote or parenthesis would break PostgREST's `.or()` filter
    // syntax, and ONE such scraped junk value would then throw, zero the whole
    // sweep, and keep doing so on every tick for 14 days. A shop with an odd
    // address is still checked by its own id below — it just does not get
    // the inbox-level check. `_`/`%` are LIKE wildcards and are escaped.
    const SAFE_KEY = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
    const keys = [...new Set(fresh.map((f) => contactKey(f.email as string | null)).filter((k): k is string => k !== null && SAFE_KEY.test(k)))];
    const likeOf = (k: string) => `email.ilike.${k.replace(/[%_]/g, (c) => "\\" + c)}`;
    const chunk = <T,>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
    // Chunked: a request's filters travel in the URL, and 200 addresses (or
    // a few hundred ids below) in one request is the kind of length that
    // works on a laptop and fails behind a gateway — silently, as a 0 sweep.
    const siblings: { id: string; email: string | null }[] = [];
    for (const part of chunk(keys, 40)) {
      const { data } = await admin.from("florists").select("id, email").or(part.map(likeOf).join(",")).limit(2000);
      siblings.push(...((data ?? []) as { id: string; email: string | null }[]));
    }
    const idsByKey = new Map<string, string[]>();
    for (const s of siblings) {
      const k = contactKey(s.email as string | null);
      if (k === null) continue;
      idsByKey.set(k, [...(idsByKey.get(k) ?? []), s.id as string]);
    }
    const lookupIds = [...new Set([...ids, ...[...idsByKey.values()].flat()])];
    const everIds = new Set<string>();
    for (const part of chunk(lookupIds, 150)) {
      const { data: ever } = await admin.from("sequence_enrolments").select("florist_id").in("florist_id", part);
      for (const e of ever ?? []) everIds.add(e.florist_id as string);
    }
    const everEnrolledInbox = (f: { id: string; email: string | null }): boolean => {
      if (everIds.has(f.id)) return true;
      const k = contactKey(f.email);
      return k !== null && (idsByKey.get(k) ?? []).some((id) => everIds.has(id));
    };

    let enrolled = 0;
    // Sequential on purpose: enrol()'s per-inbox dedupe reads the rows this
    // loop is writing. Two listings sharing one address in the same batch
    // would otherwise both see "nobody yet" and both get in.
    for (const f of fresh) {
      if (enrolled >= limit) break;
      // supabase-js types a to-one embed as an ARRAY while PostgREST returns a
      // single object at runtime (same mismatch app/(staff)/florists/page.tsx
      // documents). Read both shapes rather than trusting either.
      const cityEmbed = (f as { cities?: { country?: string | null } | { country?: string | null }[] | null }).cities;
      const country = (Array.isArray(cityEmbed) ? cityEmbed[0]?.country : cityEmbed?.country) ?? null;
      const reason = autoEnrolBlockReason(
        {
          country,
          lifecycle_stage: f.lifecycle_stage as string | null,
          email: f.email as string | null,
          ingested_at: f.ingested_at as string | null,
          joined_at: f.joined_at as string | null,
          excluded_at: f.excluded_at as string | null,
          deleted_at: f.deleted_at as string | null,
          order_emails_opt_out: f.order_emails_opt_out as boolean | null,
          is_test_shop: f.is_test_shop as boolean | null,
          email_bounced_at: f.email_bounced_at as string | null,
          network_id: f.network_id as string | null,
          email_shared_count: f.email_shared_count as number | null,
          everEnrolled: everEnrolledInbox({ id: f.id as string, email: f.email as string | null }),
        },
        settings,
        now
      );
      if (reason) {
        skipped[reason] = (skipped[reason] ?? 0) + 1;
        continue;
      }
      const r = await enrol(admin, { floristId: f.id as string, sequenceId: "recruit_cold" });
      if (r.ok) enrolled++;
      else skipped[r.reason ?? "enrol-refused"] = (skipped[r.reason ?? "enrol-refused"] ?? 0) + 1;
    }
    return { enrolled, skipped };
  } catch (e) {
    captureError("sequences.enrolNewlyScrapedShops", e);
    return { enrolled: 0, skipped };
  }
}

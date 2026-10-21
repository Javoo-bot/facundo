// Fill /statistics/funnel with a cohort that actually LOOKS like a funnel, so
// the 7d / 30d / 90d views can be compared side by side.
//
//   node scripts/seed-funnel-demo.mjs          # create the fixture
//   node scripts/seed-funnel-demo.mjs --clean  # delete every row it made
//   node scripts/seed-funnel-demo.mjs --report # count what the page will show
//
// WHY THIS EXISTS. /statistics/funnel is a COHORT funnel: the range picks the
// shops whose outreach STARTED in it. Staging's only real cohort is one batch
// of 201 shops enrolled and messaged on the same day through Ongage, which
// reports no delivery feedback at all — so 7d is empty and 30d and 90d are the
// SAME two full rings followed by four zeroes. None of the three shows what the
// page is for. This seeds three bands of shops, one per preset, each with a
// DIFFERENT shape, so switching the range visibly changes the answer:
//
//   7d   a small, healthy, still-in-flight week — good delivery, opens are the leak
//   30d  adds a much larger three-week band whose opens collapse
//   90d  adds an old backlog we mostly never had an address for, so the page's
//        red arrow moves from "Opened it" up to "Message sent"
//
// THE THREE VIEWS ARE NESTED, not separate: 30d contains the 7d band and 90d
// contains both, because that is what the presets actually query. The bands are
// sized so each addition changes the aggregate enough to see, and they are
// placed at days 1-6, 9-28 and 33-88 — inside their preset with a margin, so a
// run that straddles midnight cannot move a shop across a boundary.
//
// SAFETY. Every shop it creates is inert by construction, not by convention:
//   * `excluded_at` AND `deleted_at` are set, which is what match.ts:411,
//     waves.ts and sequences/tick.ts (the "stop the run" check) all read, so
//     these shops can never be matched, offered or mailed;
//   * every enrolment left `active` gets `next_action_at` in 2099, so the
//     sequence tick never even SELECTS it (a row it selected would be stopped
//     on the excluded_at check, which would quietly delete `still_running`);
//   * `email` is app_settings.test_email on every one of them, so the only
//     address in the fixture is the staff sink;
//   * they hang off their own `cities` row, so nothing is attributed to a real
//     market, and `is_test_shop` keeps them out of real matching even if the
//     two hides above were ever cleared.
// Nothing that already exists is read for anything but app_settings, and
// nothing that already exists is written or deleted — including the real 201,
// which stay in the 30d and 90d numbers where they belong.
//
// --clean deletes on the fixture's own markers only: place_id `FUNNELDEMO_%`,
// communications.actor and email_events.provider_event_id.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const clean = process.argv.includes("--clean");
const reportOnly = process.argv.includes("--report");

const PLACE_PREFIX = "FUNNELDEMO_";
const ACTOR = "funnel-demo-fixture";
const EVENT_PREFIX = "funneldemo_";
const CITY = { country: "ZZ", city: "Funnel demo (fixture)" };
/** Far enough out that sequences/tick.ts never selects these rows. */
const NEVER = "2099-01-01T00:00:00.000Z";

// -- credentials ------------------------------------------------------------
const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });
console.log(`-> ${url.replace(/https:\/\/([a-z]{6}).*/, "https://$1....supabase.co")}`);

// -- the bands --------------------------------------------------------------
//
// Each row is a literal shop count, not a rate, because these are the numbers
// that will be on the screen and they should be checkable by hand. The tiers
// below them are derived by subtraction and asserted non-negative, so a typo
// here fails loudly instead of drawing a funnel that widens.
//
// `scanner` are shops whose only click is a corporate link scanner: they have a
// raw `clicked` email event but no `engaged_at`, so they count as "Opened it"
// and as clicked_raw, and NOT as "Clicked the link". That gap is the one thing
// this page can say about a click rate that looks too good, so the fixture has
// to contain it or it can never be demonstrated.
const BANDS = [
  {
    key: "wk",
    name: "this week (in flight)",
    fromDays: 6,
    toDays: 1,
    picked: 120,
    messaged: 114,
    delivered: 106,
    seen: 60,
    clicked: 29,
    joined: 8,
    scanner: 10,
    bounced: 4,
    skipped: 4,
    optedOut: 3,
    running: 88,
  },
  {
    key: "mo",
    name: "days 9-28 (opens collapse)",
    fromDays: 28,
    toDays: 9,
    picked: 600,
    messaged: 552,
    delivered: 480,
    seen: 204,
    clicked: 90,
    joined: 12,
    scanner: 30,
    bounced: 30,
    skipped: 30,
    optedOut: 22,
    running: 90,
  },
  {
    key: "qt",
    name: "days 33-88 (old backlog, no addresses)",
    fromDays: 88,
    toDays: 33,
    picked: 620,
    messaged: 200,
    delivered: 174,
    seen: 112,
    clicked: 54,
    joined: 30,
    scanner: 20,
    bounced: 14,
    skipped: 260,
    optedOut: 18,
    running: 0,
  },
];

/** The disjoint tiers a band's shops fall into, deepest last. Every stage in
 * the funnel is the sum of the tiers below it, which is why the SQL's nesting
 * holds without the fixture having to know about the SQL. */
function tiersFor(b) {
  const t = {
    never: b.picked - b.messaged,
    no_feedback: b.messaged - b.delivered - b.bounced,
    bounced: b.bounced,
    delivered_only: b.delivered - b.seen,
    seen_only: b.seen - b.clicked - b.scanner,
    scanner: b.scanner,
    clicked_only: b.clicked - b.joined,
    joined: b.joined,
  };
  for (const [k, v] of Object.entries(t)) {
    if (v < 0) throw new Error(`band ${b.key}: tier ${k} is ${v} - the counts above are not nested`);
  }
  const total = Object.values(t).reduce((a, n) => a + n, 0);
  if (total !== b.picked) throw new Error(`band ${b.key}: tiers sum to ${total}, picked is ${b.picked}`);
  if (b.skipped > t.never) throw new Error(`band ${b.key}: more skipped (${b.skipped}) than never-messaged (${t.never})`);
  if (b.optedOut + b.running > b.picked - b.joined) throw new Error(`band ${b.key}: more opted-out + running than non-joined shops`);
  return t;
}

// -- deterministic randomness -----------------------------------------------
// Seeded, so two runs of the fixture (or a run after a --clean) produce the
// same spread and a screenshot taken last week still matches the page.
let rndState = 0x5eed1e;
function rnd() {
  rndState |= 0;
  rndState = (rndState + 0x6d2b79f5) | 0;
  let t = Math.imul(rndState ^ (rndState >>> 15), 1 | rndState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (lo, hi) => lo + rnd() * (hi - lo);

const NOW = Date.now();
const DAY = 86400_000;
const iso = (ms) => new Date(Math.min(ms, NOW - 60_000)).toISOString();

const SHOP_WORDS = ["Fleurs", "Blossom", "Petals", "Rosal", "Jardi", "Bouquet", "Camelia", "Verde", "Orquidea", "Lys"];
const SHOP_KIND = ["Floristeria", "Fleuriste", "Blumen", "Flower Studio", "Garden"];

// -- clean ------------------------------------------------------------------
async function wipe() {
  const { data: shops, error } = await db.from("florists").select("id").like("place_id", `${PLACE_PREFIX}%`);
  if (error) throw new Error(`reading fixture shops: ${error.message}`);
  console.log(`  ${shops.length} fixture shops to remove`);

  // Events first: communications.id is their only handle, and deleting the
  // communication would orphan them (the FK is ON DELETE SET NULL, so they
  // would survive, counted against nothing, forever).
  const del = async (table, apply) => {
    const { error: e } = await apply(db.from(table).delete());
    if (e) throw new Error(`deleting ${table}: ${e.message}`);
  };
  await del("email_events", (q) => q.like("provider_event_id", `${EVENT_PREFIX}%`));
  await del("communications", (q) => q.eq("actor", ACTOR));
  const ids = shops.map((s) => s.id);
  for (let i = 0; i < ids.length; i += 200) {
    await del("sequence_enrolments", (q) => q.in("florist_id", ids.slice(i, i + 200)));
  }
  await del("florists", (q) => q.like("place_id", `${PLACE_PREFIX}%`));
  await del("cities", (q) => q.eq("country", CITY.country).eq("city", CITY.city));
  console.log("  clean: done");
}

// -- report -----------------------------------------------------------------
// The same aggregation get_visual_funnel_stats does, run here over the whole
// database. The RPC itself cannot be called from a script - it gates on
// is_email_allowed(), and a service-role connection carries no JWT to check -
// so this is how the fixture is verified against the numbers the page renders.
async function report() {
  const from = new Date(NOW - 95 * DAY).toISOString();

  const page = async (table, sel, apply) => {
    const out = [];
    for (let i = 0; ; i += 1000) {
      let q = db.from(table).select(sel);
      if (apply) q = apply(q);
      const { data, error } = await q.range(i, i + 999);
      if (error) throw new Error(`${table}: ${error.message}`);
      out.push(...data);
      if (data.length < 1000) return out;
    }
  };

  const enrolments = await page("sequence_enrolments", "florist_id, created_at, engaged_at, status, stop_reason", (q) =>
    q.in("sequence_id", ["recruit_cold", "cold_offer_followup"]).gte("created_at", from).order("id")
  );
  const comms = await page("communications", "id, florist_id, status, created_at", (q) =>
    q.or("kind.eq.recruiting,kind.like.recruit.%").gte("created_at", from).order("id")
  );
  const commById = new Map(comms.map((c) => [c.id, c]));
  const events = comms.length
    ? await page("email_events", "communication_id, event_type", (q) =>
        q.gte("occurred_at", from).not("communication_id", "is", null).order("id")
      )
    : [];
  const joined = new Map(
    (await page("florists", "id, joined_at", (q) => q.not("joined_at", "is", null).order("id"))).map((f) => [f.id, f.joined_at])
  );

  const lines = [];
  for (const days of [7, 30, 90]) {
    const lo = new Date(NOW - days * DAY).toISOString().slice(0, 10);
    const cohort = new Map();
    for (const e of enrolments) {
      if (e.created_at.slice(0, 10) < lo) continue;
      if (!cohort.has(e.florist_id)) cohort.set(e.florist_id, { id: e.florist_id, first: e.created_at });
      const c = cohort.get(e.florist_id);
      if (e.created_at < c.first) c.first = e.created_at;
      c.engaged = (c.engaged ?? 0) + (e.engaged_at ? 1 : 0);
      c.live = (c.live ?? 0) + (e.status === "active" || e.status === "paused" ? 1 : 0);
    }
    const inWindow = (comm, k) => new Date(comm.created_at).getTime() >= new Date(k.first).getTime() - 3600_000;
    for (const c of comms) {
      const k = cohort.get(c.florist_id);
      if (!k || !inWindow(c, k)) continue;
      if (c.status === "sent") k.sent = (k.sent ?? 0) + 1;
    }
    for (const e of events) {
      const c = commById.get(e.communication_id);
      if (!c) continue;
      const k = cohort.get(c.florist_id);
      if (!k || !inWindow(c, k)) continue;
      k[e.event_type] = (k[e.event_type] ?? 0) + 1;
    }

    const rows = [...cohort.values()];
    const n = (f) => rows.filter(f).length;
    const messaged = (r) => (r.sent ?? 0) > 0;
    const deliv = (r) => messaged(r) && (r.delivered || r.opened || r.clicked || r.engaged);
    const seen = (r) => messaged(r) && (r.opened || r.clicked || r.engaged);
    const clk = (r) => messaged(r) && r.engaged;
    const jnd = (r) => joined.has(r.id) && joined.get(r.id) >= r.first;

    const s = {
      picked: rows.length,
      messaged: n(messaged),
      delivered: n(deliv),
      seen: n(seen),
      clicked: n(clk),
      joined: n(jnd),
      no_feedback: n((r) => messaged(r) && !r.delivered && !r.opened && !r.clicked && !r.bounced && !r.engaged),
      clicked_raw: n((r) => (r.clicked ?? 0) > 0),
      still_running: n((r) => (r.live ?? 0) > 0),
    };
    const pct = (a, b) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : "--");
    const losses = [
      ["Message sent", s.picked - s.messaged],
      ["Delivered", s.messaged - s.delivered],
      ["Opened it", s.delivered - s.seen],
      ["Clicked the link", s.seen - s.clicked],
      ["Signed up", s.clicked - s.joined],
    ].sort((a, b) => b[1] - a[1]);
    lines.push(
      `\n  ${days}d  picked ${s.picked} -> messaged ${s.messaged} (${pct(s.messaged, s.picked)})` +
        ` -> delivered ${s.delivered} (${pct(s.delivered, s.messaged)})` +
        ` -> opened ${s.seen} (${pct(s.seen, s.delivered)})` +
        ` -> clicked ${s.clicked} (${pct(s.clicked, s.seen)})` +
        ` -> joined ${s.joined} (${pct(s.joined, s.clicked)})` +
        `\n        end-to-end ${pct(s.joined, s.picked)} | worst step "${losses[0][0]}" (-${losses[0][1]})` +
        ` | still running ${s.still_running} | no feedback ${s.no_feedback}` +
        ` | scanner clicks ${Math.max(0, s.clicked_raw - s.clicked)}`
    );
  }
  console.log(lines.join(""));
}

// -- seed -------------------------------------------------------------------
async function seed() {
  const { data: settings, error: sErr } = await db
    .from("app_settings")
    .select("test_mode, test_email")
    .eq("id", 1)
    .single();
  if (sErr) throw new Error(`reading app_settings: ${sErr.message}`);
  if (settings.test_mode !== true) {
    console.error("REFUSING TO RUN: app_settings.test_mode is not true. This fixture is for staging only.");
    process.exit(1);
  }
  if (!settings.test_email) {
    console.error("REFUSING TO RUN: app_settings.test_email is unset, so the fixture has no sink address to use.");
    process.exit(1);
  }

  const { count: existing } = await db
    .from("florists")
    .select("*", { count: "exact", head: true })
    .like("place_id", `${PLACE_PREFIX}%`);
  if (existing) {
    console.error(`REFUSING TO RUN: ${existing} fixture shops already exist. Run --clean first.`);
    process.exit(1);
  }

  // The fixture's own city, so no real market is credited with these shops.
  // Insert-then-fall-back rather than upsert: `cities` unique key is
  // (country, city), but PostgREST cannot infer it as an ON CONFLICT target on
  // this database, and a --clean leaves nothing behind for a second run anyway.
  const city = await (async () => {
    const found = await db.from("cities").select("id").eq("country", CITY.country).eq("city", CITY.city).maybeSingle();
    if (found.data) return found.data;
    const made = await db.from("cities").insert({ ...CITY, center_lat: 0, center_lng: 0 }).select("id").single();
    if (made.error) throw new Error(`creating fixture city: ${made.error.message}`);
    return made.data;
  })();

  // ---- plan every shop in memory first, so a bad band never half-writes.
  const plan = [];
  for (const b of BANDS) {
    const t = tiersFor(b);
    const shops = [];
    for (const [tier, n] of Object.entries(t)) for (let i = 0; i < n; i++) shops.push({ tier, band: b.key });

    // Flags, drawn from the shops that can carry them. A joined shop's run is
    // 'converted' and a bounced one is stopped by the bounce, so neither can
    // also be opted out or still running - the same exclusivity the real tick
    // enforces by writing one terminal status per run.
    const eligible = shops.filter((s) => s.tier !== "joined" && s.tier !== "bounced");
    shuffle(eligible);
    eligible.slice(0, b.optedOut).forEach((s) => (s.optedOut = true));
    eligible.slice(b.optedOut, b.optedOut + b.running).forEach((s) => (s.running = true));
    shops.filter((s) => s.tier === "never").slice(0, b.skipped).forEach((s) => (s.skippedSend = true));

    shuffle(shops);
    shops.forEach((s, i) => {
      s.idx = i;
      s.enrolledAt = NOW - between(b.toDays, b.fromDays) * DAY;
    });
    plan.push({ band: b, shops });
  }

  const all = plan.flatMap((p) => p.shops);
  console.log(`  planning ${all.length} shops across ${BANDS.length} bands`);

  // ---- florists
  const floristRows = all.map((s) => {
    const deep = s.tier === "joined" || s.tier === "clicked_only";
    return {
      city_id: city.id,
      place_id: `${PLACE_PREFIX}${s.band}_${String(s.idx).padStart(4, "0")}`,
      name: `[funnel-demo] ${pick(SHOP_KIND)} ${pick(SHOP_WORDS)} ${String(s.idx).padStart(3, "0")}`,
      // A shop we never messaged mostly never had an address - that is the
      // reason the first step loses anyone at all, so the fixture spells it out
      // rather than leaving an unexplained gap.
      email: s.tier === "never" && !s.skippedSend ? null : settings.test_email,
      has_website: rnd() > 0.35,
      rating: Number(between(3.4, 5).toFixed(1)),
      review_count: Math.round(between(4, 480)),
      is_test_shop: true,
      lifecycle_stage:
        s.tier === "joined" ? "production" : deep ? "engaged" : s.tier === "never" ? "targeted" : "contacted",
      joined_at: s.tier === "joined" ? iso(s.enrolledAt + between(1, 9) * DAY) : null,
      // Inert twice over: excluded_at is what match.ts and the sequence tick
      // check, deleted_at is what every list query checks.
      excluded_at: iso(s.enrolledAt),
      deleted_at: iso(s.enrolledAt),
      enrichment_notes: "Fixture row from scripts/seed-funnel-demo.mjs - not a real shop.",
    };
  });
  const floristIds = await insertChunks("florists", floristRows, "id");
  all.forEach((s, i) => (s.floristId = floristIds[i]));
  console.log(`  florists: ${floristIds.length}`);

  // ---- enrolments
  const enrolRows = all.map((s) => {
    const engaged = s.tier === "clicked_only" || s.tier === "joined";
    const status =
      s.tier === "joined" ? "converted"
      : s.optedOut ? "stopped"
      : s.tier === "bounced" ? "stopped"
      : s.running ? "active"
      : "exhausted";
    const engagedAt = engaged ? s.enrolledAt + between(0.2, 6) * DAY : null;
    return {
      florist_id: s.floristId,
      sequence_id: "recruit_cold",
      status,
      track: engaged ? "reengage" : "cold",
      step_index: s.tier === "never" ? 0 : Math.round(between(1, 3)),
      // An `active` run must never be due, or the tick would select it, see the
      // excluded_at and stop it - silently zeroing `still_running`.
      next_action_at: status === "active" ? NEVER : iso(s.enrolledAt + 7 * DAY),
      engaged_at: engagedAt ? iso(engagedAt) : null,
      last_touch_at: s.tier === "never" ? null : iso(s.enrolledAt + between(0, 7) * DAY),
      touches_email: s.tier === "never" ? 0 : Math.round(between(1, 3)),
      touches_sms: s.tier === "never" ? 0 : rnd() > 0.6 ? 1 : 0,
      stop_reason: s.optedOut ? "opted_out" : s.tier === "bounced" ? "bounced" : null,
      created_at: iso(s.enrolledAt),
      updated_at: iso(s.enrolledAt + 1 * DAY),
    };
  });
  await insertChunks("sequence_enrolments", enrolRows);
  console.log(`  enrolments: ${enrolRows.length}`);

  // ---- communications
  //
  // Day 0 is `recruiting` (the outreach panel's own send, which is what enrols
  // them); later touches are `recruit.<step>`, matching stepKind() in
  // lib/sequences/definitions.ts. Shops that got as far as an open get the
  // day-3 touch too, so the log reads like a sequence rather than one blast.
  const commRows = [];
  const commOwner = [];
  for (const s of all) {
    if (s.tier === "never") {
      if (!s.skippedSend) continue;
      commRows.push(comm(s, "recruiting", "skipped", s.enrolledAt + 4 * 60_000, settings.test_email));
      commOwner.push({ shop: s, role: "skipped" });
      continue;
    }
    commRows.push(comm(s, "recruiting", "sent", s.enrolledAt + 4 * 60_000, settings.test_email));
    commOwner.push({ shop: s, role: "day0" });
    const deep = ["seen_only", "scanner", "clicked_only", "joined"].includes(s.tier);
    if (deep && s.enrolledAt + 3 * DAY < NOW) {
      commRows.push(comm(s, "recruit.t2", "sent", s.enrolledAt + 3 * DAY, settings.test_email));
      commOwner.push({ shop: s, role: "t2" });
    }
  }
  const commIds = await insertChunks("communications", commRows, "id");
  commOwner.forEach((o, i) => {
    if (o.role === "day0") o.shop.day0Comm = commIds[i];
    if (o.role === "t2") o.shop.t2Comm = commIds[i];
  });
  console.log(`  communications: ${commIds.length}`);

  // ---- email events
  //
  // Only the email leg produces these. About one engaged shop in six is given
  // NO email event at all: they are the SMS readers, whose click exists only as
  // `engaged_at`. The SQL proves their earlier stages from that click (choices
  // 2 and 3 in the migration header), and the fixture would not exercise either
  // rule if every reader were an email reader.
  const eventRows = [];
  for (const s of all) {
    if (!s.day0Comm) continue;
    if (s.tier === "no_feedback") continue;
    if ((s.tier === "clicked_only" || s.tier === "joined") && rnd() < 0.16) continue;
    if (s.tier === "bounced") {
      eventRows.push(ev(s.day0Comm, "bounced", s.enrolledAt + between(2, 40) * 60_000));
      continue;
    }
    eventRows.push(ev(s.day0Comm, "delivered", s.enrolledAt + between(2, 20) * 60_000));
    if (!["seen_only", "scanner", "clicked_only", "joined"].includes(s.tier)) continue;
    const openAt = s.enrolledAt + between(0.05, 4) * DAY;
    eventRows.push(ev(s.day0Comm, "opened", openAt));
    if (s.t2Comm) {
      eventRows.push(ev(s.t2Comm, "delivered", s.enrolledAt + 3 * DAY + between(2, 20) * 60_000));
      if (rnd() > 0.45) eventRows.push(ev(s.t2Comm, "opened", s.enrolledAt + 3 * DAY + between(0.05, 2) * DAY));
    }
    // The scanner tier's click is a machine: a raw `clicked` event with no
    // engaged_at behind it. clickQuality.ts is what keeps them out of
    // engaged_at for real; here they are simply never given one.
    if (s.tier === "scanner") eventRows.push(ev(s.day0Comm, "clicked", s.enrolledAt + between(1, 30) * 60_000));
    if (s.tier === "clicked_only" || s.tier === "joined") {
      eventRows.push(ev(s.day0Comm, "clicked", openAt + between(1, 90) * 60_000));
    }
  }
  await insertChunks("email_events", eventRows);
  console.log(`  email events: ${eventRows.length}`);
}

function comm(s, kind, status, at, to) {
  return {
    created_at: iso(at),
    channel: "email",
    audience: "florist",
    kind,
    florist_id: s.floristId,
    to_address: status === "skipped" ? null : to,
    subject: kind === "recruiting" ? "Sell your bouquets to Facundo customers" : "Following up on Facundo",
    body: "Fixture message from scripts/seed-funnel-demo.mjs. Nothing was sent.",
    test_mode: true,
    status,
    provider: "resend",
    provider_message_id: status === "skipped" ? null : `${EVENT_PREFIX}${randomUUID()}`,
    error: status === "skipped" ? "no address on file" : null,
    actor: ACTOR,
  };
}

function ev(communicationId, type, at) {
  return {
    communication_id: communicationId,
    event_type: type,
    occurred_at: iso(at),
    raw: { fixture: "funnel-demo", type: `email.${type}` },
    provider_event_id: `${EVENT_PREFIX}${randomUUID()}`,
  };
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/** Insert in chunks, preserving order, optionally returning one column. The
 * order matters: the caller maps the returned ids back onto its own plan by
 * index, and PostgREST returns an insert's rows in the order they were sent. */
async function insertChunks(table, rows, returning) {
  const out = [];
  for (let i = 0; i < rows.length; i += 250) {
    const slice = rows.slice(i, i + 250);
    let q = db.from(table).insert(slice);
    if (returning) q = q.select(returning);
    const { data, error } = await q;
    if (error) throw new Error(`inserting ${table}: ${error.message}`);
    if (returning) out.push(...data.map((r) => r[returning]));
  }
  return out;
}

// -- run --------------------------------------------------------------------
try {
  if (clean) await wipe();
  else if (!reportOnly) await seed();
  await report();
  console.log("\n  /statistics/funnel - switch 7d / 30d / 90d to see the three shapes above.\n");
} catch (err) {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

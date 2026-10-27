// Order lifecycle — the single source of truth for the `/lifecycle` reference
// map (dashboard/app/(staff)/lifecycle). This is a *documentation* artifact,
// not runtime logic: it describes the Phase-0 order loop (Shopify order →
// matched florist → paid 70/30 against a delivered photo → written back to
// Shopify) as a set of phases, happy-path stages, and the failure branches we
// can think of — each with its dev status, its MVP-vs-later milestone, and both
// a manual (human-first) and an automated handling.
//
// Statuses reflect the roadmap in
// docs/superpowers/plans/2026-07-13-phase0-order-loop-roadmap.md and a code
// inventory of dashboard/ + ingest-worker/. When the code moves, edit HERE —
// the page renders entirely from this file.

/** How built a happy-path stage / branch is. */
export type BuildStatus = "shipped" | "in-progress" | "planned";

/** How a failure branch is dealt with today. `open` = a known way things can
 *  go wrong that we have NOT settled a handling for — a prompt for the team
 *  ("help wanted"). `in-progress` = a handling exists but is still being
 *  hardened (e.g. a manual path works, the automated one isn't durable yet). */
export type BranchStatus = "handled" | "in-progress" | "planned" | "open";

export type StageKind = "start" | "step" | "decision" | "endpoint";

/** MVP = needed to run real orders end-to-end in one city. later = hardening,
 *  scale, extra channels, advanced fraud — valuable but not blocking go-live. */
export type Milestone = "mvp" | "later";

/** A way the happy path can break, and how it's handled. Every branch carries
 *  BOTH a manual (human-first, intuitive) path and an automated one — the
 *  manual path is what CX does today / as a fallback; the automated path is the
 *  system doing it without a click. */
export interface Branch {
  id: string;
  /** What goes wrong. */
  trigger: string;
  /** One-line summary of the handling (shown on the node + drawer header). */
  handling: string;
  /** The manual, human-first handling — what a person does. */
  manual: string;
  /** The automated handling — what the system does without a click. */
  automated: string;
  status: BranchStatus;
  milestone: Milestone;
  plan?: string;
  /** Set on a situation an agent added (agent factory, garden 1.2): the
   *  manager who added it, the day (YYYY-MM-DD), and the general rule whose
   *  near matches it came from — the rule it must sit under in
   *  agents/factory/general-rules.json (checked by general-rules.test.mjs). */
  addedBy?: "harvey" | "donna" | "louis" | "jessica";
  addedOn?: string;
  fromNear?: string;
}

/** One node on the happy path. */
export interface Stage {
  id: string;
  label: string;
  /** One-line gloss shown under the label on the node. */
  short: string;
  kind: StageKind;
  /** Happy-flow dev progress. */
  status: BuildStatus;
  milestone: Milestone;
  /** Roadmap plan that owns it, e.g. "Plan 3". */
  plan?: string;
  /** Where it runs, e.g. "Ingest Worker", "Backoffice", "Florist PWA". */
  surface?: string;
  /** Longer description shown in the detail drawer. */
  description: string;
  /** Real file references so a reader can jump into the code. */
  code?: string[];
  branches?: Branch[];
}

export interface Phase {
  id: string;
  label: string;
  /** Design-system tone token used for the phase accent. */
  tone: "tA" | "tB" | "tC" | "neutral";
  blurb: string;
  stages: Stage[];
}

// ---------------------------------------------------------------------------

export const PHASES: Phase[] = [
  {
    // Upstream of the order loop, and deliberately part of this map: since the
    // cold-offer bridge, recruiting FEEDS the loop directly — a shop that has
    // never spoken to us can be offered a real order. Leaving supply off the
    // map would hide the half of the system that decides whether there is
    // anyone to offer an order to at all.
    id: "supply",
    label: "Supply",
    tone: "neutral",
    blurb: "A shop we discovered becomes a florist who can take an order.",
    stages: [
      {
        id: "recruit-enrol",
        label: "Prospect enters the funnel",
        short: "A discovered shop gets the day-0 email and starts a multi-touch sequence — by staff send, or automatically after an ingest (opt-in).",
        kind: "start",
        status: "shipped",
        milestone: "mvp",
        surface: "Backoffice",
        description:
          "Two doors into the same funnel. (1) Staff select discovered shops on /discovery and send. That send IS touch 1 (from Facundo, branded), and it enrols the shop in the `recruit_cold` sequence starting at step 1 — the tick can never re-send the email they just received. (2) Since 2026-08-19, behind the opt-in `app_settings.sequence_auto_enrol_scraped` (default OFF): the sequence tick itself enrols freshly ingested shops — `found`, with an email, ingested in the last 14 days, never enrolled before — at most 25 per tick, and then sends their day-0 touch itself. This closes the gap ingest-on-empty left open: an uncovered order scraped an area automatically, and then NOBODY wrote to the shops it found until a human noticed the new city on /discovery. It is a sweep in the tick rather than a callback from the worker (the worker cannot reach `enrol()` and its per-inbox dedupe; a sweep also catches a scrape that finished while the switch was off). The tick now also bumps a prospect from `found`/`targeted` to `contacted` on its first successful send, which the manual route always did and the tick never needed to before; mints (or renews) the shop's join token and unsubscribe token before sending — until then the tick only READ them, so an auto-enrolled shop's day-0 had no join button, and the branded shell rendered no unsubscribe link at all (fixed in `lib/emailTemplate.ts`); and the daily cap now counts the manual day-0 sends (`kind='recruiting'`) as well as its own. The funnel's shape lives in typed code (`lib/sequences/definitions.ts`) and its arithmetic in a pure, unit-tested scheduler (`lib/sequences/schedule.ts`); only the words live in the i18n catalog, so the marketing lead can rewrite every angle from /messages with no deploy. Since 2026-09-03 the WAITS are staff-editable too: /flows shows each funnel as an ordered list of steps and writes `sequence_step_timing`, which `lib/flows/timing.ts::applyStepTiming` lays over the code defaults at every point that reads them (the tick, `enrol` parking the next action, and the click re-anchor in `engagement.ts` — all three, because the tick only ever looks at rows that are already due, so a shortened wait applied in one place and not the others would not take effect until the ORIGINAL wait had elapsed). An override can only change a step's `days`; adding, removing, retracking or re-anchoring a step is still a code change, because that is the funnel's shape and the shape is logic. The engine ships DARK: `app_settings.sequence_enabled` defaults false, and the recruiting SMS leg is behind a separate fail-closed toggle. Enrolment is idempotent under a partial unique index, so a double-clicked batch cannot double a prospect's mail.",
        code: [
          "dashboard/lib/sequences/definitions.ts (the funnel: which touches, what spacing, whose voice)",
          "dashboard/lib/sequences/schedule.ts (nextDecision — pure; the caps and the clock)",
          "dashboard/lib/flows/catalog.ts (the three funnels as one screen of data — the only place a sequence and the offer wave are shown as one shape)",
          "dashboard/lib/flows/timing.ts (applyStepTiming — staff-set waits over the code defaults; pure, unit-tested)",
          "dashboard/lib/sequences/timingOverrides.ts (loadStepTiming — the one I/O seam, best-effort)",
          "dashboard/app/(staff)/flows/[funnel]/page.tsx (/flows — one funnel per sub-menu entry)",
          "dashboard/components/flows/FlowEditor.tsx (every step: wait, subject, body, preview, send test)",
          "dashboard/app/api/flows/route.ts (reads the funnels; writes a wait, the response-window ladder and the cut-off offset)",
          "dashboard/app/api/flows/test-send/route.ts (sends one step to app_settings.test_email, through the real composition)",
          "dashboard/lib/recruitingEmail.ts (composeRecruitingEmail — the shell/signature/plain-text half the tick and the test send share)",
          "supabase/migrations/2026-09-03-flow-step-timing.sql (sequence_step_timing)",
          "dashboard/lib/sequences/enrol.ts (enrol / stop / pause / resume)",
          "dashboard/app/api/outreach/send/route.ts (touch 1 + enrolment)",
          "dashboard/lib/sequences/autoEnrol.ts (autoEnrolBlockReason — pure: who enters the funnel on their own)",
          "dashboard/lib/sequences/reconcile.ts (enrolNewlyScrapedShops — the opt-in sweep the tick runs)",
          "dashboard/lib/sequences/tick.ts (runSequences — calls the sweep; bumps found→contacted on first send)",
          "supabase/migrations/2026-08-08-sequence-enrolments.sql",
          "supabase/migrations/2026-08-19-auto-enrol-scraped.sql (sequence_auto_enrol_scraped, default false)",
        ],
        branches: [
          {
            id: "recruit-no-persona",
            trigger:
              "A market has no active outreach persona, so a follow-up signed by a named person has nobody to sign it.",
            handling: "Persona-signed touches are skipped rather than sent unsigned.",
            manual: "Settings → Personas warns which markets have no persona and falls back to the English one for anything that does send.",
            automated:
              "`resolvePersona` returns null and `nextDecision({hasPersona:false})` skips every persona step, ending the run rather than sending a 'personal' email with a blank signature.",
            status: "handled",
            milestone: "mvp",
          },
          {
            id: "recruit-duplicate-shop",
            trigger:
              "The same physical shop was ingested twice under two listings, so it enrols twice and gets everything twice.",
            handling: "Enrolment dedupes on the INBOX, not the row — a second listing sharing an address is refused.",
            manual: "Staff can still exclude a duplicate listing on /discovery, which stops any run on it.",
            automated:
              "`florists` is one row per MAP LISTING, so a chain is several rows sharing one address — on live data 76 addresses are shared and one appears on 33 listings, which without this would put four emails x 33 into a single inbox. The row-level unique index cannot see that (33 distinct ids are 33 legitimately distinct rows), so `enrol()` checks `contactKey` — the normalised address a message is actually delivered to — against every sibling listing with a live run, and refuses with `duplicate-contact`. Case and whitespace are folded; Gmail dots and +tags deliberately are NOT, because for a business address the local part usually means something and wrongly merging two real inboxes silently drops a prospect.",
            status: "handled",
            milestone: "later",
          },
        ],
      },
      {
        id: "recruit-engaged",
        label: "They click something",
        short: "The first click exits the cold track and starts the re-engagement clock.",
        kind: "decision",
        status: "shipped",
        milestone: "mvp",
        surface: "Webhooks",
        description:
          "Engagement is one click on any link, on any channel — not an open (Apple Mail Privacy Protection makes opens noise). It is driven by the WEBHOOKS, not by the cron: the Resend click event for email and the short-link redirect for SMS both call `recordEngagement`. The reason is cancellation rather than send latency — the re-engagement email isn't due for two days, but a florist who clicks at 08:59 must not receive the 09:00 tick's 'just following up, no rush' email. Correctness does not depend on the webhook arriving: the tick re-reads `engaged_at` after claiming a row and before sending, so a dropped event degrades to 'the branch fires a tick late'.",
        code: [
          "dashboard/lib/sequences/engagement.ts (recordEngagement — CAS on engaged_at is null)",
          "dashboard/app/api/webhooks/resend/route.ts (email clicks, bounces, complaints)",
          "dashboard/app/[code]/route.ts (SMS clicks, via the short-link redirect)",
          "dashboard/lib/sequences/schedule.ts (applyEngagement — the pure transition)",
          "dashboard/lib/visualFunnel.ts (the cascade's arithmetic — pure; which step is the leak)",
          "dashboard/app/(staff)/statistics/funnel/page.tsx (/statistics -> Visual funnel: shops per step, and the scanner gap)",
          "supabase/migrations/2026-09-02-visual-funnel-stats.sql (get_visual_funnel_stats — one shop per row, stages nested)",
        ],
        branches: [
          {
            id: "recruit-scanner-click",
            trigger:
              "A corporate link scanner (Outlook Safe Links, Proofpoint) opens every URL in the email, so a machine is counted as an interested human.",
            handling: "A machine's click is stored as an event but never moves the funnel.",
            manual: "CX can stop a run by hand from the florist's page if one still slips through.",
            automated:
              "`isMachineClick` refuses two things: a known scanner user agent (Safe Links, Proofpoint, Mimecast, Barracuda, IronPort, headless browsers, HTTP libraries) and a click landing within five seconds of the `delivered` event — a scanner fires at delivery, while a human has to be notified, unlock a phone, read enough to care, and tap. It FAILS OPEN on absent evidence, because the errors are asymmetric: a missed scanner costs two cold touches for one prospect, while a discarded real click costs the prospect entirely. The user agent is read out of the webhook payload in flight and never stored, so `short_links` keeps its no-IP/no-UA property; SMS needs none of this, since a text does not pass through a corporate mail gateway. The event is still recorded either way — /statistics should be able to show scanner traffic rather than pretend it is not there.",
            status: "handled",
            milestone: "later",
          },
          {
            id: "recruit-bounce",
            trigger: "The address hard-bounces, or the florist marks it as spam.",
            handling: "The run stops immediately; a complaint also opts them out everywhere.",
            manual: "None needed.",
            automated:
              "`recordDeliveryFailure` stops every live enrolment on `bounced`/`complained`, and a complaint additionally sets `order_emails_opt_out` so nothing outside the funnel writes to them either. A funnel that keeps mailing a bounced address is how a sending domain dies — and it would take every transactional order email down with it.",
            status: "handled",
            milestone: "mvp",
          },
        ],
      },
      {
        id: "recruit-tick",
        label: "Follow-ups go out",
        short: "Day 3 and 7 if they never clicked; click+2d and +3d if they did.",
        kind: "step",
        status: "shipped",
        milestone: "mvp",
        surface: "Cron",
        description:
          "A per-minute cron endpoint (`/api/sequences/tick`, fanned out from the ingest worker alongside the outbox drain and the wave tick) asks the pure scheduler what is due. Its own endpoint on purpose: a slow or looping sequence bug must not degrade payout and Shopify-writeback processing, which sharing the outbox drain would risk. Caps are the funnel's own rule — three touches for a prospect who never engages, four emails plus one text for one who does — and they are enforced in the scheduler, so they are executable in a test rather than something you discover three days after a send. Every refusal (opted out, no address, a toggle off) writes a `skipped` communications row with its reason, and still advances the step so a run cannot jam on one unsendable touch.",
        code: [
          "dashboard/lib/sequences/tick.ts (runSequences — claim, resolve, send, record)",
          "dashboard/app/api/sequences/tick/route.ts",
          "ingest-worker/src/index.ts (the cron fan-out)",
          "dashboard/lib/emailTemplate.ts (renderEmailShell — the branded/plain voice)",
          "dashboard/lib/messageVoice.ts (resolveVoiceFor — step override over per-kind default)",
        ],
        branches: [
          {
            id: "recruit-overlapping-ticks",
            trigger: "Two ticks overlap, or a click lands between a tick's read and its write.",
            handling: "A CAS claim on the exact `next_action_at` that was read; only one sender wins.",
            manual: "None needed.",
            automated:
              "The same discipline `lib/waves.ts` uses on `offer_expires_at`: the UPDATE re-checks the value the SELECT saw, so an engagement webhook that just re-anchored the clock cannot be silently trampled by an in-flight tick.",
            status: "handled",
            milestone: "mvp",
          },
          {
            id: "recruit-domain-burn",
            trigger:
              "A bug enrols thousands of discovered florists at once and the funnel tries to mail all of them in one tick.",
            handling: "A daily send cap stops the tick well before the sending domain is affected.",
            manual: "Turn `sequence_enabled` off in Settings; nothing further is sent.",
            automated:
              "`sequence_daily_send_cap` (default 200) is counted against today's sent recruiting communications at the top of every tick, and the run stops when the budget is spent.",
            status: "handled",
            milestone: "mvp",
          },
          {
            id: "recruit-optout-midflight",
            trigger: "A florist opts out (or is excluded, or joins) partway through a sequence.",
            handling: "The next tick stops the run outright rather than skipping one touch.",
            manual: "CX can stop a run from the florist's page.",
            automated:
              "The tick re-reads the florist every time: `joined_at` converts the run, `excluded_at`/`deleted_at` stops it, and the per-channel opt-out and snooze windows are checked before each leg — the same predicates the offer legs already use.",
            status: "handled",
            milestone: "mvp",
          },
        ],
      },
    ],
  },
  {
    id: "intake",
    label: "Intake",
    tone: "tA",
    blurb: "A Shopify order becomes a durable, deduplicated row we can act on.",
    stages: [
      {
        id: "order-created",
        label: "Order created on Shopify",
        short: "Customer checks out; Shopify fires the order webhook.",
        kind: "start",
        status: "shipped",
        milestone: "mvp",
        surface: "Shopify",
        plan: "Plan 3",
        description:
          "The loop begins outside our system: a customer places an order on the Shopify storefront. Shopify emits an `orders/create` webhook to our Worker. Everything downstream is our responsibility.",
        code: ["Shopify Plus app (orders/create, orders/updated, orders/edited, orders/cancelled scopes)"],
        branches: [
          {
            id: "created-not-covered",
            trigger: "Order is for a city / country we don't operate in yet.",
            handling: "If the order is in the working set (see the match stage), a lack of local coverage now requests an ingest job instead of silently escalating — see match-no-candidates-in-radius. Only once delivery time runs out (or ingest can't help) does it fall through to the CX queue.",
            manual:
              "CX sees the uncovered order in the queue and either sources a florist by hand or holds/refunds the customer.",
            automated:
              "Matching requests candidate ingest for uncovered cities while time remains (see match-no-candidates-in-radius); the coverage list still gates intake so a dead end never silently stalls.",
            status: "handled",
            milestone: "mvp",
            plan: "Plan 3",
          },
        ],
      },
      {
        id: "webhook",
        label: "Webhook received",
        short: "POST /webhooks/shopify — HMAC verified, then queued.",
        kind: "step",
        status: "shipped",
        milestone: "mvp",
        plan: "Plan 3",
        surface: "Ingest Worker",
        description:
          "The Worker's fetch handler verifies the Shopify HMAC signature (constant-time compare) and enqueues the raw payload to `orders-queue`, which drives a per-order durable OrderWorkflow. The webhook returns fast so Shopify never times out and retries.",
        code: ["ingest-worker/src/index.ts (POST /webhooks/shopify)", "ingest-worker/src/shopify.ts (verifyShopifyHmac)"],
        branches: [
          {
            id: "webhook-hmac",
            trigger: "Signature is missing or invalid (spoofed / misconfigured secret).",
            handling: "Rejected with 401 before any work — nothing enters the loop.",
            manual: "None needed — the request is refused automatically.",
            automated: "HMAC constant-time compare rejects the call with 401 before any work runs.",
            status: "handled",
            milestone: "mvp",
            plan: "Plan 3",
          },
          {
            id: "webhook-replay",
            trigger: "Shopify redelivers the same webhook, or delivers out of order.",
            handling: "Idempotent upsert means a replay updates rather than duplicates.",
            manual: "None needed — replays are absorbed automatically.",
            automated:
              "Idempotent upsert on `shopify_order_id` + retry-safe workflow steps mean a replay updates, never duplicates.",
            status: "handled",
            milestone: "mvp",
            plan: "Plan 3",
          },
          {
            id: "webhook-missing",
            trigger: "The webhook is never delivered at all (Shopify drop, our outage during the window).",
            handling: "The worker's cron runs an hourly reconciliation sweep: it pulls recent Shopify orders, diffs against our table, and re-enqueues any we never received (idempotent — a later webhook is a no-op). Needs SHOPIFY_SHOP/SHOPIFY_ADMIN_TOKEN set to arm. Admins can also force it on demand.",
            manual:
              "An admin can trigger the sweep immediately from the orders page (“Reconcile now”, admin-only) instead of waiting for the hourly tick — or re-pull a single order from its page (“Re-pull from Shopify”). CX can also still create a missed order by hand from the Shopify admin if the sweep is disarmed (creds unset).",
            automated:
              "`reconcileMissingOrders` (ingest-worker) pulls the last ~2h of Shopify orders each hour, diffs on `shopify_order_id`, and re-enqueues the misses to the same order queue the webhook uses; a throttle claim on `app_settings.reconcile_last_run_at` keeps it ~hourly on the per-minute cron. The on-demand path (`POST /reconcile` on the worker, gated by OUTBOX_SECRET; dashboard `/api/orders/reconcile`, admin-gated) reuses the same function with the throttle bypassed.",
            status: "handled",
            milestone: "mvp",
            plan: "Sprint 1c / Monitoring",
          },
        ],
      },
      {
        id: "intake-parse",
        label: "Parse + persist order",
        short: "Normalize payload → upsert order + line items + first event.",
        kind: "step",
        status: "shipped",
        milestone: "mvp",
        plan: "Plan 3",
        surface: "Ingest Worker",
        description:
          "`parseShopifyOrder` normalizes the raw payload into our schema; `upsertOrder` writes it (conflict target `shopify_order_id`), replaces line items, and appends the first `order_events` row. Unknown fields are stored null with a note — never fabricated.",
        code: ["ingest-worker/src/shopify.ts (parseShopifyOrder)", "ingest-worker/src/db.ts (upsertOrder, replaceLineItems, appendOrderEvent)"],
        branches: [
          {
            id: "parse-malformed",
            trigger: "Required fields missing or malformed (no delivery date, empty address).",
            handling: "Row persists with gaps + a note; surfaces in the backoffice for a human.",
            manual:
              "The order lands with gaps and a 'needs a delivery date' flag; CX fills the missing date/address from the Shopify order before it can advance.",
            automated:
              "Required fields are validated on parse; a malformed order is flagged (not crashed) and blocked from matching until complete.",
            status: "open",
            milestone: "mvp",
            plan: "Plan 3",
          },
          {
            id: "parse-enrichment-wipe",
            trigger:
              "A later re-parse of the REST payload overwrites columns that only the GraphQL variant lookup can fill (line-item photo, recipe, barcode, components/add-ons) — parseShopifyOrder hard-codes them null, and orders/updated fires on ANY mutation.",
            handling:
              "replaceLineItems carries the enriched columns forward across the delete/insert, filling only where the incoming value is null.",
            manual:
              "Staff re-pull the order from the order page ('Import from Shopify'), which runs the variant lookup again and restores the photo.",
            automated:
              "replaceLineItems merges: it reads the stored line items first and preserves image_url, barcode, bouquet_spec, variant_text, variant_icon_url, components and addons when the incoming payload has none — so intake (which does run the lookup) still wins, and every other caller is non-destructive.",
            status: "handled",
            milestone: "mvp",
            plan: "Plan 3",
          },
        ],
      },
    ],
  },
  {
    id: "match",
    label: "Match",
    tone: "tC",
    blurb: "Locate the order and rank the local florists who could fulfil it.",
    stages: [
      {
        id: "geocode",
        label: "Geocode delivery address",
        short: "Address → lat/lng so we can measure distance.",
        kind: "step",
        status: "shipped",
        milestone: "mvp",
        plan: "Plan 3",
        surface: "Ingest Worker",
        description:
          "The delivery address is geocoded (Nominatim, custom user-agent, ≤1 req/sec) to a coordinate. Distance from each florist is later computed with the shared haversine helper.",
        code: ["ingest-worker/src/geocode.ts (geocodeCityCenter, haversineKm)"],
        branches: [
          {
            id: "geocode-fail",
            trigger: "Address is ambiguous or un-geocodable.",
            handling: "Coordinate stored null; scoring guards nulls so it won't NaN.",
            manual: "CX eyeballs the address and assigns a florist manually.",
            automated:
              "Coordinate stored null; scoring guards nulls so distance drops out — the order still matches on other signals.",
            status: "handled",
            milestone: "mvp",
            plan: "Plan 3",
          },
          {
            id: "geocode-ratelimit",
            trigger: "Nominatim rate-limits or is briefly down.",
            handling: "Workflow step is retry-safe and re-runs.",
            manual: "None needed — the step retries itself.",
            automated: "The workflow step is retry-safe and re-runs within the ≤1 req/sec cap.",
            status: "handled",
            milestone: "mvp",
            plan: "Plan 3",
          },
        ],
      },
      {
        id: "match",
        label: "Match florist candidates",
        short: "Hard filters, then weighted score → ranked candidates.",
        kind: "decision",
        status: "shipped",
        milestone: "mvp",
        plan: "Plan 3",
        surface: "Ingest Worker",
        description:
          "Candidates are loaded by GEOGRAPHY — a bounding box around the delivery point sized to the distance cap, across all cities. (It used to be `city_id`, resolved by an exact name match on the delivery address, so an order in an uncovered suburb matched nobody even with florists 3km away.) `matchFlorists` then applies hard filters (test shops, denylist, matchable stage, trust tier, quality floors, distance, capacity) — every `lifecycle_stage` except `lost` is matchable, not just onboarded shops. Ranking is DISTANCE RINGS first, score second: survivors bucket into configurable km rings (default 5/10/20) and a shop in a nearer ring always outranks one further out, however much better it scores. Inside a ring a weighted score decides — onboarded, reachable-by-email, rating/reviews, relationship, trust tier, track record, and distance itself (which softens the cliff at each ring edge). The last ring edge is a HARD CAP that floors each florist's own claimed radius, so a shop claiming 50km is still held to our ceiling and a shop claiming none is treated as covering the cap. Every number here is a runtime knob in `app_settings` (Settings → Matching), loaded via `parseMatchConfig` with per-field fallback so a bad settings row degrades to the compiled defaults rather than matching nobody. The top `topN` are written as ranked `order_assignments` candidates. In **auto** mode the wave engine only auto-sends to an onboarded leading candidate; a non-onboarded prospect at the top of the list is deferred to a human offer approval instead. In **semi** (step) mode the candidates are still written (they contact no one) but the order rests at `received` until CX approves the `match` step — or the `escalate` step when none qualify — from the order page; the worker files that previewed approval instead of auto-advancing to `matched`.",
        code: ["dashboard/lib/match.ts (matchFlorists, passesHardFilter, parseMatchConfig — CANONICAL)", "ingest-worker/src/match.ts (byte-identical generated copy; npm run sync:match)", "ingest-worker/src/db.ts (loadMatchableFlorists — bounding-box load, loadMatchConfig)", "ingest-worker/src/lateMatch.ts (matchAndWriteCandidates)", "ingest-worker/src/autoIngest.ts (ingest-on-empty + re-match after ingest)", "dashboard/lib/rematch.ts (rankForOrder — shared by preview + commit)", "dashboard/app/api/orders/rematch/route.ts (Find florists)", "dashboard/app/api/orders/rematch/preview/route.ts (rank + explain, writes nothing)", "dashboard/components/orders/FindFloristsPanel.tsx (ranking + coverage/scrape-this-area)", "dashboard/app/api/orders/ingest-area/route.ts (manual scrape from the order page)", "dashboard/lib/ingestArea.ts (deliveryArea, parseIngestRequest — pure)", "dashboard/components/settings/MatchingPanel.tsx"],
        branches: [
          {
            id: "match-duplicate-shop",
            trigger: "The same physical storefront exists as more than one florist row and gets offered twice on one order. Ingest upserts on `(city_id, place_id)`, so a shop inside two cities' ingest radii is stored once per city (same `place_id`, different `id`); the backoffice 'Find florists' re-match loads florists across cities, so both records could surface — and the earlier dedupe was by `florist_id` only, which can't tell they're the same shop.",
            handling: "`matchFlorists` now collapses candidates sharing a non-null `place_id`, keeping each shop's best-ranked record, so a single match never lists a shop twice. The re-match route additionally drops any fresh candidate whose `place_id` was already offered on a prior match under a different city's record. The denylist is place-aware too: excluding/restoring one record now toggles every sibling sharing its `place_id`, so a denylisted shop can't keep receiving offers through its other city's record. A null `place_id` can't prove identity, so those rows are never collapsed. (This dedupe masks — it does not clean up — the duplicate florist rows themselves; a data merge, and a one-time backfill of pre-existing partial excludes, stay separate follow-ups.)",
            manual: "None needed for the match itself. Cleaning the duplicate florist records (merging the cross-city rows into one) stays a separate data task.",
            automated: "`matchFlorists` (one canonical file, byte-identical copies enforced by a test) dedupes on `place_id` after ranking, then on normalized email — a second identity the `place_id` rule can't see, since two GENUINELY different storefronts can still share one inbox (see the reachout-wrong-recipient branch). `app/api/orders/rematch/route.ts` also excludes candidates whose `place_id` is already assigned to the order; `app/api/florists/exclude/route.ts` propagates exclude/restore across all rows sharing a `place_id`.",
            status: "handled",
            milestone: "mvp",
            plan: "Order page / duplicate-shop fix",
          },
          {
            id: "match-none",
            trigger: "No florist passes the hard filters — most often nobody within the distance cap.",
            handling: "The order escalates to CX immediately (never waiting on a multi-minute scrape), and the delivery area is queued for ingest so the NEXT order there has somebody. Mode-gated like the rest of the loop: `auto` queues the scrape unattended; `semi` attaches it to the escalate approval, so approving the escalation is what authorises the spend (order_approvals allows one pending row per order, so the ingest can't be its own approval); `manual` records the gap and does nothing. Idempotent: an area already queued/running, or already scraped once, is never re-queued — otherwise ten orders in one uncovered town would fire ten Apify runs for identical data. When that ingest succeeds, orders still `escalated` and still tagged `awaiting_ingest` for that area are re-matched automatically; one CX has already placed by hand has moved on and is left alone.",
            manual: "From the order page CX clicks 'Find florists' — a panel that shows what was considered, each candidate's ring and score breakdown, and lets the rings/floors be loosened for this order only. It also carries a COVERAGE block naming the delivery area, whether we have ever scraped it (and what that scrape found), and a button to scrape it now — highlighted when nothing was in range. That button is how a gap is actually discovered: the automatic path only fires in `auto` mode and only for orders that reach matching at all, so an order held back by the active-tag gate would otherwise never surface its area. 'Add florist' still attaches anyone by hand.",
            automated: "Order auto-escalates to the CX queue, an `awaiting_ingest` event records the area and why, and a successful ingest of that area re-matches it.",
            status: "handled",
            milestone: "mvp",
            plan: "Plan 3 / Order page",
          },
          {
            id: "match-none-garden-planner",
            trigger: "In the garden, nobody is in range and no person is meant to pick the order up.",
            handling: "Garden only: instead of escalating, the worker opens a case for the Planner, which picks a step (reoffer wider, cold offer, ask the client to move the date) and a deterministic executor runs it. Money steps are held by policy with a rule gap.",
            manual: "Nobody, by design. Held cases and rule gaps are read in aggregate (Garden pulse), and the fix goes into a rule or the Planner's thinking file, not into the case.",
            automated: "ingest-worker/src/lateMatch.ts::matchAndWriteCandidates, when `GARDEN_PLANNER=1` on the garden database (ingest-worker/src/planRequest.ts), writes `plan_requested` to `agent_events` (once per case, after any other problem already on it, so a held money question never stops it) and leaves the order at `received`. The dashboard's wave tick runs lib/planRunner.ts::runPendingPlans: lib/planner.ts asks the free-model router for `propose_plan` (see x-planner-model-fails for when it keeps failing), and lib/planPolicy.ts::runPlan carries the step out through lib/approvalExecutors.ts::planStepEffects. Production (switch off) escalates exactly as before.",
            status: "in-progress",
            milestone: "later",
          },
          {
            id: "match-no-coordinates",
            trigger: "The order's delivery address never geocoded, so it has no `delivery_lat`/`delivery_lng`. Distance is now the primary ranking key, so there is nothing to rank by.",
            handling: "The hard filter rejects every florist when the distance is unknown, so the order matches nobody and escalates to CX. This is a deliberate change: before rings, a null distance meant every florist silently CLEARED the radius check and scored distance-zero, so an order we couldn't locate was offered to an essentially arbitrary shop. Refusing to guess is the safer failure. The 'Find florists' panel says so explicitly (422) rather than showing an empty list.",
            manual: "CX fixes the address in Shopify (the orders/updated webhook re-ingests it) or attaches a florist by hand with 'Add florist'.",
            automated: "Escalation only — no guessing. Measured 2026-08-06: 0 of 5,829 florists lacked coordinates, so this fires on the ORDER side, not the florist side.",
            status: "handled",
            milestone: "mvp",
            plan: "Matching rings + cap",
          },
          {
            id: "match-coverage-gap-unseen",
            trigger: "An order lands somewhere we have no florists, but automatic ingest can never fire for it — because the order was filtered out by the active-tag gate (so it never reached matching), or the loop is in `semi`/`manual` mode. Real case 2026-08-06: order #2000017 to Aix-les-Bains, nearest florist 52km away in Grenoble, parked at `received` with `match_skipped` because its tags read `fulfill beepaket` rather than the configured `local-florist`.",
            handling: "The gap is discoverable and actionable from the order page rather than only from an automatic trigger. The 'Find florists' panel always shows a coverage block for the delivery area — never scraped / scraped N weeks ago and what it found / currently running — with a button to scrape it now at the matching cap. A human clicking it may re-scrape an area already covered (`force`), which automatic firing deliberately never does; a job already queued or running still blocks, since a second concurrent scrape of one area is waste rather than a different answer.",
            manual: "CX opens the order, presses 'Find florists', and reads the coverage block. One click queues the scrape; it runs in the background on the per-minute worker cron and does not hold the order up.",
            automated: "None by design — this branch exists precisely for the orders automation cannot see. The scrape itself is the same `ingest_jobs` row the automatic path writes, so it converges with `match-none` from there.",
            status: "handled",
            milestone: "mvp",
            plan: "Matching rings + cap",
          },
          {
            id: "match-ingest-region-collision",
            trigger: "Two real places share a city name in different regions, and the geocode query named only the city. Real case: order #2000031 delivers to San Carlos, Balears (Ibiza) — both the manual 'Scrape this area' button and the automatic ingest-on-empty path built the Nominatim query as `\"San Carlos, ES\"`, which resolved to Nominatim's single top-ranked match: an unrelated same-named village in Castilla y León, ~900km away. `getOrCreateCity` then cached that wrong point forever under the `(country, city)` key, so every subsequent order to the real San Carlos kept finding 0 florists in range.",
            handling: "`ingest_jobs`/`cities` now carry a `region` (widening `cities`' unique key to `(country, city, region)`) plus `near_lat`/`near_lng`. When an order supplies its own `delivery_address.region` and `delivery_lat`/`delivery_lng`, the geocode query is region-qualified AND Nominatim is asked for several candidates (`limit=8`, not 1) so the nearest-to-the-order's-own-point one is picked rather than blindly trusting the top rank — validated live against Nominatim: the region-qualified query alone still landed 44km off (a same-named fortress in Palma), while adding the nearest-of-N pick landed ~0.8km off. A result implausibly far from the reference point (`MAX_GEOCODE_DRIFT_KM` = 150km, generous on purpose — only meant to catch a wrong-city mistake like this one) throws instead of silently caching it. `getOrCreateCity`'s hinted path always re-geocodes (Nominatim calls are free/rate-limited, unlike Apify) and matches on Nominatim's OWN resolved region string, not the hint's wording, so repeated hinted calls for the same real place converge on one row. A job's idempotency check is additionally scoped by region, so a pre-fix `region=''` row that already 'succeeded' for the wrong place never blocks a fresh, correctly-hinted retry. No region/coordinates available (e.g. a manual CLI run with nothing to anchor to) falls back to today's exact single-result behavior — unchanged, no regression.",
            manual: "Staff can force a fresh, hinted re-scrape from the order page's 'Scrape this area' button once an order carries the right region/coordinates; a wrongly-cached pre-fix city row is otherwise left for a future one-off cleanup (not automatically corrected retroactively).",
            automated: "`ingest-worker/src/geocode.ts::geocodeCityCenter` (region-qualified query + nearest-of-N + drift guard), `ingest-worker/src/db.ts::getOrCreateCity` (hinted re-geocode + region-keyed cache lookup), threaded through `workflow.ts`, `cronClaim.ts`, `autoIngest.ts` (both runtimes), and `dashboard/lib/ingestArea.ts`/`autoIngest.ts`. The Python CLI/poller mirror (`ingest/geocode.py`, `ingest/db.py`) carries the identical strategy and constant, since either runtime may claim a queued job.",
            status: "handled",
            milestone: "mvp",
            plan: "Ingest region disambiguation",
          },
          {
            id: "match-ingest-cross-border-shop",
            trigger:
              "A shop inside a city's 20 km radius is in a DIFFERENT country from the city. Every row the ingest builds inherited the city's single country, so the shop got the wrong language and the wrong phone country code. The phone half is silent: order #2000034's florist had the local landline '04 50 00 11 22' parsed against CH, and libphonenumber-js accepts that as a valid Swiss number, storing '+41 45 000 11 22'; Telnyx rejected the SMS. (python-phonenumbers rejects the same input under CH, so the Python ingest was accidentally immune; the Worker was not.)",
            handling:
              "The ingest now parses a shop's phones against the country named in its OWN address and only falls back to the city's country when the address names none (~5% of rows). Existing damage is small and was measured exactly: 13 `phone_web` values, 0 `phone_maps` (Google's numbers arrive already international). Of the 13, 10 reinterpret to exactly the shop's own `phone_maps` and are safe to repair; 3 are a different line (one is a sibling branch's number) and need a person.",
            manual:
              "Data is corrected by migration, never a script: `supabase/migrations/2026-09-16-florist-locale-and-phone-from-address.sql` replaces a `phone_web` with the shop's own `phone_maps` only when both carry the same subscriber digits under different country codes, i.e. same line, wrong prefix (10 rows in production). The 3 wrong-country rows that are a DIFFERENT line from Google's, and 1 malformed '+0' number, are left for a person; the migration's header names the query that lists them. Applied to staging 2026-09-16 (2 rows there); production is applied by a person.",
            automated:
              "`ingest-worker/src/shopCountry.ts::phoneRegionFor` in `buildBareRow`, `buildRow` and `buildRepairPatch`; `ingest/shop_country.py::phone_region_for` in `ingest/main.py`. A regression test pins libphonenumber-js accepting that landline under CH, so an upstream change fails loudly.",
            status: "handled",
            milestone: "mvp",
            plan: "Shop country from address",
          },
          {
            id: "match-ingest-noise",
            trigger: "Places that are not florists at all become match candidates — lottery kiosks, tobacconists, a royal palace garden, streets literally named `Carrer de les Flors`. Two independent causes, found 2026-08-06: (1) the ingest worker's LLM account hit zero credit, and the relevance filter is per-call FAIL-OPEN, so with every call throwing it kept everything — three cities logged \"Nothing filtered\" at 0 LLM calls and $0, reported SUCCESS, and persisted 610 places of which ~62% were not florists; (2) independently of any outage, the free keyword rule is a substring test, and the French keyword `magasin de fleurs` is a prefix of `Magasin de fleurs séchées` — the secondary category every CBD shop carries — so cannabis shops were kept with no LLM call at all.",
            handling: "Both are fixed in `ingest-worker/src/relevance.ts`. The substring leak is settled by Google's PRIMARY category rather than a blocklist: a florist primary keeps the free pass however its secondaries read (plenty of real florists also sell dried flowers), and the non-florist markers only revoke the pass otherwise — and revoke it to LLM judgment, never to a hard drop, since some wholesalers do sell retail and a silent false negative is permanent. For the outage, the per-call policy stays fail-open (one bad call must not soft-delete a real florist) but the RUN now fails: `isRelevanceOutage` flags a total loss or losing more than half a meaningful sample, and the workflow throws rather than persisting an unfiltered city, because \"keep everything\" is indistinguishable in the output from \"nothing needed filtering\".",
            manual: "Staff exclude a bad row from /florists (place-aware, reversible), or re-run the city from /ingest with reset so the fixed filter re-judges it from scratch. A failed job now names the outage instead of reporting success.",
            automated: "Fixed free rule + run-level outage guard in relevance.ts/workflow.ts; cost is reported by OpenRouter per call, so a $0 run is visible on /jobs rather than looking like a cheap one.",
            status: "handled",
            milestone: "mvp",
            plan: "Ingest OpenRouter + noise fix",
          },
          {
            id: "match-ingest-found-nothing",
            trigger: "An ingest queued for an uncovered delivery area completes, but turns up no florist we can use — the area really is empty, not merely unscraped.",
            handling: "The order stays escalated for CX to place by hand. The succeeded `ingest_jobs` row is itself the record: `queueIngestForArea` skips an area that has already been scraped once, so the next order there escalates immediately instead of paying for the same empty scrape again. Re-running it is a deliberate staff action from /ingest.",
            manual: "CX places the order by hand. If coverage is expected to change (a new city launch), staff force a fresh ingest from /ingest.",
            automated: "The re-match runs and finds nobody, so the order is left exactly as it was — no status churn, no repeated spend.",
            status: "handled",
            milestone: "mvp",
            plan: "Matching rings + cap",
          },
          {
            id: "match-untiered-florist",
            trigger: "A florist has no `trust_tier`, so `lib/payout.ts` has no accept/delivery split to apply and cannot pay them for a delivered order.",
            handling: "The hard filter rejects them by default (`requireTrustTier`). This was measured on 2026-08-06 as 5,820 of 5,829 matchable florists — the automatic matcher could reach nine shops across 53 cities, while the backoffice re-match, which had no such gate, reached all of them and could route a real order to a shop we cannot pay. The gate is now uniform across both paths, the untiered rows were backfilled to tier 2, and `trust_tier` has a column default so fresh ingests land tiered. On 2026-08-13 tier 2's payout split was aligned to the pilot policy (70% on accept, 30% after ready-photo) instead of leaving newly-ingested/default florists on the old 50/50 split.",
            manual: "Staff assign a tier on the florist page (the 'Activatable' checklist shows the gap), or knowingly turn the requirement off for one re-match.",
            automated: "Backfill + column default in supabase/migrations/2026-08-06-matching-config.sql; payout-policy alignment for the default tier in supabase/migrations/2026-08-13-tier2-70-30-policy.sql. The filter itself is config-driven and defaults to ON in both the worker and the dashboard.",
            status: "handled",
            milestone: "mvp",
            plan: "Matching rings + cap",
          },
          {
            id: "match-roster-truncated",
            trigger:
              "CX's manual escape hatches from the two branches above ('Add florist', and the staff florist directory they pick from) couldn't SEE most of the roster. PostgREST caps an unbounded `select()` at 1000 rows and returns that page with no error, so every staff read that meant 'the whole florist table' quietly became 'the first 1000 by name'. At ~3.4k florists the cut landed around \"Ex…\": /florists rendered a single row (only one of the 12 `production` florists sorts that early, and the directory defaults to that stage filter), and the order page's picker searched a directory that genuinely did not contain \"Flors Demo\" — or anyone after them — so the fallback for a failed match silently had no reach.",
            handling:
              "Every full-roster staff read is paged to completion. The automatic matcher was never affected — it filters to matchable lifecycle stages in SQL (12 rows), so offers and ranking were always correct; this was a visibility failure in the human fallback path, not a routing one.",
            manual: "Nothing routine — 'Add florist' now searches the entire roster, and /florists lists it.",
            automated:
              "`dashboard/lib/fetchAll.ts::fetchAllRows` pages a query in 1000-row batches until a short page returns, and is used by every remaining whole-table florist read (app/(staff)/florists, orders list mock picker, discovery, home supply-health, payments card picker). Each paged query ends in `.order(\"id\")` — paging over a non-unique sort key alone can duplicate or skip rows tied across a page boundary. The order page's picker no longer reads a fetched-up-front directory at all — it now searches on demand via `/api/florists/options?detail=1` (lib/floristOptions.ts, filtered in Postgres via `q`), so it was never affected by this cap and its reach only grows with the roster.",
            status: "handled",
            milestone: "mvp",
            plan: "Order page",
          },
          {
            id: "match-thin",
            trigger: "Only one or two weak candidates pass.",
            handling: "CX has manual levers (Find more / Add florist); an auto relaxation ladder is later.",
            manual: "CX clicks 'Find more' or 'Add florist' on the order page to widen the net (incl. a specific non-onboarded shop).",
            automated:
              "Matching already reaches non-onboarded florists (ranked below onboarded ones); an automatic relaxation ladder to widen radius → relax the rating floor further, surfacing an 'expect a delay' flag, is later.",
            status: "in-progress",
            milestone: "later",
            plan: "Plan 3 / Order page",
          },
          {
            id: "match-capacity",
            trigger: "Every qualified florist is already at capacity for that delivery date.",
            handling: "Matching now counts each florist's accepted/delivered orders for the delivery date against `capacity_per_day` and drops anyone already full; if that empties the candidate list the order escalates to CX. Cross-city overflow is still future.",
            manual: "CX defers the date with the customer, raises a florist's capacity, or places it manually from the escalation queue.",
            automated:
              "`countAcceptedForDay` buckets same-day accepted/delivered assignments and `passesHardFilter` rejects florists at/over `capacity_per_day` (skipped only when the order has no `delivery_at`). Neighbour-city overflow remains a later add.",
            status: "handled",
            milestone: "later",
            plan: "Sprint 3",
          },
          {
            id: "match-stale-florist",
            trigger: "A matched florist has quietly closed or is away.",
            handling: "Relies on the denylist being kept current.",
            manual: "CX marks the florist closed/excluded and re-runs the match.",
            automated:
              "A 'temporarily closed' toggle + `excluded_at` drop them from live offers automatically and re-match promotes the next candidate.",
            status: "open",
            milestone: "later",
          },
          {
            id: "match-unready-florist",
            trigger: "A florist marked 'production' can't actually receive the order — no delivery radius or no trust tier set (so we can't locate or pay them).",
            handling: "The matcher's hard filter now rejects any florist missing `delivery_radius_km` or `trust_tier`, so real money can't route to a florist who can't be located or paid. The staff florist page shows an 'Activatable' checklist (login + radius + tier) so gaps are visible before go-live. Self-registered florists (dashboard/app/florist/accept) deliberately land in `onboarding`, never `production`, on submit — with one deliberate exception: a florist STAFF add by hand (dashboard/app/api/florists/create, for shops we already work with off-system) carries a trust tier, a delivery radius and a stage chosen by the person adding them, because that person is the vetting pass `production` is meant to signal. The hard filter is not bypassed there either, its inputs are supplied — the same distinction as `buildProvisionalActivation` — the hard filter above already prevents real mis-routing either way, but `production` is meant to signal a staff-completed vetting pass, which a cold self-registration hasn't had.",
            manual: "CX completes the florist's onboarding checklist (login + radius + tier) on the florist page before relying on them; the Activatable badge flags what's missing.",
            automated: "`passesHardFilter` gates on real readiness (radius + tier present), not just `lifecycle_stage`; `lib/floristActivation.ts` computes the login+radius+tier checklist surfaced on the florist page.",
            status: "handled",
            milestone: "mvp",
            plan: "Sprint 3",
          },
          {
            id: "match-order-outside-working-set",
            trigger: "Staff have configured a working set (Settings → Active order tags and/or Working set) and this order is in neither half at create time — commonly because a store app adds the required tag a few minutes AFTER checkout, or because nobody has picked this order by number yet.",
            handling: "Matching is skipped for now (no candidates, no escalation) — the order is still ingested and listed, parked at status 'received'. When the tag lands later it's re-evaluated automatically and the missed match runs; staff can also pull it into the working set from /orders — tick it, or paste its number into “Add orders by number” — to start it immediately, or work it by hand (Find florists / Add florist) meanwhile.",
            manual: "CX can still work the order by hand from the order page (Find florists / Add florist) even though the automatic match skipped it — the gate only stops the *automatic* pass.",
            automated: "`isInWorkingSet` (dashboard/lib/workingSet.ts + ingest-worker/src/workingSet.ts, kept in lockstep — a unit test asserts the two copies have not drifted) gates the worker's match step before it runs. The working set is the UNION of two things: the staff-configured tag set (`app_settings.active_order_tags`) and orders picked explicitly by number (`orders.worklist_at`, set on /orders by ticking rows or pasting a list into “Add orders by number” — available to all staff, not just admins). The gate is OFF only when BOTH are empty, in which case it matches everything; configuring either one turns it on. Late tags are caught two ways, both via `ingest-worker/src/lateMatch.ts::refreshFromShopify`: the `orders/updated` webhook handler (fast path) refreshes the stored tags and runs the late match the instant the tag lands, and the hourly reconcile sweep (`reconcile.ts::selfHealParkedOrders`) re-pulls the live Shopify order for every still-parked one (no candidates yet, created within ~14d, capped per run) and heals any that now qualify — a backstop for a dropped webhook or a backlog that predates this feature. Adding an order to the working set by hand has the same effect immediately, without waiting for a tag. Re-matching only ever fires for an order still at 'received'; a worked order only gets its tags refreshed, never rewound, and REMOVING an order from the working set never rewinds work in flight. An explicit pick is dropped automatically once the order reaches a terminal state (`reconcile.ts::dropFinishedFromWorkingSet`), so the set stays a list of live work. The CX attention queue and the orders-list default view apply the same gate, and the list shows a running count of what the gate is holding back so an empty list is never mistaken for 'no work'.",
            status: "handled",
            milestone: "mvp",
            plan: "Working set (tags + explicit picks)",
          },
          {
            id: "shopify-closed-outside-loop",
            trigger: "The order is fulfilled or archived in Shopify without going through us — someone placed it by hand, or it was archived as done. Ours kept sitting at `received`/`escalated`, holding a pending step-mode approval in the CX queue for work that no longer exists. Hit for real on #2000015, which was fulfilled AND archived in Shopify while we still showed it as unplaced.",
            handling: "Shopify is the truth: our status follows it. A fulfilled or archived order becomes `closed`, a cancelled one `cancelled`, and any pending approval on it is resolved so it drops off the order page. No mirror column — our status IS the fact, and the `shopify_closed` event records which signal fired.",
            manual: "Nothing routine. 'Re-pull from Shopify' on the order page forces it immediately instead of waiting for the webhook or the hourly sweep.",
            automated: "`refreshFromShopify` applies `shopifyLifecycle()` + `orderClosure()` (ingest-worker/src/shopifyLifecycle.ts — pure, table-tested) on every orders/updated webhook and every reconcile pass. Idempotent: an order already `closed`/`cancelled` is a no-op. The late-match leg runs after closure and is gated on status 'received', so a just-closed order is never re-matched.",
            status: "handled",
            milestone: "mvp",
            plan: "Shopify order truth",
          },
          {
            id: "shopify-backlog-unreconciled",
            trigger: "Orders that fell out of sync BEFORE any of this existed. Both healing sweeps are bounded to a ~14d window and capped per tick, so anything older was permanently unreachable — 1,103 of 3,622 orders at the time this landed, with 3,607 sitting open (1,846 escalated, 1,761 received) against a Shopify that had long since fulfilled or archived many of them.",
            handling: "A full-table catch-up sweep, armed deliberately from the orders page (admin). It walks EVERY order oldest-first on the same per-minute cron, in capped batches, and disarms itself at the end. A dry-run mode reports what would change without writing, so a pass that closes orders in the thousands is a decision made on evidence.",
            manual: "Orders page → 'Reconcile all (dry run)' to get the numbers, then 'Reconcile all' to apply; 'Stop full reconcile' aborts mid-pass. Progress and totals show under the toolbar. A single order can still be fixed on its own with 'Re-pull from Shopify'.",
            automated: "`reconcile.ts::reconcileAllOrders` runs each tick when `app_settings.reconcile_all_mode` is set, keyset-paginating on (created_at, id) — the id tiebreak is load-bearing, since bulk imports share a created_at to the microsecond and a timestamp-only cursor would skip the rest of any such group at a batch boundary. Each order goes through the SAME `refreshFromShopify` primitive the webhook and the re-pull use; dry mode calls the identical pure decision (`shopifyLifecycle` + `orderClosure`) and stops before writing, so it cannot drift from the real pass. ~3.6k orders at 60/tick ≈ an hour.",
            status: "handled",
            milestone: "mvp",
            plan: "Shopify order truth",
          },
          {
            id: "shopify-closed-under-florist",
            trigger: "Shopify says fulfilled/archived while one of OUR florists is holding the order (an `accepted`/`delivered` assignment) with an accept-leg payout already issued — two parties think they own the delivery. Hit for real on #2000016.",
            handling: "The Shopify-owned columns are still refreshed (we don't dispute the data), but the workflow is NOT closed automatically — closing would strip a live job out of the florist's app mid-delivery and strand a payout. The order page now surfaces the conflict directly with two one-click outcomes: 'Accept Shopify's truth' force-closes the order (reusing the same CAS+event write the manual stage stepper uses) behind a confirm step that states exactly what stays open — the assignment itself is untouched, so it stays `accepted`/`delivered` in the florist's app and, if the 30% delivery leg hasn't fired yet, they can still upload a delivery photo later and get paid (which also flips the order back out of `closed` to `delivered` — POST /api/florist/photo only checks the assignment, not the order). 'Keep ours' just dismisses the conflict with no status change. Either writes a `shopify_conflict_resolved` marker so the attention queue stops flagging it.",
            manual: "CX clicks 'Accept Shopify's truth' or 'Keep ours' on the order page — one click, no more manually stepping the order through six stage transitions to close it (what happened on #2000016 before this landed).",
            automated: "`orderClosure()` returns `conflict` when an accepted/delivered assignment exists (assignment-based, not status-based — in semi mode a matched order still rests at 'received'). A one-time `shopify_conflict` order event is written, which `dashboard/lib/cxAttention.ts` surfaces as a money-category reason at urgency 82 until a `shopify_conflict_resolved` event exists for the order (`dashboard/lib/shopifyConflict.ts::unresolvedConflictOrderIds`). `POST /api/orders/shopify-conflict/close` (ops/admin) writes that resolution + force-closes via the shared `dashboard/lib/orderStatusWrite.ts::writeOrderStatus` primitive; `POST /api/orders/shopify-conflict/dismiss` (ops/admin) writes only the resolution marker.",
            status: "handled",
            milestone: "mvp",
            plan: "Shopify order truth",
          },
          {
            id: "tags-never-arrive",
            trigger: "An order's tags never reach us, or go stale, once it's left 'received' — the store app tags minutes after checkout, so `orders/create` always writes `tags = null` and we depend on a later `orders/updated` (and on any FURTHER update after that) to keep the column current. If an update is missed (worker deploy gap, dropped delivery, subscription not yet registered) a matched/escalated/cancelled order's tags can freeze permanently — first found as 133 orders stuck on null tags (incl. 7 genuine `local-florist` ones, invisible to the active-tags filter), then again as a second gap where an order that had already picked up ANY tag before the miss stayed stale forever too, since the first fix only rechecked orders with no tags at all.",
            handling: "The hourly reconcile sweep re-pulls the live Shopify ORDER for every one that's left 'received', in ANY status and regardless of its current tags value, and restores every Shopify-owned column — not just tags, so a dropped fulfilment or address edit heals the same way. It can never start work on an already-worked order: the match leg stays gated on status 'received'.",
            manual: "Per-order 'Re-pull from Shopify' on the order page (`reconcileOneOrder`) fixes one immediately; admin 'Reconcile now' on the orders list forces a full sweep.",
            automated: "`reconcile.ts::backfillMissingTags` selects on status alone (`neq('status','received')`, NOT on `tags is null`) within the ~14d window, capped per sweep, and routes each through the same `refreshFromShopify` primitive — whose match leg is gated on status 'received'. It deliberately excludes 'received', which `selfHealParkedOrders` already owns (same pattern: re-check every candidate row, don't try to guess which ones are stale).",
            status: "handled",
            milestone: "mvp",
            plan: "Working set (tags + explicit picks)",
          },
        ],
      },
    ],
  },
  {
    id: "reachout",
    label: "Reach-out",
    tone: "tB",
    blurb: "Offer the order to candidates in turn until one accepts.",
    stages: [
      {
        id: "reachout-send",
        label: "Offer sent to top candidate",
        short: "Offers a florist — manually, on approval (semi), or automatically, by mode.",
        kind: "step",
        status: "shipped",
        milestone: "mvp",
        plan: "Plan 2",
        surface: "Backoffice + PWA",
        description:
          "The reach-out state machine (candidate → queued → sent → opened → declined/accepted) offers the order to the highest-ranked candidate. Every send passes the server-authoritative `test_mode` gate (fails closed) so a review never leaks a real message, and goes through one shared `sendOffer(assignmentId)` helper (binding `offer_expires_at` + a live florist countdown). The global **automation mode** decides who pulls the trigger: **manual** — a human sends each offer (the wave engine only keeps offers fresh + escalates); **semi** — the system PROPOSES each step and a human approves / edits / rejects before it fires; **auto** — the wave engine runs unattended, including the first offer on a freshly-matched order. In **semi** the step-gate now spans the WHOLE loop, not just the offer: match, reassign, escalate, the three customer emails, and the Shopify write-back each file a previewed `order_approvals` row (rendered email in a sandboxed iframe / candidate list / status diff / reason) that CX approves, edits, or rejects from the order page. Payouts are the deliberate exception: since 2026-08-10 the step-gate does NOT cover them, because accepting an order and uploading a delivered photo are the florist's own actions rather than system-initiated steps — see the payout stages. Every side-effect flows through one `gateEffect` seam and one `executeApproval` dispatcher. `advanceWaves()` moves the order on when an offer lapses — the same helper a staff re-send goes through, with its send-time variables resolved once by `resolveOfferVars` so the preview provably cannot drift from the real send. Every florist-facing link in these messages is a **magic link**: the email CTA and the SMS both carry a one-click sign-in token that lands the florist directly on THAT order, signed in. Before this they carried a bare `/florist/orders/<id>` path, which hit the PWA's auth redirect, lost the path, and left the florist on the home screen after a six-digit code — the single worst friction point in the loop, and worst of all on SMS. One token is minted per send and shared by both channels (so one order never puts two credentials into the world), reusable for 30 days (single-use links get burned by corporate link scanners before the human clicks), and individually revocable. Test-mode and preview sends carry an inert sentinel instead — those land in the SHARED staff test inbox, and this link is a LOGIN to a real shop.",
        code: ["dashboard/lib/reachoutSend.ts (sendOffer — shared send)", "dashboard/app/(staff)/page.tsx (the Control panel: the queue, one row, one button)", "dashboard/lib/controlPanel.ts (the button rule + the time-left label)", "dashboard/lib/operator.ts (byDeadline — ranking by the clock)", "dashboard/app/(staff)/orders/[id]/call/page.tsx (the call screen)", "dashboard/components/orders/CallCard.tsx", "dashboard/lib/callCard.ts (rankCallTargets — who is worth phoning, and who is not)", "dashboard/app/api/orders/call-outcome/route.ts (records a refusal taken on the phone)", "dashboard/lib/offerEmailContent.ts (buildOfferEmailContent — offer-email content, factored out for testability)", "dashboard/lib/waves.ts (advanceWaves — mode-gated: send / file approval / refill / escalate)", "dashboard/lib/waveGuards.ts (refillDecision — the two pure stop rules: match_max_waves + cx_reserve_hours)", "dashboard/lib/candidateRefill.ts (refillCandidates — append-mode match, shared with Find florists)", "supabase/migrations/2026-08-20-offer-wave-refill.sql (match_max_waves, cx_reserve_hours, orders.escalation_reason)", "dashboard/lib/effectGate.ts (gateEffect — the semi seam)", "dashboard/lib/approvalExecutors.ts (approve/reject any step)", "dashboard/app/api/orders/approvals/route.ts", "dashboard/components/orders/ApprovalPanel.tsx", "dashboard/components/florist/OfferCountdown.tsx", "dashboard/components/florist/offer/ (the pre-accept offer page the florist decides on — greeting, facts, hero bouquet, card message, payout split)", "dashboard/lib/translations/lineItems.ts (localiseLineItems — cache → Shopify → model, English on any doubt)", "dashboard/lib/translations/content.ts (checkContent — the guards a candidate translation must clear; pure, unit-tested)", "dashboard/lib/translations/shopify.ts (fetchShopifyTranslations — Translate & Adapt reader, drops `outdated`)", "supabase/migrations/2026-08-06-line-item-translations.sql (content_translations + order_line_items.variant_id)", "dashboard/lib/offerItems.ts (splitOfferItems — which line item heroes vs. goes in the also-include strip)", "dashboard/app/florist/unsubscribe/[token]/page.tsx", "dashboard/app/api/florist/unsubscribe/route.ts", "dashboard/app/api/orders/reachout/route.ts (send / accept / decline / escalate / resend)", "dashboard/lib/offerVars.ts (resolveOfferVars — shared read-only send-time variable resolver; the preview's no-drift seam)", "dashboard/lib/lateAccept.ts (acceptBlockReason — the one accept-eligibility predicate, shared by the florist PWA and the accept API)", "dashboard/app/api/orders/reachout/preview/route.ts (renders the real offer email, zero writes)", "dashboard/components/orders/ReachoutPanel.tsx (per-candidate state)", "dashboard/components/orders/SendOfferDialog.tsx (the ONE confirm surface for every offer send — channel checkboxes with pre-flight availability, plus the real rendered email)", "dashboard/lib/offerChannels.ts (emailSkipReason/smsSkipReason — one per-channel predicate shared by sendOffer, renotifyOffer and the preview, so what CX is shown before sending cannot disagree with what happens)", "ingest/networks.py (the network/franchise/directory registry + discovery — why a scraped address is often not the shop's)", "ingest/backfill_networks.py (one-time link + shared-address sweep for florists already ingested)", "supabase/migrations/2026-08-06-florist-networks.sql (florist_networks, florists.network_id / email_shared_count / email_bounced_at)", "dashboard/app/api/webhooks/resend/route.ts (bounce → email_bounced_at)", "dashboard/app/api/webhooks/telnyx/route.ts (SMS delivery receipts → sms_events; permanent failure → sms_undeliverable_at)", "dashboard/lib/telnyxWebhookGuard.ts (Ed25519 signature + the permanent-failure codes that silence a number)", "dashboard/lib/candidateEngagement.ts (per-candidate sent › delivered › opened › clicked › signed in)", "dashboard/components/orders/CandidateProgress.tsx", "supabase/migrations/2026-08-06-sms-events.sql (sms_events, florists.sms_undeliverable_at, get_messaging_stats)", "dashboard/lib/sms.ts (sendSms — Telnyx client)", "dashboard/lib/phone.ts (resolveFloristSmsPhone — E.164 resolution)", "dashboard/lib/offerSmsContent.ts (buildOfferSmsContent — localized SMS body + segment counting)", "dashboard/lib/floristMagicLink.ts (magic-link TTL/validity rules + the test-mode sentinel — pure, unit-tested)", "dashboard/lib/floristMagicLinkMint.ts (mintMagicLink — the one I/O seam)", "dashboard/app/florist/m/[token]/route.ts (redeem: sign in + deep-link)", "dashboard/lib/floristLink.ts (ensureFloristUser — shared by the redeem route and the PWA layout)"],
        branches: [
          {
            id: "reachout-cold-offer",
            trigger:
              "Nobody in the network can take this order — but a discovered shop nearby could, and has never heard of us.",
            handling:
              "Offer it to them for real. The order IS the introduction: accepting it both takes the order and joins them.",
            manual:
              "CX offers a specific non-network florist from the order page. In `semi` this is the only path — the wave engine files an approval rather than sending, which is where cold offers belong until the numbers are trusted.",
            automated:
              "`advanceWaves` gets ONE narrow exception to \"auto never auto-offers a shop we haven't onboarded\", gated by the pure `coldOfferBlockReason`: the settings switch (off by default), a payout ceiling (never cold-offer the expensive order), a six-hour minimum lead time (a stranger has to read an unexpected email, decide, sign in for the first time and buy flowers — a rush order asks all of that), plus contactable and locatable. The assignment is stamped `offer_audience='cold'` before the send so the accept path knows what it is. The magic link already works for a shop with no login: `ensureFloristUser` creates one on redeem.",
            status: "handled",
            milestone: "later",
          },
          {
            id: "reachout-cold-accept-unvetted",
            trigger:
              "A shop nobody has vetted accepts a real order, and we owe them 70% on a company card before they buy a stem.",
            handling:
              "A provisional trust tier: the same 70/30 the copy promised, with a small exposure cap and a held payout above a threshold.",
            manual:
              "The held leg surfaces on the Control panel (/) as a money row, whose button deep-links to `/orders/<id>#payout` — where `components/orders/HeldPayoutCard.tsx` is now mounted (finance/admin only) with Release / Reject against the unchanged `/api/orders/payout/approve|reject` routes. That closes the gap opened when /cx was removed on 2026-08-10: the card and the routes had survived, but nothing rendered the card, so a held accept leg could only be released by calling the API by hand.",
            automated:
              "Accepting mints tier 5 (Provisional — 70/30, photo required, EUR 150 exposure cap) plus a default delivery radius, CAS-guarded so it mints once and never DOWNGRADES a shop that already has a real tier. BOTH accept doors mint it: the florist's own accept (api/florist/respond) and a staff accept-on-behalf (api/orders/reachout `accept`) — the latter added 2026-08-20 after QA found it skipped the mint, leaving the payout split reading a null trust tier; it also matters because in test mode the offer email's magic link is an inert sentinel, so accept-on-behalf is the only way a rehearsal accept can happen at all. Note what this is not: the activation gate is not bypassed, its INPUTS are supplied — afterwards the shop passes exactly the filter every other florist passes. Above `cold_offer_auto_payout_cap_eur` the accept leg parks as `payouts.status='held'`; below it the money moves instantly, because \"we pay 70% before you buy a stem\" is the entire pitch and breaking it would make the email a lie. Lifecycle goes to `onboarding`, never `production` — that stage means a human checked, and none has.",
            // Open 2026-08-10 → handled 2026-09-01: the automated half was
            // always intact; the human release step got its surface back when
            // HeldPayoutCard was mounted on the order page for the Operator
            // panel's "Approve the payment" row to land on.
            status: "handled",
            milestone: "later",
          },
          {
            id: "reachout-stale-magic-link",
            trigger:
              "The florist opens an old message and taps a sign-in link that no longer works — past its 30-day window, or revoked after we learned it had been forwarded.",
            handling: "Bounces to the ordinary sign-in with the order preserved, so it's a detour rather than a dead end.",
            manual:
              "None needed — the florist signs in however they normally would (Google, emailed code, or password) and arrives at the same order. CX can re-send the offer to mint a fresh link if the florist is stuck.",
            automated:
              "`magicTokenBlockReason` (lib/floristMagicLink.ts) is the single authority on validity; the redeem route bounces to `/florist/login?next=<the order>&reason=…`, and the login page honours `next` across all three sign-in methods. The PWA layout does the same for any un-authed deep link, reading the path from the `x-pathname` header middleware sets — so the order is never silently dropped the way it was before.",
            status: "handled",
            milestone: "mvp",
          },
          {
            id: "reachout-decline",
            trigger: "Candidate declines (with a captured reason).",
            handling: "Reason recorded; engine advances to the next-ranked candidate.",
            manual: "CX reads the decline reason and picks the next florist to try.",
            automated: "The reason is recorded and the wave advances to the next-ranked candidate.",
            status: "handled",
            milestone: "mvp",
            plan: "Plan 2",
          },
          {
            id: "reachout-resend",
            trigger:
              "The offer needs sending to the SAME florist again — they declined, or let it lapse, and the reason was ours: their `locale` was wrong so the offer went out in the wrong language, the payout was corrected, or the email leg was off at the time.",
            handling:
              "Staff preview the exact rendered email in the florist's CURRENT locale, then re-send from the order page. The re-open is folded INTO sendOffer's atomic claim (declined / expired / lapsed sent+opened → sent in one CAS), so a concurrent accept or wave tick can't be clobbered on the ASSIGNMENT; a failed send rolls the row back to its exact prior state (status + decline reason/detail + expiry). The claim alone doesn't prove the ORDER is still open, though — the accept action's 'expire the other candidates' sweep deliberately never touches declined/expired rows (they used to be dead ends before resend existed), so a different florist accepting the order during sendOffer's several DB round trips can't be ruled out by the assignment CAS alone. sendOffer re-checks orders.status/deleted_at immediately AFTER the claim wins and BEFORE any email/push goes out, and rolls the claim back (same CAS-guarded rollback) if the order is no longer resend-eligible — the one residual window is an accept landing between that re-check and the send itself, a single round trip, same order of risk as every other CAS in this file.",
            manual:
              "On the order page's reach-out row, 'Re-send' opens a read-only preview — real order, real florist, real locale, real payout, real overrides, zero writes, and no unsubscribe token minted — showing the recipient and a LIVE / TEST-MODE banner. 'Confirm re-send' calls POST /api/orders/reachout {action:'resend'}.",
            automated:
              "Nothing auto-resends to a florist who already said no — a resend is always a deliberate human decision. sendOffer widens its CAS set only when the caller opts in (`{resend:true}`), and the wave engine never passes it. The decline itself survives in an `offer_resent` order_events row (prior status + decline reason/detail/declined_at) even though the assignment columns are cleared so the row is re-claimable.",
            status: "handled",
            milestone: "mvp",
            plan: "Order page",
          },
          {
            id: "reachout-never-received",
            trigger:
              "The offer is still LIVE and the florist says it never arrived — the mail went to spam, the phone number is stale, the push never landed. Re-send deliberately refuses this case (`resendBlockReason` returns 'still-live'), because it exists to resurrect a DEAD assignment: it CASes the row, rewrites expiry, and clears the decline fields. None of that is wanted here — the offer is fine, only its delivery failed.",
            handling:
              "A separate, stateless re-deliver. `renotifyOffer` sends the same offer again on any combination of email / SMS / push, changing NO assignment state: same `offer_expires_at`, same `sent_at`, no claim, nothing to roll back. CX can optionally grant a fresh full reply window, which is the single CAS-guarded write in the whole operation. Because there is no claim to prove the order is still open, the order AND the assignment are re-read immediately before any leg fires — the same sibling-accept guard sendOffer applies after its claim. Without it, a florist accepting during the resolver's several round trips would let us email an offer for an order someone else already holds. A 2-minute per-channel cooldown stops a repeat-clicked button turning into a mailbomb.",
            manual:
              "On the order page's reach-out row, a live offer shows 'Send again': tick the channels, optionally 'give them a fresh window', confirm. The outcome is reported per channel ('email sent, SMS skipped — no phone on file') rather than as one opaque success. Since 2026-08-06 CX no longer has to take the florist's word for it: each candidate carries an engagement trail (sent › delivered › opened › clicked › signed in) built from the Resend and Telnyx delivery receipts, the SMS short-link hit count, and magic-token redemption. `sent` used to mean only 'we handed it to a provider', so a florist who never received the offer looked identical to one who read it twice and ignored it — opposite problems, one ours to fix and one not.",
            automated:
              "`lib/reachoutRenotify.ts::renotifyOffer`, gated by `lib/reachout.ts::renotifyBlockReason` — the exact COMPLEMENT of `resendBlockReason` for sent/opened, so every assignment state is owned by exactly one of the two actions and neither can silently claim the other's case (lib/reachout.test.mjs asserts that partition directly). A WITHDRAWN offer is excluded from re-notify and handed to Re-send instead, whatever its expiry says: re-delivering an offer the florist cannot accept is what produced the silent dead end this branch's sibling (`reachout-withdrawn`) describes, and 'give them a fresh window' made it self-perpetuating by keeping Re-send permanently hidden behind 'still-live'. Nothing auto-renotifies; it is always a deliberate human action.",
            status: "handled",
            milestone: "mvp",
            plan: "Order page",
          },
          {
            id: "reachout-timeout",
            trigger: "Candidate doesn't respond before the offer times out.",
            handling: "A binding per-offer expiry (urgency-scaled, editable in Settings → Offers and on /flows → Local florist assignment) lapses the offer and the wave engine auto-promotes + sends the next candidate on a cron tick. Lapsing moves the order on but does NOT close the door on the original florist — see the late-accept branch. CX still sees stalled/cold waves in the Attention queue as a backstop.",
            manual: "The CX 'Attention' queue flags any order with a stalling offer (SLA breached) or a cold wave (no live offer); CX can advance/reassign by hand if the automatic pass can't (e.g. no valid test email).",
            automated:
              "Every offer is sent with a binding `offer_expires_at` (= now + the urgency tier's window, read from `app_settings.offer_window_*_min` — 15/30/60/120 min by delivery lead time by default, and settable by Ops on /flows → Local florist assignment alongside the `cx_reserve_hours` cut-off offset, so neither number needs a developer). `advanceWaves()` runs each minute: it expires lapsed offers (CAS-guarded on status AND re-checking `offer_expires_at`, so a same-instant accept — or a staff re-send that just wrote a fresh expiry — always wins), auto-promotes + sends the next-ranked candidate, and escalates when the list is exhausted or the delivery deadline has passed.",
            status: "handled",
            milestone: "mvp",
            plan: "Plan 2",
          },
          {
            id: "reachout-late-accept",
            trigger:
              "A candidate answers after their offer window lapsed — but nobody else has taken the order, it isn't past the point of delivering, and we haven't pulled the offer. Before this, `expired` was a closed door: the accept was refused even on an order sitting in the CX queue precisely because nobody wanted it. An explicit `declined` was meanwhile still re-acceptable, so the weaker signal was treated more permissively than the stronger one.",
            handling:
              "`expired` now means 'the response window lapsed', not 'closed'. A lapsed offer stays acceptable while the order is unclaimed, un-withdrawn, and outside a configurable buffer before delivery — and accepting an escalated order pulls it back out of the CX queue.",
            manual:
              "CX can still accept on the florist's behalf from the order page, or re-send to mint a fresh window. Withdraw is how they take a specific lapsed offer off the table instead.",
            automated:
              "`lib/lateAccept.ts::acceptBlockReason` is the single authority, shared by the florist PWA's Accept button and `POST /api/florist/respond` so the two can never disagree: it admits `candidate|queued|sent|opened|declined|expired` on an order that is `matched|reaching_out|escalated`, refusing a withdrawn offer or one inside `app_settings.late_accept_buffer_hours` of `delivery_at`. `escalated` is in the accept CAS, so a late yes clears the escalation and files a `late_accept` order event for CX. The order-level CAS is still what resolves a race with a freshly-promoted candidate — first writer wins.",
            status: "handled",
            milestone: "mvp",
            plan: "Plan 2",
          },
          {
            id: "reachout-withdrawn",
            trigger:
              "CX needs a specific offer off the table — wrong florist, a side-channel refusal, a change of plan — now that a lapsed offer no longer closes itself.",
            handling:
              "A staff Withdraw action stamps `order_assignments.withdrawn_at`, which the accept predicate refuses on. A still-open offer is also closed so the wave engine promotes the next candidate. A withdrawal is reversible by re-sending the offer — Re-send clears the stamp as part of its claim, so the offer goes back on the table properly rather than as a live-looking offer the florist can't accept.",
            manual:
              "Reach-out row → Withdraw, on any candidate that hasn't accepted. The row then shows a 'withdrawn' marker with the timestamp. Declining on the florist's behalf is no longer necessary (and would put words in their mouth + skew the decline stats).",
            automated:
              "`POST /api/orders/reachout {action:'withdraw'}` CAS-writes `withdrawn_at` (a second withdraw 409s), then CAS-moves an offer still in `candidate|queued|sent|opened` to `expired`, leaving an already-terminal one's status alone. Writes an `offer_withdrawn` order event with the prior status. Deliberately not a new assignment status, so the status check constraint and every switch over status stay untouched. Because `expired` is resendable, `lib/reachoutSend.ts::sendOffer`'s resend claim nulls `withdrawn_at` (and `rollbackClaim` restores it if the send then fails) — otherwise Withdraw → Re-send left a `sent` offer carrying a stale stamp, which `lateAccept` refuses on, so the florist got a real offer email and a detail page with no Accept button.",
            status: "handled",
            milestone: "mvp",
            plan: "Plan 2",
          },
          {
            id: "reachout-exhausted",
            trigger:
              "Every candidate declines or times out — while the city still holds shops nobody asked. A match writes only the top `match_top_n` (3) candidates, so the pre-refill engine escalated after 3 silent shops even where 28 contactable florists sat inside the 20km cap (measured on #MOCK-9204, York, 2026-08-20).",
            handling:
              "The wave engine REFILLS instead of escalating: it ranks the next `match_top_n` untried florists and keeps working down them, wave after wave, until a guard stops it. A human is pulled in only when the loop genuinely runs out — of shops, of waves, or of time — and the escalation now says WHICH, because those need different responses.",
            manual:
              "CX takes over and places the order directly. On a `wave_ceiling` escalation untried shops remain, so the useful action is often to grant more waves (raise Settings → Matching → Maximum waves, or press Find florists) rather than placing it by hand.",
            automated:
              "`advanceWaves()` calls `lib/candidateRefill.ts::refillCandidates` before escalating, which ranks via the same `lib/rematch.ts::rankForOrder` the Find-florists panel uses — excluding every florist, physical shop AND inbox already tried on this order, continuing the rank numbering, and reusing the payout price the first match locked in so wave 5 can't offer different money than wave 1. Two pure guards in `lib/waveGuards.ts::refillDecision` bound it: `match_max_waves` (default 4, so 12 shops) and `cx_reserve_hours` (default 2) — the engine refuses a wave whose response window would end later than `delivery_at` minus the reserve, so CX inherits the order with time left to place it. Windows shorten as delivery nears (the urgency ladder is re-read per offer), so a late order automatically fits more attempts into what remains. AUTO MODE ONLY: in `manual` the engine never sends, so refilling would grow a list nobody offers; in `semi` the escalation is itself the approval CX is being asked to make. `orders.escalation_reason` records pool_exhausted / wave_ceiling / candidates_exhausted / out_of_time / past_delivery_deadline / accept_sla_breach_no_candidates and drives a distinct CX desk row + urgency (`lib/cxAttentionRules.ts`). A refill that actually ADDS someone also returns the order to `matched` and clears `escalation_reason` (`lib/orderStatus.ts::statusAfterRefill`), CAS'd on the status it ranked against. Until 2026-09-01 it only nudged `received`, so an order refilled from the Find-more-florists button stayed `escalated` — and `advanceWaves` selects on matched/reaching_out, so it never looked at that order again and the fresh candidates were never offered to anyone.",
            status: "handled",
            milestone: "mvp",
            plan: "Plan 2",
          },
          {
            id: "reachout-exhausted-garden-planner",
            trigger: "In the garden, the refill guards stop and the list has run out, with no person to place the order.",
            handling: "Garden only: the wave engine asks the Planner instead of escalating. It can reoffer further out than the usual cap, cold-offer a shop outside the network, or ask the client to move the date; after 3 plans this problem is held with a rule gap rather than looping. Holding is per problem: a later, different problem on the same order (a florist question, the client writing in) is still planned.",
            manual: "Nobody, by design: the rule gaps are read in aggregate and fixed in rules or the Planner's thinking file.",
            automated: "lib/waves.ts calls lib/caseEvents.ts::requestPlan at the escalation point when lib/plannerSwitch.ts::plannerEnabled; lib/planRunner.ts plans and executes from the case log, and a failed step re-opens planning with the failure in the reason. A request that cannot be written falls through to the normal escalation.",
            status: "in-progress",
            milestone: "later",
          },
          {
            id: "reachout-nobody-answers-phone",
            trigger:
              "The offers went out and nobody replied either way. Email has done all it can; the order still has no florist, and the next useful act is a phone call — which is a judgement about WHICH shop to ring, made from evidence the row cannot show.",
            handling:
              "The Control panel routes that one row to a screen built for it (`/orders/[id]/call`) rather than to the order page: one shop, its number, and the three things a call can end in. Who it puts on the card is decided, not browsed — the warmest shop still in limbo.",
            manual:
              "CX rings the number on the card and records the outcome. Accepted hands off to the same `/api/orders/reachout` accept the rest of the loop uses (payout leg, write-back, comms). Refused takes a reason from the same six codes the florist-facing decline buttons write, so a call-sourced and a self-service refusal stay comparable in `lib/opsStats.ts::bucketDeclineReasons`. Either way the operator lands back on the queue, which recomputes what the order needs next.",
            automated:
              "`lib/callCard.ts::rankCallTargets` picks the subject: only shops in `CALLABLE_STATUSES` (sent / opened / expired — asked, and silent since; plus accepted/delivered, who hold the order), ordered by warmth (signed in › clicked › opened › delivered › sent), then distance, then match rank so the card never shuffles between renders. A shop that DECLINED is excluded outright, not ranked last: it has answered, and with the payout fixed there is no lever left to reopen it with, so offering that call could only annoy a shop we still want. A shop never contacted is excluded too — there is no offer to ring about. `POST /api/orders/call-outcome` records the refusal on the assignment itself for any status in `CALL_DECLINABLE_STATUSES` — the reachout guard PLUS `expired`, which is the usual state of a shop worth phoning; before 2026-09-02 a refusal on a lapsed offer reached an events row and nothing else, so every reader (the call list, the shop's history, the Operator row's counts, decline stats) still believed that shop had never answered.",
            status: "handled",
            milestone: "mvp",
            plan: "Plan 2",
          },
          {
            id: "reachout-call-no-answer",
            trigger:
              "Nobody picks up. The operator has spent the call and learned something real — this shop is not reachable right now — and there is nowhere to put it.",
            handling:
              "Recorded as a `call_no_answer` event, which buys two things: the shop drops below the untried ones for a cooldown whose length tracks the order's urgency, and the card tells the next operator when it was last rung. The assignment's status is deliberately untouched — the shop has told us nothing, so nothing about them has changed.",
            manual:
              "Pick 'No answer' and go back. On the next visit the card reads 'You called 20 minutes ago — nobody answered. This is call 3.' ABOVE the phone number, because it is the one fact that should change whether you dial at all.",
            automated:
              "`lib/callCard.ts::callBackGapMinutes` reuses the offer window's own tiers (6h/24h/72h by delivery lead — the same judgement about how much time there is to be patient with): 10 minutes on a rush order, two hours on one four days out. `rankCallTargets` SORTS a shop inside its gap below the untried ones rather than filtering it, so an order where every shop is on cooldown still puts the best one on the card with the last-call line attached — an empty screen would be a worse answer than a judgement call, and that dead end is what this branch existed to record. Not an app_settings row yet, on purpose: a number nobody has calibrated should not arrive looking calibrated.",
            status: "handled",
            milestone: "mvp",
            plan: "Plan 2",
          },
          {
            id: "reachout-refill-cold-exposure",
            trigger:
              "Refilling works down a city, and after the onboarded shops are spent every further wave goes to a shop that has never onboarded — so one unanswered order can cold-mail most of the florists in an area.",
            handling:
              "Each of those offers is still an individual cold offer and passes the existing cold-offer gate (`cold_offer_enabled`, the payout ceiling, the minimum lead time, contactable + locatable), so nothing unsafe is sent. What is NOT yet bounded is the aggregate: no cap on how many never-onboarded shops a single order may introduce itself to, and no coordination with the Recruiting funnel, which may be mid-sequence with the same shops.",
            manual:
              "Lower Settings → Matching → Maximum waves to bound the blast radius, or turn cold offers off entirely, until the aggregate rule exists.",
            automated: "None yet — per-offer gating only.",
            status: "open",
            milestone: "mvp",
            plan: "Plan 2",
          },
          {
            id: "reachout-comms-fail",
            trigger: "The push or email itself fails (bounced email, dead push subscription).",
            handling:
              "Three channels are sent together as a hedge — email (authoritative), web push, and SMS. A florist with a bounced address and a dead push subscription is still reachable by text. The SMS and push legs are best-effort: neither can roll back the atomic assignment claim, so a Telnyx or push outage never re-opens an offer that was successfully emailed.",
            manual: "CX phones the florist directly if all three channels fail.",
            automated:
              "sendOffer() sends email + push + SMS. SMS is gated by app_settings.sms_offer_enabled (fails CLOSED — ships dark) and by the florist's own SMS opt-out, tracked separately from the email opt-out. A hard bounce now feeds back: the Resend webhook stamps `florists.email_bounced_at`, and every later offer skips that florist's email leg and hedges to SMS + push instead of re-sending into a dead mailbox. Narrowly scoped so a good address is never silenced — permanent bounces only (a temporary one is a full mailbox), florist-audience non-test sends only, and only while the florist's CURRENT address still equals the one that bounced, so a staff correction landing before a retried webhook isn't condemned. SMS gained the same feedback loop on 2026-08-06: Telnyx delivery receipts land in `sms_events` via app/api/webhooks/telnyx, and a PERMANENT failure (Telnyx's own do-not-retry codes only — a temporary failure is a phone that is off) stamps `florists.sms_undeliverable_at` so we stop texting a number that cannot receive texts. That mattered more than it looks: suppressing the email leg for the 364 florists on a network's address made SMS their primary channel, and it was the one channel we could not measure. Dead-push detection is still future work.",
            status: "handled",
            milestone: "mvp",
            plan: "Plan 2 / Plan 4",
          },
          {
            id: "reachout-wrong-recipient",
            trigger:
              "The address on the florist row is well-formed and deliverable, but it is not that SHOP's — it is the head office of a network, franchise or chain whose site hosts the shop's page, or a trade-association address belonging to an unrelated member. Ingest scrapes `email` from `website_url`, and for these shops that URL is a profile page on somebody else's site. Measured 2026-08-06: 207 of 984 email-having florists (21%) held an address shared with another florist; 242 sit on a known network's domain. One Issy-les-Moulineaux order sent FOUR offers to contact@reseau-demo.fr, each naming a different Paris shop, and none of the four shops that could have delivered ever saw it.",
            handling:
              "Three layers, because each catches what the others can't. (1) MATCHING collapses candidates who would be emailed at the same address, so an un-diagnosed shared inbox can never receive N copies of one order. (2) The FLAGS say the address isn't this shop's — `network_id` (a first-class `florist_networks` entity, so a network is also visible as a partnership lead rather than just an error), `email_shared_count > 1`, or `email_bounced_at`. A flagged florist is NOT dropped from matching: the shop is real, wants the order, and its Maps-sourced phone number was correct in every case observed, so only the email leg is suppressed and the offer hedges to SMS + push — the same shape as an email opt-out. (3) INGEST stops creating them: a florist whose website is on a registered network domain is linked at write time, and the extraction prompt now refuses head-office/association addresses outright, returning null rather than a plausible wrong answer.",
            manual:
              "The send-confirm dialog names the reason before CX sends ('the address on file is the network's head office, not this shop'), so it reads as a known data gap rather than a silent missing channel. `backfill_networks.py --dry-run` reports which florists would be linked and which unregistered domains look like networks; confirmed ones are added to networks.py::SEED_NETWORKS by hand, because telling a genuine network from a coincidence needs somebody to look at the site.",
            automated:
              "matchFlorists dedupes by normalized email after the place_id collapse (both copies, lockstep-guarded by a test); emailSkipReason returns florist-email-is-network / -shared / -bounced ahead of the opt-out checks and regardless of test-mode redirection, so a test send reports the same unreachability a live one would; ingest links networks via db.sync_network_registry and re-scores shared addresses globally via db.sweep_shared_emails at the end of every run (global, not per-city — the shops sharing an address are usually in different cities).",
            status: "handled",
            milestone: "mvp",
            plan: "Plan 2",
          },
          {
            id: "reachout-candidate-unreachable",
            trigger:
              "Every channel is closed for the LEADING candidate, so the offer reaches nobody: the email leg is suppressed (the address is a network's, shared, or bounced — see reachout-wrong-recipient), the SMS leg has no usable number or none is configured, and there is no push subscription. Found by QA/A2 on 2026-08-21: order #A2-D-7465 sat at `matched` for 90 minutes having offered nobody, while a perfectly reachable florist waited one rank below. The suppression layers that make a wrong address safe are exactly what creates this — they close channels one at a time until, for some shops, none is left.",
            handling:
              "Treat it as a property of that CANDIDATE, not a failure of the order: close the dead candidate and offer the next rank in the same tick. Before this, the engine counted it as a generic send failure and moved to the next ORDER, so the order retried the same unreachable shop every minute forever — never reaching rank 2, never escalating, and writing a skipped-email + skipped-SMS `communications` pair per tick (~2,900 rows/day). It was not invisible (`matched` is in cxAttention's NEEDS_PLACING) but sat at urgency 40, indistinguishable from an order about to be offered normally, and only rose once the delivery window had already passed.",
            manual:
              "The skip is recorded as an `offer_skipped` order event naming the florist and the channel reason, and the per-channel detail is on the `communications` rows, so CX can see the shop was never contacted rather than assuming it ignored us. The candidate's row reads `expired`, which is reused deliberately — every consumer already treats it as 'this candidate's chance is over' — so the event is what carries the distinction.",
            automated:
              "lib/offerChannels.ts::floristUnreachable is the single rule, and its two halves are both load-bearing. A channel that was ATTEMPTED and failed at the provider is transient and affects everyone, so it never counts (the Val-de-Moder case: Telnyx ran out of funds and 15 candidates would have been burned in one tick). An all-environmental block — offers switched off, no test address — is our outage, so the order sits and escalates for a human rather than eating the list. One shop-specific block on the channels that remain is enough, which is what makes the asymmetric case work: this shop's address is a dead end while SMS is unavailable to everyone, so the next shop's address may well be fine. lib/waves.ts walks at most UNREACHABLE_SCAN_LIMIT (5) candidates per order per tick, closing each with a CAS on the sendable statuses; a longer run of unreachable shops simply continues on the next tick, and `WaveResult.skipped` counts them.",
            status: "handled",
            milestone: "mvp",
            plan: "QA/A2",
          },
          {
            id: "reachout-sms-cost",
            trigger:
              "Every offer SMS bills as THREE segments. Measured on the current copy: en 372, es 385, fr 402, de 384, it 395 characters, against a 160-char first segment and 153 per segment after. The cause is the two links — a 77-char magic URL and a 109-char unsubscribe URL — which are 186 characters of the message before a word of copy.",
            handling:
              "Our own shortener. Both SMS links become `https://bo.fc.example.net/<10-char>` (36 chars), taking every locale to TWO segments — roughly a third off every offer SMS. Deliberately SMS-only: in email the URL sits behind a CTA button, where shortening buys nothing and costs the recipient the ability to hover-preview a real fc.example.net destination. The magic token itself is unchanged and still minted once per send by resolveOfferVars, so email and SMS cannot drift onto different credentials — the SMS simply presents the same URL shortened. ONE segment is not reachable and is not the goal: the copy alone is ~216 characters before any URL.",
            manual: "Nothing routine. `short_links.hit_count` shows whether a florist ever opened the link (awaited on the redirect, not fire-and-forget — a floating promise is cancelled when the Worker isolate tears down, which shipped as a silent no-op and was caught only by testing against production), which separates 'never saw it' from 'saw it, ignored it' when chasing a silent candidate.",
            automated:
              "`lib/shortLink.ts` generates 10-char base62 codes from crypto randomness with rejection sampling (the code fronts a login, so it IS a credential; `byte % 62` would bias the first 8 symbols). `lib/shortLinkMint.ts::shorten` writes the row and FALLS BACK to the full URL on any failure — a long link costs a segment, a missing link costs the order. `app/[code]/route.ts` resolves it with a 302 + no-store (never 301: a shared cache must not pin a credential) and an identical 404 for unknown and malformed codes. Root-mounted, which buys two characters per link; the cost is that `operations` and `statistics` are themselves exactly 10 base62 characters, so `generateShortCode` refuses to mint any code matching a staff segment (a code that collided would be shadowed by the staff page and the link permanently dead). `lib/offerSmsContent.test.mjs` pins the 2-segment budget in all five locales, so a future copy edit fails the build instead of quietly raising the bill.",
            status: "handled",
            milestone: "mvp",
            plan: "URL shortener",
          },
          {
            id: "reachout-order-content-untranslated",
            trigger:
              "The offer page's CHROME is localised into six languages, but everything that comes from Shopify — the product name, the bouquet recipe, the components and add-on lists — has always rendered in the shop's primary locale. A florist in Girona opens an offer and reads '12 Freedom rose 50cm' in English, then has to work out what to buy. Worse, Shopify's own translations are not automatically safe to serve: measured across the 143 recipe-carrying variants in our 1000 real production line items, 6 of the 120 translated ones are flagged `outdated` (one says 15 roses where the English says 12, and drops the Lindt box and the vase entirely), and the rose cultivar 'Freedom' is machine-translated as the noun in 10/21 fr, 14/21 de, 11/21 it and 18/27 pt-BR — producing 'Roses de la liberté' and 'Róż wolności', flowers no wholesaler stocks.",
            handling:
              "The florist reads the order in their own language, from Shopify's translations where they exist and are trustworthy, and from a cached model draft where they don't. Five fields: the product title, the VARIANT name (‘Best Value - Deluxe’ → ‘De luxe’ — a PRODUCT_OPTION_VALUE, reachable from the product id, so it resolves even on rows imported before we stored `variant_id`), the recipe, the components and the add-ons. `variant_text` is deliberately not among them: it is customer-facing upsell copy for our own storefront (‘Excellent! You are gifting premium flowers with FREE vase, teddy bear and greeting card included!’), not an instruction to the florist, and it is no longer rendered in the florist app at all. Anything that fails validation stays ENGLISH — because a florist who reads English builds the right bouquet slowly, while a florist who reads a wrong stem count builds the wrong bouquet.",
            manual:
              "The cultivar mistranslations are Shopify-side data and the durable fix is merchandising's: correct them once in Translate & Adapt and every locale improves at the source. Until then a mangled name is detected and routed to the model rather than shown. `content_translations.provider` says which source answered each string, and `source_text` what it was translated from, so a florist's complaint is traceable to an exact row.",
            automated:
              "`lib/translations/lineItems.ts` resolves each field through three sources in order — the `content_translations` cache, Shopify's Translate & Adapt copy, then one batched OpenRouter call for the remainder — and writes the misses back so each string is paid for once per locale, ever. The model leg does NOT run in a page render: it measured 10.3s for one order, and a florist tapping a link from an SMS cannot wait for that. `sendOffer` calls `warmLineItemTranslations` as its last act, after every message has gone out, so the cache is warm by the time they arrive; the render itself is cache + Shopify only (measured 363ms cold, 50ms warm). A page that somehow beats the warm shows the Shopify-translated title and variant with the recipe still in English, and fixes itself on the next load. The cache is keyed by a HASH OF THE ENGLISH SOURCE, so a recipe that changes can never be served from a translation of the recipe it used to be. `translations(locale:)` results flagged `outdated` are dropped before they are ever considered. Every candidate, Shopify's included, must clear `lib/translations/content.ts::checkContent`: numbers must match as a multiset (this is what catches the 12-vs-15 recipe), a recipe must keep its line count, a list must keep its entry count, and cultivar/brand names must survive. The whole path is wrapped so it cannot throw — a translation failure degrades to English, never to a broken offer page.",
            status: "handled",
            milestone: "mvp",
            plan: "Line-item translations",
          },
          {
            id: "reachout-no-email-ever-extracted",
            trigger:
              "The candidate florist has NO email at all — not a wrong one, not an opted-out one. Ingest crawled the site and enrichment never produced an address, so `florists.email` is null and the email leg has nothing to send to. The dominant cause is not shy websites: it is our own enrichment failing while the crawl succeeded. On 2026-08-06 the Anthropic account ran dry mid-run, so pages were fetched normally (5-8 per florist, contact pages included) and every LLM extraction leg returned 400 'credit balance is too low' — the error is still sitting in those rows' `enrichment_notes`. Measured 2026-08-11: 1,732 live florists across 60 cities have a website, no email, and a recorded enrichment failure. Order #2000027 (Lacroix-Falgarde) is what it looks like from the order side — 25 offers sent, 24 of them email-skipped as `florist-no-email`, one florist in the whole candidate list reachable by mail.",
            handling:
              "The offer still goes out. `florist-no-email` suppresses ONLY the email leg and the offer hedges to SMS + push, exactly as for an opted-out or network address — which is what carried #2000027: all 24 email-less candidates got an SMS, every one accepted by Telnyx. The repair is upstream, at ingest: a `mode='repair'` ingest job re-runs enrichment against florists ALREADY stored for a city, with no Apify scrape and nothing billed there, because the pages are still on the web and only the extraction failed. It is null-only — a repair may never overwrite an address staff corrected or a florist supplied — and it guards the wrong-recipient branch above on the way out: each recovered address is linked to a known network when the shop's site sits on one, and shared addresses are re-scored globally afterwards. Both matter, because a dry run over six real Toulouse rows recovered contact@artisans-demo.fr and contact@reseau-demo.fr — writing 1,700 addresses without those two guards is how that branch comes back.",
            manual:
              "CX sees the skip reason ('florist-no-email') in the communications log, and can add an address by hand on the florist's card, then re-send. Staff fire it from two buttons that label themselves with the count and disable at zero: 'Repair enrichment (N)' on Discovery does every city that needs it, and 'Repair (N)' on a city page beside Re-run does one. Each city lands as its own row on /jobs with its own cost.",
            automated:
              "`lib/offerVars.ts` sets blockingError='florist-no-email' when the row has no well-formed address, and `lib/offerChannels.ts::emailSkipReason` suppresses the email leg alone; `lib/reachoutSend.ts` continues to SMS + push. The repair itself is `ingest-worker/src/workflow.ts::runRepair` over `ingest-worker/src/repair.ts` (target predicate, null-only patch, shared-address rescoring). The predicate is deliberately NOT keyed on the vendor's error text — it matches any recorded enrichment failure, so the next provider outage is covered by the same job rather than needing a new one. Note what is still open: the linking and the shared-address sweep run inside a REPAIR, not inside a normal ingest, so an ordinary run still creates unflagged network/shared addresses (257 live florists share an address today; 207 are flagged).",
            status: "handled",
            milestone: "mvp",
            plan: "Enrichment repair mode",
          },
          {
            id: "reachout-no-sms-phone",
            trigger:
              "The candidate florist has no parseable phone number — phone_mobile, phone_web and phone_maps are all missing, or none normalizes to E.164 for the country of the city they were ingested under.",
            handling:
              "The SMS leg is skipped and logged ('florist-no-sms-phone') in the communications log; email and push still fire, and the offer proceeds normally. Partly closed at the source: the join form asks for a mobile and, when one is given, validates it to E.164 before storing it (lib/floristAccept.ts) — so a self-registered florist who supplied one arrives with a number we have actually confirmed we can send to, and resolveFloristSmsPhone prefers it over both scraped columns. The field is OPTIONAL by product decision: a florist with only a landline must still be able to join, and email plus push carry the offer without it. Florists who skip it, and cold prospects we have not onboarded, still depend on the scraped numbers, which are unverified by design — staff correct a bad one from the florist card, exactly as they already do for a bad email.",
            manual: "CX sees the skip reason in the communications log and can fix the number on the florist's card, then re-send.",
            automated: "lib/phone.ts::resolveFloristSmsPhone tries phone_mobile → phone_web → phone_maps and returns null rather than guessing; lib/reachoutSend.ts logs the skip and continues. lib/floristAccept.ts rejects a join submission whose mobile cannot be normalized rather than storing a number we could never text, and omits the column entirely when the field was left blank so a skipped optional field cannot wipe a good staff-entered number.",
            status: "handled",
            milestone: "mvp",
            plan: "Plan 2",
          },
          {
            id: "reachout-florist-unsubscribed",
            trigger: "The candidate florist has unsubscribed from order-offer emails (permanently, or snoozed for 30 days) via the self-service link in the offer email footer.",
            handling: "The email leg is skipped and logged; the push notification and the rest of the send (claim, order status, order event) still fire — unsubscribe only gates the email channel, the same as the Settings-level per-email-type toggle.",
            manual: "CX sees the skip reason (florist-opted-out / florist-snoozed) in the communications log if investigating why a florist didn't respond by email.",
            automated: "sendOffer() checks florists.order_emails_opt_out / order_emails_snoozed_until before building the email; the atomic claim, push, and order_events all proceed regardless of the result.",
            status: "handled",
            milestone: "mvp",
            plan: "Plan 2",
          },
          {
            id: "reachout-wrong-language",
            trigger:
              "The offer goes out in English to a florist whose country implies another language, because `florists.locale` is null and nothing else decided it. Hit twice for real. Paris: 200 florists ingested 2026-08-03 with a null locale, three English offers sent. Order #2000034 (2026-09-10): a French shop in Cranves-Sales, ingested under the Swiss city of Founex because it sits inside that city's 20 km radius, inherited CH, which mapped to no language, and got English. Its florist machine-translated the email, the translation rendered the same button label two different ways, and he stopped to ask which button to press 43 minutes before the offer expired. Measured the same day: ~845 Spanish-speaking shops in Latin America and 200 in Vienna were in the same state, because the country map had ES but no Latin American country and no AT.",
            handling:
              "A florist's language is now decided by the best source available, in order: their stored `florists.locale` (always wins), the country named in the shop's OWN address, and only then the country of the city it was ingested under. City radii cross borders (46 of Founex's 174 shops are in France; Basel holds shops in three countries), so the city was wrong for whole populations. Switzerland is split by postcode (1000-2999 fr, 6500-6999 it, else de; measured 243 French / 818 German / 0 Italian). Where nothing can decide, the send still goes out in English but is now recorded as unintended rather than looking identical to a correct one.",
            manual:
              "Staff can set a florist's language on the florist card. Stored rows are corrected by `supabase/migrations/2026-09-16-florist-locale-and-phone-from-address.sql` (null-only, pure SQL, identical on staging and production; its country-name table was checked name by name against the app's parser): measured on production before applying, 2,366 florists get a language. Applied to staging 2026-09-16 (727 rows, then 0 on a re-run); production is applied by a person.",
            automated:
              "`dashboard/lib/floristLocale.ts::resolveFloristSendLocale` backs all six florist send paths (offer, accept confirmation, magic link, support agent, recruiting tick, florist auth); it reads the address via `lib/shopCountry.ts`, which resolves country names in the 24 languages Google returns them in. It is deliberately not inside `lib/i18n`, which client components import. The region map (`lib/i18n/locales.ts`, `ingest/locales.py`, `ingest-worker/src/locale.ts`) gained AT, the Spanish-speaking Americas, and (a business decision, 2026-09-16) Andorra to Spanish and Morocco and Tunisia to French; CH, BE and LU stay unmapped on purpose, with a test asserting it. `isUnintendedEnglish` flags an EN send whose country is not English-speaking via `captureError('offer.locale.unintended_english')`.",
            status: "handled",
            milestone: "mvp",
            plan: "Plan 2",
          },
          {
            id: "reachout-reply-bounces",
            trigger:
              "A florist replies to an offer email and the reply bounces. The offer carried no Reply-To, so replies went to the From address on fc.example.net, which has NO MX record: mail there cannot be delivered anywhere. It never reaches Resend Inbound, the webhook, `conversations`, or /conversations, so nobody here can see it happened. Order #2000034: the florist's question bounced back to him and surfaced five days later as a forwarded complaint. As of 2026-09-16 every conversation in production is `support:app`; no email reply has ever reached the inbound pipeline.",
            handling:
              "Replies now land in the app. EVERY florist email carries a reply address that reaches /conversations: the signed per-assignment address when it is about one order (offers, accept confirmations, issue emails), otherwise a general inbound mailbox (magic links). Each reply is also logged to `communications` with status `received` and the sender, so it shows on /communications and the order page next to what we sent. A reply about an order is always a SUPPORT thread, joined or not; before, a shop that had not joined, exactly #2000034, would have been pitched to join by the recruiting assistant. Inbound mail is received on reply.fc.example.net (MX + DKIM on that subdomain only; the root and `send` sending records are untouched) or on the account's no-DNS your-inbound.resend.app. Tested end to end on staging 2026-09-16. Testing found two bugs no reply had ever exercised: the webhook fetched a received email's body from the SENT-mail endpoint (every reply would have arrived blank), and it lowercased the case-sensitive reply token (token matching silently never worked). Both fixed.",
            manual: "CX reads and answers florist replies in /conversations (filtered on /communications by 'Replies'). The assistant drafts; with the agents on, an order reply it cannot answer from the order's facts is escalated to a person.",
            automated:
              "`lib/email.ts` + `lib/replyToken.ts::chooseReplyTo` / `::inboundMailbox` (explicit > signed token address > general inbound mailbox > monitored fallback); `app/api/webhooks/resend-inbound` (fetches /emails/receiving/{id}; keeps recipient case); `lib/inboundMatch.ts::pickMatch` (token, header thread, then florist-only thread) and `::threadKind`; `lib/conversations.ts::ingestInbound` logs the `received` communication; migration `2026-09-16-communications-received-status.sql`. Staging secrets come from STAGING_* repository secrets via deploy-staging.yml. Live in production since release-2026-09-17: its own email.received webhook, PROD_* secrets pushed by deploy-v2.yml, the received-status migration applied, and a test reply confirmed on /communications.",
            status: "handled",
            milestone: "mvp",
            plan: "Inbound email",
          },
          {
            id: "reachout-engaged-then-silent",
            trigger:
              "A florist opens or clicks an offer, does not accept or decline, and the offer expires, leaving the order unplaced. The loop moves on to colder shops and the desk said only 'Needs next florist', although this shop is the warmest lead there is. Order #2000034: two clicks 67 and 72 minutes after delivery, a question sent 43 minutes before expiry, then five days unplaced.",
            handling:
              "The CX desk now raises 'A florist opened this offer but never answered' on the order, ranked just above 'Needs next florist' (86 vs 85) and below a true dead end (90), and the Operator panel turns it into 'Call that florist'. Mail scanners click every link within seconds, so a click only counts from one minute after delivery; a portal visit always counts. Measured on 2026-09-16 it applies to 11 unplaced orders, all already on the desk, so it adds a better reason rather than new rows.",
            manual: "CX calls the shop that engaged before offering the order to anyone new.",
            automated:
              "`dashboard/lib/cxAttentionRules.ts::isHumanEngagement` (pure, unit-tested) and rule 2d in `lib/cxAttention.ts::gatherAttention`, scoped to working-set orders before querying.",
            status: "handled",
            milestone: "mvp",
            plan: "CX desk",
          },
          {
            id: "reachout-sms-account-down",
            trigger:
              "The SMS provider account itself stops working, so EVERY text fails, not one number. Real: between 2026-08-07 and 2026-09-11 the Telnyx account was deactivated on and off ('It may be out of funds') and 228 texts failed. Every failure was recorded in external_ops and nothing read it, so nobody knew for five weeks.",
            handling:
              "The daily automation digest, the one automated message confirmed to reach a person every day (10 of 10 sent in the last 14 days), now leads with the outage when one happened: the subject becomes 'SMS DOWN · ...' and a 'Fix first' section gives the count, the local time span and the fix. Only the provider's own account-down wording counts; a single rejected number is never reported as an outage. Per-number submit-time rejections ('destination is not mobile', 'Invalid destination number', 23 ever) are deliberately NOT fed back into `sms_undeliverable_at`: product decision 2026-09-16, too rare to be worth it once the account is healthy, and many stored numbers are landlines that could never receive SMS anyway.",
            manual: "Whoever reads the digest reactivates or tops up the Telnyx account.",
            automated:
              "`ingest-worker/src/digestMetrics.ts::providerOutages` (pure, tested against the real production error strings), fed by `dailyDigest.ts::fetchProviderFailures`, rendered by `digestEmail.ts`. Daily, not real-time: the real-time path is x-cx-spof, which is inert in production (see there).",
            status: "handled",
            milestone: "mvp",
            plan: "Daily digest",
          },
        ],
      },
      {
        id: "florist-accept",
        label: "Florist accepts",
        short: "Florist taps Accept in the PWA; a row lock picks one winner.",
        kind: "decision",
        status: "shipped",
        milestone: "mvp",
        plan: "Plan 4",
        surface: "Florist PWA",
        description:
          "The florist sees the offer (area only, pre-accept) in their installed PWA and accepts. A transactional lock guarantees exactly one winner even if two florists accept at the same instant. On accept the delivery PII is revealed (full address, recipient name, and since 2026-09-14 the recipient's phone as a copyable field — see the `accept-recipient-unreachable` branch) and the payout clock starts — and the florist is told so: a localized 'thank you for accepting, we trust you to deliver it correctly' confirmation goes out on email + SMS the same moment, on both accept paths (their own tap, and CX accepting on their behalf). Until 2026-08-10 the accept notified the customer, Shopify and CX and said nothing at all to the person who had just taken the order.",
        code: [
          "dashboard/app/florist/(app)/orders/[id]/page.tsx",
          "dashboard/components/florist/FloristOrderDetail.tsx (OrderFacts — the post-accept address/recipient/phone reveal)",
          "dashboard/app/api/florist/respond/route.ts (accept race lock)",
          "dashboard/lib/acceptComms.ts (notifyFloristOfAccept — the accept confirmation, email + SMS, best-effort)",
          "dashboard/lib/acceptConfirmContent.ts (pure builders, shared with the message editor's preview)",
          "supabase/migrations/2026-08-10-accept-confirmation.sql (email_accept_confirm_enabled / sms_accept_confirm_enabled)",
          "dashboard/app/api/florist/release/route.ts (florist give-back)",
          "dashboard/lib/reassignOrder.ts (shared reassign, used by staff + the SLA auto-reoffer)",
          "dashboard/lib/waves.ts (advanceWaves — accept-SLA auto-reoffer)",
          "dashboard/lib/fulfilmentBreach.ts (isFulfilmentSlaBreached)",
          "dashboard/lib/help/content.ts (the Q&A a hesitating florist reads before deciding)",
          "dashboard/app/florist/(app)/help/page.tsx · dashboard/app/help/page.tsx (in-app + public)",
        ],
        branches: [
          {
            id: "accept-race",
            trigger: "Two florists accept the same offer simultaneously.",
            handling: "A DB-level lock resolves it: first commit wins.",
            manual: "None needed — resolved automatically.",
            automated: "A DB row-lock lets the first commit win; the loser is told the order is already taken.",
            status: "handled",
            milestone: "mvp",
            plan: "Plan 4",
          },
          {
            id: "accept-has-questions",
            trigger:
              "The florist would take the order but doesn't understand something first — how the 70/30 pays out, whether they may substitute a flower they're short of, what happens if the address is wrong. Until now the offer gave them three options: accept blind, decline, or go quiet. Quiet is the one we actually saw.",
            handling:
              "A third action on the offer — 'I have a question first' — opening the florist Q&A with a back link to this exact order. In the accepted-order chat, the support agent can also answer the same published-policy/app-how-to questions inline when the guard classifies them as safe; live order problems still go through Report a problem / CX.",
            manual:
              "None for the common case. CX can also share a link to a single answer (/help?a=missing-flower) from an issue thread. If an answer keeps failing to land, the wording is fixed from the staff console (Email templates) with no deploy.",
            automated:
              "`/florist/help?back=/florist/orders/<assignmentId>` renders the same content module as the public `/help`, in the florist's own language, and returns them to the order. The public page is also linked from the offer and recruiting email footers, so a florist who has never signed in reads the same answers.",
            status: "handled",
            milestone: "mvp",
            plan: "Help centre",
          },
          {
            id: "accept-confirm-unreachable",
            trigger:
              "The florist takes the order but we can't confirm it back to them — their stored address is a network head office / shared / hard-bounced, they opted out of order email, or (for the SMS leg) we have no parseable mobile and Telnyx has marked the number undeliverable.",
            handling:
              "Each leg is suppressed on its own and the reason is written to the `communications` log, so a florist who was never told is visible rather than silent. The accept itself, the 70% payout leg, the Shopify write-back and the customer notice are all unaffected — the confirmation is best-effort by construction and cannot fail any of them.",
            manual:
              "CX sees the skipped row on the order's communications section (same place an unreachable offer shows up) and can fix the address on the florist card, or call them.",
            automated:
              "`lib/acceptComms.ts::notifyFloristOfAccept` decides reachability with the SAME predicates the offer uses (`lib/offerChannels.ts::emailSkipReason` / `smsSkipReason`) rather than a second set of rules, and logs `accept_confirm` / `accept_confirm_sms` skips with the exact reason string. The whole function is wrapped so it can never throw into the accept path.",
            status: "handled",
            milestone: "mvp",
            plan: "Florist experience",
          },
          {
            id: "accept-recipient-unreachable",
            trigger:
              "The florist is at the door and it doesn't open: nobody home, the buzzer is broken, the building needs a code we don't have. They need to phone the recipient. We hold `orders.recipient_phone` on effectively every order (246/246 over the sample week), but until 2026-09-14 the florist order page never rendered it — the redacted `view` projection didn't select the column and `OrderFacts` had no field for it. A florist who accepted got a full street address and a name and no number.",
            handling:
              "The number is on the order page, post-accept, as a copyable number beside the address, in the florist's own language. Gated exactly like the address and the recipient name: nulled server-side before accept, so an offer still reveals nothing.",
            manual:
              "None needed for the common case. If the number is genuinely missing on an order, the florist's Report a problem / chat route to CX as before.",
            automated:
              "`view.recipient_phone` is populated only when `accepted`, mirroring `address`/`recipient`; `OrderFacts` renders it through `RecipientPhone`, whose tap COPIES the number rather than dialling it: a `tel:` link is one tap on a handset but a dead click on any desktop without a dialler, and CX reads this screen through view-as. The stored string is what the florist reads; `dialableNumber()` normalises only the copied value (strips formatting, keeps a leading +, returns null when no single number survives, in which case no phone control renders at all). This closes a gap the support agent already covered from the other side: `lib/supportFacts.ts` has answered 'what's the recipient's phone number?' in the accepted-order chat since it was added, on the stated assumption that this page showed it. Asking the chatbot was the only way to get it.",
            status: "handled",
            milestone: "mvp",
            plan: "Florist experience",
          },
          {
            id: "accept-then-bail",
            trigger: "Florist accepts, then can't actually fulfil (later cancels / goes dark).",
            handling: "Florist self-serve 'give it back' + a fulfilment-SLA auto-reoffer, on top of staff reassign (next / specific / add any florist) + the issue flow.",
            manual: "The florist taps 'Give this order back' (reason picker, mirrors decline) from their order page; from the backoffice order page CX can also reassign to the next candidate, offer a chosen florist, or add any florist — cancel claws back the accept leg.",
            automated:
              "`POST /api/florist/release` lets the florist hand back an accepted, not-yet-delivered order themselves — CAS accepted→released, claws back any issued accept-leg payout (clawbackForOrder), and demotes the order to reaching_out so the wave re-offers the next candidate. Separately, `advanceWaves()` auto-detects an accepted order with no ready/delivered progress past its SLA (or close to the delivery deadline) and calls the same race-locked reassignOrder on its own, escalating to CX if no candidate remains.",
            status: "handled",
            milestone: "mvp",
            plan: "Order page",
          },
        ],
      },
    ],
  },
  {
    id: "fulfil",
    label: "Fulfilment & pay",
    tone: "tA",
    blurb: "Pay the accept leg, work the order, get it delivered, capture verified proof.",
    stages: [
      {
        id: "payout-accept",
        label: "Accept-leg payout (the tier's accept share)",
        short: "Single-use FLQ virtual card issued for the accept leg.",
        kind: "step",
        status: "shipped",
        milestone: "mvp",
        plan: "Plan 5",
        surface: "Backoffice + Airwallex",
        description:
          "The trust tier sets the split. The florist's payout total (the order's actual, post-discount total × the percent locked in at match time) FLOORS to a WHOLE unit of currency rather than rounding — €53.63 pays €53.00, and everything below the euro stays with Facundo. The two legs then divide that whole total (70/30 of €41 is €28.70 + €12.30); if a human has overridden the payout to a non-whole amount, the accept leg floors to cents and the delivery leg takes the remainder so the legs still sum to exactly what the florist was quoted. The same whole-unit floor applies when an edited order's total is recomputed for a clawback. On accept, the 70% accept leg is paid by issuing a single-use FLQ virtual card (Airwallex Issuing), recorded in `payouts` + `payment_events`. A `PayoutRail` interface keeps a SEPA-transfer rail addable later. All money paths honour test-mode / sandbox. The accept leg pays on acceptance without waiting for anyone, in **every** workflow mode including **semi** — the florist has taken the order, and that is the promise the recruiting copy makes. Workflow mode gates system-initiated steps, not paying a florist who has done the work (`lib/payoutHold.ts`, unit-tested). What still parks the 70% as `held` for CX is a substantive finding about the shop, never a workflow step: a trust tier that says hold (tier 4), or a provisional cold-offer shop above the auto-pay cap — no history, no vetting, a self-declared address. Held legs currently have NO staff release surface — see the `reachout-cold-accept-unvetted` branch — and the payments kill switch still blocks all issuance. Separately, staff can issue a single-use card to a florist with no order behind it via an admin-only endpoint (`POST /api/payouts/manual`). Since 2026-08-21 the split is no longer assumed to BE 70/30 anywhere. Tier 1 (\"Trusted\") is set to **100/0** — the whole payout on this leg — and `lib/payoutMath.ts::isSinglePayment` (a tier whose delivery leg is 0%) is the single predicate every florist-facing surface reads to decide which story to tell. This matters more than a new feature would: the tier-1 split was changed in the DATABASE, where `/settings` lets any ops user edit it, while every screen went on saying 70/30 — so the copy had been lying to those shops for as long as the row had been that way. Deriving from the split rather than the tier CODE is what stops that recurring. The photo is still required on tier 1; it just stops gating money (see the `payout-deliver` stage).",
        code: [
          "dashboard/lib/payout.ts (payoutOnAccept, issueLeg)",
          "dashboard/lib/airwallex.ts",
          "dashboard/lib/payoutMath.ts (computeSplit, isSinglePayment)",
          "dashboard/lib/floristPayoutModel.ts (which payment story a florist-facing PAGE tells)",
          "dashboard/app/api/payouts/[id]/retry/route.ts",
          "dashboard/app/api/payouts/manual/route.ts",
          "dashboard/components/payments/IssueCardForm.tsx",
          "dashboard/components/payments/RetryPayoutAction.tsx",
          "dashboard/app/api/payouts/[id]/live/route.ts (read-only live Airwallex query)",
          "dashboard/lib/airwallex/liveSummary.ts (normalize + diff live vs stored)",
          "dashboard/components/payments/LiveAirwallexPanel.tsx",
          "dashboard/lib/airwallex/cards.ts (updateCardLimit)",
          "dashboard/app/api/payouts/[id]/adjust-limit/route.ts",
          "dashboard/components/payments/AdjustCardLimitAction.tsx",
          "dashboard/app/api/webhooks/airwallex/route.ts (now logs every inbound delivery, rejected or not)",
          "dashboard/lib/airwallex/webhookLogOp.ts (pure external_ops row builder for the webhook)",
          "dashboard/lib/airwallex/reconcile.ts (reconcileCardPayouts — the write path)",
          "dashboard/lib/airwallex/reconcilePatch.ts (computeReconcilePatch/reconcilePatchChanged — pure decision + sign convention)",
          "dashboard/lib/airwallex/payoutRailRows.ts (shared payout-row loader, factored out of live-status)",
          "dashboard/lib/airwallex/liveFetch.ts (shared bulkFetchLive — same fan-out for live-status and reconcile)",
          "dashboard/app/api/payouts/reconcile/route.ts (cron- and staff-triggered reconcile sweep)",
        ],
        branches: [
          {
            id: "pay-price-pre-discount-basis",
            trigger: "An order carries a discount code. `computePayoutPrice`'s basis was items + shipping at their PRE-discount price, not what was actually collected — so a heavily-discounted order paid the florist most or nearly all of the pre-discount value. Real case: order #2000029 (2026-08-17) had a 30%-off code, collected €53.93, and paid a florist €40 (accept €28 + delivery €12) when the correct 55% payout was €29 — an €11 real overpayment, already issued via card, left unclawed (a business call, not a code fix). A second, independent bug compounded it: ingest-worker/src/db.ts::insertCandidates hand-duplicated this math inline (\"kept in lockstep\" by comment only, since the Worker can't import across the dashboard/ingest-worker package boundary) and used a DIFFERENT rounding convention (round-to-cents) than the dashboard's floor-to-whole-unit — so the automatic match and a manual re-match on the SAME order could quote two different payouts.",
            handling: "`computePayoutPrice(orderTotal, percent)` now takes the order's actual total (what was collected, discount already netted in) instead of a separately-summed items+shipping basis — every caller (`insertCandidates`, the manual assign/rematch routes, the demo-sandbox order builder) passes `orders.total`. The rounding-convention drift is closed architecturally, not just fixed once: `ingest-worker/src/payoutMath.ts` is now a byte-identical copy of `dashboard/lib/payoutMath.ts` (same fix already applied to lib/match.ts — see sync-match.mjs), and `payoutMath.test.mjs` asserts byte equality, so the two can never silently diverge again. A one-time backfill corrected every NOT-YET-ACCEPTED assignment's `payout_price` to the new formula (215 rows / 33 orders) — nothing already accepted or paid was touched.",
            manual: "The one real overpayment (#2000029) was a deliberate no-clawback decision, not an oversight — reclaiming from a florist who already received and likely spent the card issuance wasn't worth the relationship cost for €11. Any FUTURE case like it (a discount-code order already accepted before this fix reached production) needs the same case-by-case call, not an automatic clawback.",
            automated: "None by design for already-issued legs — `clawbackAmount`/`clawback_order()` exist but are a deliberate human trigger, never automatic. Going forward, every new match/assign/rematch locks in the corrected amount from the start.",
            status: "handled",
            milestone: "mvp",
            plan: "Payout basis + lockstep fix",
          },
          {
            id: "pay-accept-unattended",
            trigger:
              "The 70% is now issued the instant a florist accepts, with no human in the loop — so a florist who accepts and then goes quiet has already been paid the larger leg before anyone at Facundo has looked at the order.",
            handling: "Accepted as the cost of the promise; bounded by the trust tier's exposure cap and the kill switch, and recovered through the existing clawback.",
            manual:
              "CX watches the accepted-but-not-delivered queue and claws back a leg that never gets a photo. The payments kill switch stops all issuance in an incident, and a florist can be dropped to a holding trust tier so their next accept parks for review instead of paying.",
            automated:
              "The trust tier's `exposure_cap_eur` caps total in-flight money per florist and is re-checked on every leg, so the blast radius of one bad shop is bounded rather than unlimited. A provisional cold-offer shop above the auto-pay cap still holds. Live sends also re-check Airwallex funds.",
            status: "handled",
            milestone: "mvp",
          },
          {
            id: "pay-issue-fail",
            trigger: "Card issuing call fails or Airwallex is down.",
            handling: "Enqueued in the effects outbox + retried with backoff; a dead effect surfaces in the CX hub.",
            manual: "Staff can force a retry right from the payment record (Retry issue on /payments/[id]) instead of waiting out the backoff — same guards (kill switch, exposure cap, funds) as the automatic path.",
            automated: "A failed leg auto-enqueues a payout effect; the drain cron re-attempts with backoff and marks it dead → CX hub after max attempts (Sprint 1b).",
            status: "handled",
            milestone: "mvp",
            plan: "Sprint 1b",
          },
          {
            id: "pay-not-enabled",
            trigger: "Airwallex Issuing isn't enabled on the account yet (external gate).",
            handling: "Ledger records what's owed; fall back to a manual settle.",
            manual: "Finance settles the florist manually until Issuing is switched on.",
            automated: "The ledger records what's owed; flip the card rail on once Airwallex enables Issuing.",
            status: "handled",
            milestone: "mvp",
            plan: "Plan 5",
          },
          {
            id: "pay-state-stale",
            trigger:
              "The Airwallex webhook isn't delivered, so the payout row never learns the card was spent, settled or closed — and nothing else ever writes those columns.",
            handling:
              "Confirmed in production 2026-09-04 as a total blind spot, not just a theoretical gap: `airwallex_events` had zero rows ever, and all 38 card-rail payouts since 2026-08-01 sat at `status='issued'` with `spent_amount`/`settled_at` null on all 38 — while Airwallex's own records showed 21 of those 38 cards had real authorizations, many already cleared. Root cause: `AIRWALLEX_WEBHOOK_SECRET` was undocumented as required (DEPLOY.md listed it under 'optional tuning'), and unset means `webhookVerify.ts` returns `no-secret-configured` and the route 401s EVERY delivery — with no way to tell that apart from 'Airwallex was never pointed at us at all', because a rejected delivery left literally no trace anywhere (the `airwallex_events` dedupe insert only happens AFTER verification passes). Two of the three prongs of that are now fixed: (1) OBSERVABLE — `app/api/webhooks/airwallex/route.ts` now logs every inbound delivery to `external_ops` (`provider:'airwallex', operation:'webhook_in'`) BEFORE returning, including a rejected one with its exact verify-failure reason (`webhookLogOp.ts`, best-effort, cannot affect the 401/200 either way); (2) DEPLOY.md now states the secret is required and adds the previously-undocumented step of actually registering the endpoint URL in the Airwallex console. Still open: nobody has yet confirmed the secret is correctly set and the endpoint is correctly registered against the live Airwallex account — that's an ops action, not a code one — so `spent_amount`/`last_txn_id`/`card_status`/`settled_at` may still be exactly as stale in production as before until that's done and deliveries are observed landing `ok:true`.",
            manual:
              "'Query live from Airwallex' on /payments/[id] reads the card, its authorizations and its transactions straight from the provider and names every field where the stored row disagrees. It is READ-ONLY — it makes the drift visible, it does not repair it. Batch 1 (2026-08-15) extends this from one-payout-at-a-time to the whole list: /payments now shows an 'Unconfirmed' indicator on any card-rail payout Airwallex has never reported card state for (`card_status` still null — the exact 2026-08-11 incident shape), and staff can run a bounded manual bulk check (`POST /api/payouts/live-status`, capped at 25 ids per call) that reads live from Airwallex for those flagged rows and shows drift the same way the single-payout view does. Still READ-ONLY — writes nothing to `payouts`. Staff (finance/admin) can now also trigger `POST /api/payouts/reconcile` with a specific `{ids}` list to force-repair those exact rows on demand, same auth as every other payout-writing route.",
            automated:
              "2026-09-04: a real reconcile sweep now exists — `lib/airwallex/reconcile.ts` (`reconcileCardPayouts`) reuses `bulkLiveCheck`/`summarizeLive` unchanged and adds the decide-and-write step (`lib/airwallex/reconcilePatch.ts`): for a card-rail payout not yet in a terminal state (pending/issued/held), it writes `spent_amount` (raw NEGATIVE, matching `webhookMap.ts`'s convention exactly — not liveSummary's display-positive magnitude), `settled_at`, `card_status`, `last_txn_id`, advances `status` to `paid` once Airwallex shows the spend cleared, and logs a `payment_events` row typed `reconciled_settled`/`reconciled_authorized` (distinct from a webhook-driven event, so the audit trail always shows which path actually caught it) — and deliberately does nothing when Airwallex shows no spend at all, so an honestly-unspent card is never touched. `POST /api/payouts/reconcile` (dashboard; the Airwallex client only lives there, not in the Worker) is polled every cron tick the same way `/api/payouts/held-sweep` already is, self-throttled to ~5 minutes via `app_settings.payout_reconcile_last_run_at` since a full sweep makes real Airwallex calls. Idempotent: a late-arriving webhook after a reconcile (or vice versa) writes the same values either writer would have. Not yet built: nothing pages staff when a sweep itself keeps failing, and there's no dashboard visibility into `reconciled_*` vs webhook-sourced `payment_events` beyond reading the table directly.",
            status: "in-progress",
            milestone: "mvp",
          },
          {
            id: "pay-exposure",
            trigger: "Issuing this card would exceed our outstanding-exposure cap.",
            handling: "Over-issue is blocked and flagged.",
            manual: "CX reviews the exposure meter and raises the cap or defers issuance.",
            automated: "Over-issue is blocked and flagged rather than silently minting unbounded liability.",
            status: "handled",
            milestone: "mvp",
            plan: "Plan 5",
          },
          {
            id: "pay-fx-currency-mismatch",
            trigger:
              "The payout card is always issued in the ORDER's currency (EUR for this storefront — `orders.currency`, locked at match time), but a non-EU florist's payment processor bills in their own currency (NIS for an Israel-based shop; USD, via a Dubai-based aggregator, for a Bangkok shop). Airwallex converts at swipe time, and that conversion can land a small amount over the card's limit — the florist's charge then declines with `LIMIT_EXCEEDED`, repeatedly, on retry after retry, with nothing on our side surfacing it as anything other than an unspent card.",
            handling:
              "Two real orders hit this within 24 hours (2026-08-30 Israel/NIS, 2026-08-31 Bangkok/USD-via-Dubai) before any in-app handling existed — both were diagnosed by reading live Airwallex authorizations/transactions for the card (nothing in `payment_events` shows a decline; only a successful/pending authorization or an explicit query surfaces it), and the first was fixed by someone editing the card directly in the Airwallex dashboard, leaving zero record on our side. `updateCardLimit` (`lib/airwallex/cards.ts`) now lets staff raise a still-open single-use card's `ALL_TIME` limit IN PLACE — same card, no reissue, every other control preserved — from `/payments/[id]`, with a mandatory reason logged to `payment_events` (`card_limit_adjusted`), the same trust-tier exposure-cap re-check every other issuance path in `lib/payout.ts` gets, and `payouts.amount` updated to the new value so a later exposure check and a second adjustment both see the current live limit rather than the original quote. It only works BEFORE the card's one allowed transaction succeeds — checked against Airwallex's own live `card_status`, not just our webhook-only-written `payouts.card_status` column, since that can lag; a miss discovered after the fact still needs a separate manual top-up card (`POST /api/payouts/manual`) instead. `payouts.amount` after an adjustment is the new CEILING, not necessarily what the florist ends up actually spending — the true settled figure still only ever arrives via the Airwallex webhook (`spent_amount`/`settled_at`), same as any other card.",
            manual:
              "Staff use 'Query live from Airwallex' on the payout to see FAILED authorizations with `failure_reason: LIMIT_EXCEEDED`, then 'Adjust card limit' on the same page to raise it a few units past what the FX conversion needs and ask the florist to retry.",
            automated:
              "None. Nothing detects a `LIMIT_EXCEEDED` decline pattern or proposes a limit on its own — a human has to notice the florist is stuck (today, only because they complain) and go look.",
            status: "open",
            milestone: "mvp",
          },
        ],
      },
      {
        id: "fulfil-progress",
        label: "Order worked through its stages",
        short: "In production → ready → out for delivery, via staff stage control.",
        kind: "step",
        status: "shipped",
        milestone: "mvp",
        plan: "Order page",
        surface: "Backoffice + Florist PWA",
        description:
          "The order moves through its fulfilment states — in production → ready → out for delivery. Staff drive this from the order page's guardrailed stage control (forward + sensible back-steps + escalate/cancel), each a compare-and-set write + an `order_events` row; the 6-stage journey renders as a horizontal stepper. Florist self-service of these same steps from the PWA is the remaining piece; `delivered` stays photo-gated.",
        code: ["dashboard/lib/orderStages.ts (STAGES, staffSettableStatuses)", "dashboard/app/api/orders/status/route.ts (guardrailed CAS)", "dashboard/components/orders/ChangeStageMenu.tsx + StageStepper.tsx"],
        branches: [
          {
            id: "fulfil-status-race",
            trigger: "Two writers change the order's stage at the same moment.",
            handling: "Every status write is compare-and-set — one wins, no lost update.",
            manual: "The loser gets an 'order changed — refresh' prompt and re-reads the current state.",
            automated: "Compare-and-set on `orders.status` lets only the writer that still sees the prior state win.",
            status: "handled",
            milestone: "mvp",
            plan: "Order page",
          },
        ],
      },
      {
        id: "deliver-photo",
        label: "Delivered + verified proof photo",
        short: "Florist uploads a photo → order delivered + payout; a dual-AI gate scores it.",
        kind: "step",
        status: "shipped",
        milestone: "mvp",
        plan: "Plan 4 / Phase B",
        surface: "Florist PWA",
        description:
          "The florist fulfils the order and uploads a delivery-proof photo from the PWA (stored in R2, recorded as a `delivery_events` row). Immediately above the upload button they get a shooting guide — five rules mirroring exactly what the AI gate scores (every ordered item in one frame, good light, plain background, sharp, shot at this delivery) plus four inline-SVG sample tiles (one pass, three fails: too dark, out of focus, cut off) — so fewer photos hit the CX queue in the first place. That photo marks the order + assignment delivered, drives the delivery payout leg, writes back to Shopify, notifies the client, and is viewable by both the florist (in the PWA) and staff (backoffice). An AI vision gate (Claude + Gemini in consensus) compares the photo to the ordered line items (multiple bouquets + add-ons) and records a verdict (pass/review/fail) plus per-provider confidence in `photo_verifications`. That verdict does NOT gate the 30% release as of 2026-08-20: an audit of every verdict recorded so far found the check's calibration isn't trustworthy enough yet to hold real florist payouts on (5/5 were `review`, none `pass`/`fail`, including two photos of shoe boxes the agent still scored `review` on instead of failing hard), so the HOLD consequence is temporarily disabled (`lib/payoutHold.ts`) while the agent is re-tuned — the check itself keeps running and keeps writing verdicts, both to feed that re-tuning and a florist-facing review UI in progress. (Gemini participates once `GEMINI_API_KEY` is set; the Claude leg goes through OpenRouter on `OPENROUTER_API_KEY`, like every other LLM call in the product — one key, one bill, and a model swap is a config change. Each provider is toggleable in Settings.) Two additional SHADOW-MODE opinions, both routed through OpenRouter (`google/gemini-2.5-pro` + the cheap, independent `qwen/qwen3-vl-30b-a3b-instruct`, once `OPENROUTER_API_KEY` is set), additionally see the ordered product's own reference photo(s) — not just the text spec — and record a 0-100 score each in the same table for evaluation/agreement comparison; neither yet participates in the verdict or the payout gate.",
        code: [
          "dashboard/app/api/florist/photo/route.ts",
          "dashboard/lib/imageType.ts (magic-byte sniffing — the bytes decide the media type, not the client)",
          "dashboard/lib/photoFeedback.ts (why a hold happened, in florist-facing terms + the re-upload cap)",
          "dashboard/lib/photoVerify/ (Claude + Gemini consensus)",
          "dashboard/lib/photoVerify/openrouter.ts (shadow-mode opinions, evaluation only — gemini-2.5-pro + qwen3-vl-30b-a3b)",
          "dashboard/lib/payout.ts (hold logic; the verdict itself no longer gates it as of 2026-08-20)",
          "dashboard/components/florist/FloristOrderDetail.tsx",
          "dashboard/components/florist/PhotoGuide.tsx (how-to + sample tiles, shown above the upload)",
        ],
        branches: [
          {
            id: "deliver-late",
            trigger: "Delivery is late or the photo never arrives.",
            handling: "SLA countdown is visible; auto-nudge/auto-reassign not fully wired.",
            manual: "CX sees the SLA countdown breach and nudges the florist or reassigns.",
            automated: "SLA-breach escalation auto-nudges then auto-reassigns the order (Phase E).",
            status: "in-progress",
            milestone: "later",
            plan: "Plan 2 / Plan 4",
          },
          {
            id: "deliver-bad-photo",
            trigger: "Photo is wrong, blurry, or clearly not the ordered arrangement.",
            handling: "Prevention first — the in-app shooting guide + sample tiles sit directly above the upload button. Beyond that: the AI vision gate still scores every photo and records a `review`/`fail`/`pass` verdict to `photo_verifications`, but as of 2026-08-20 that verdict no longer HOLDS the 30% automatically — every delivery leg releases the same way regardless of verdict (lib/payoutHold.ts). The hold was disabled because an audit of every verdict recorded so far (5/5 `review`, including two shoe-box photos still scored `review` instead of failing hard) showed the check isn't calibrated well enough yet to gate real money on; it stays disabled until the agent is re-tuned. The florist-facing re-upload flow (lib/photoFeedback.ts, since 2026-08-20) still exists for whatever DOES end up held for some other reason — it names the actual reason, lists what wasn't visible, and offers a RE-UPLOAD, up to `MAX_PHOTO_ATTEMPTS` (3) verified photos per assignment, releasing via the normal `releaseHeldPayout` path when it clears — but only for a leg parked on `photo-verdict`; a `tier-hold`/`provisional-shop` hold is a finding about the SHOP and no re-shoot can move it.",
            manual: "Nothing holds automatically on the photo verdict right now, so there's usually nothing to release by hand for THAT reason — a `review`/`fail` verdict now raises a row on the CX attention desk (`lib/cxAttentionRules.ts::photoVerdictAttentionReasons`, since 2026-10-14) so staff see it without hunting through `photo_verifications`, and can claw back the leg if it turns out not to be a real delivery. A `tier-hold`/`provisional-shop` leg still has no click-to-release surface in the UI (the `/cx` page it lived on was removed 2026-08-10 — see `reachout-cold-accept-unvetted` for the accept-leg twin of this gap): CX reviews on the order page and calls `POST /api/orders/payout/approve`/`/reject` by hand, or 'Release without photo' if delivery is confirmed out-of-band.",
            automated:
              "The AI vision gate (Claude + Gemini consensus) scores every delivered photo and writes verdict + per-provider confidence to `photo_verifications` — that recording is unconditional. It does not drive any hold/release decision (see `pay-deliver-no-release-surface` below for re-enabling the hold once the agent's calibration is trustworthy), but as of 2026-10-14 the LATEST verdict per assignment being `review`/`fail` does raise a `delivery`-category row in `gatherAttention` (`dashboard/lib/cxAttention.ts`) — closing the gap where 11 such verdicts (factory card `55fc7df0`) had been recorded with nobody told to look.",
            status: "open",
            milestone: "mvp",
            plan: "Sprint 1a / Feature 2 / Phase B",
          },
          {
            id: "deliver-unreadable-upload",
            trigger: "The uploaded file's declared MIME type doesn't match its actual bytes — most often WebP bytes announced as `image/jpeg` by the browser or an Android share sheet.",
            handling:
              "The bytes decide, not `file.type`. `lib/imageType.ts::sniffImageMedia` fingerprints JPEG/PNG/WebP from their magic bytes and that type is what reaches R2's Content-Type AND the vision models; a file matching none of the three is refused at upload with a message the florist can act on, instead of being stored and failing four steps later. Found in QA on 2026-08-20 (#MOCK-9304): a WebP-under-a-.jpg-name was passed to Anthropic as JPEG, every provider 400'd (\"the image appears to be a image/webp image\"), and `combineVerdicts` correctly returned `review` @ 0 confidence — which the florist then saw as an unexplained hold on their 30%, with the misleading reason \"No AI provider returned a usable verdict\".",
            manual: "CX sees `photo_verifications.providers[].error` carrying the upstream 400 and can release the leg by hand.",
            automated: "Sniffed at upload; a declared-vs-actual mismatch is corrected silently and logged (`photo.media_mismatch`) so a spike is visible. `photoFeedback()` additionally classifies an all-providers-failed verdict as `not_checked` — OUR failure — so the florist is told we couldn't read it rather than that their work is under review.",
            status: "handled",
            milestone: "mvp",
          },
          {
            id: "deliver-reupload-fishing",
            trigger: "A florist re-uploads photo after photo until the AI gate happens to pass one.",
            handling:
              "The re-upload loop is capped at `MAX_PHOTO_ATTEMPTS` (3) verified photos per assignment; past that the hold stands and it goes to a human, which is what the hold was always for. Every attempt writes its own `photo_verifications` row, and a re-verify that clears a hold writes a `photo_reverified` payment event naming who triggered it, so the whole sequence is auditable rather than just the winning frame.",
            manual: "CX sees every attempt on the order page and can reject the leg outright.",
            automated:
              "Attempt cap + per-attempt audit trail. Not yet closed: nothing compares the attempts to EACH OTHER, so three photos of three different deliveries look the same as three angles of one. Perceptual-hash dedupe (see `deliver-recycled-photo`) is the shared fix.",
            status: "open",
            milestone: "later",
          },
          {
            id: "deliver-partial",
            trigger: "Only part of a multi-bouquet / add-on order is in the photo.",
            handling: "Per-line-item verification records a `review` verdict, but — like every other verdict as of 2026-08-20 — that no longer holds the payout (lib/payoutHold.ts). The finding is still recorded, and since 2026-10-14 raised on the CX attention desk (see `deliver-bad-photo` above), just not enforced right now.",
            manual: "CX sees a partial delivery flagged on the attention desk and can chase the missing items after the fact; nothing is held for them to release.",
            automated: "Each AI provider lists which ordered items it can and can't see; any missing item forces a `review` verdict in `photo_verifications`, but that verdict no longer holds the 30% for CX — see `deliver-bad-photo` above for what it does do instead.",
            status: "open",
            milestone: "mvp",
            plan: "Phase B",
          },
          {
            id: "deliver-noone-home",
            trigger: "No one is home / the recipient is unavailable at delivery.",
            handling: "Florist ↔ CX issue thread (in-app + email) — florist reports, both sides message, CX resolves.",
            manual: "Florist taps 'Report a problem → No one home' and can chat back and forth; CX replies + picks redeliver / reassign / cancel — both sides see the thread and get emailed/pushed.",
            automated: "Opens a structured `order_issues` thread (stepper ⚠ + florist unread badge) with email both ways; an auto redelivery-SLA + customer notice is still to come.",
            status: "handled",
            milestone: "mvp",
            plan: "Order page (issues) / Messaging",
          },
          {
            id: "deliver-no-photo",
            trigger: "Florist delivered the flowers but forgot / can't upload the proof photo.",
            handling: "The 30% is held pending proof; CX can release-without-photo with a mandatory note.",
            manual: "CX confirms delivery (call / customer reply) and uses 'Release without photo' on the order page, recording why — this creates + releases the delivery leg (force-past the hold gate) even when no proof, and therefore no payout row, ever existed.",
            automated: "No auto-release without proof — the 30% stays held (Sprint 1a); the release-without-photo override is a deliberate, reason-stamped human action logged on the payout + order timeline.",
            status: "handled",
            milestone: "mvp",
            plan: "Sprint 1a / 5",
          },
          {
            id: "deliver-recycled-photo",
            trigger: "Florist re-uploads an old or stock delivery photo to trigger payout.",
            handling: "Product-match catches wrong photos; reuse detection is later.",
            manual: "CX spots a familiar image in the trust panel and rejects it.",
            automated: "Perceptual-hash dedupe against prior photos flags reuse + drops the trust tier on repeats.",
            status: "open",
            milestone: "later",
          },
          {
            id: "deliver-dispute",
            trigger: "Customer says it never arrived despite a photo.",
            handling: "A dispute record + money-unwind path lets CX refund/redeliver.",
            manual: "CX opens a dispute, weighs the proof + verdict, and decides refund or redelivery.",
            automated: "A dispute record unwinds the delivery-leg money via clawback and can trigger a redelivery (Phase D).",
            status: "planned",
            milestone: "later",
            plan: "Phase D",
          },
        ],
      },
    ],
  },
  {
    id: "settle",
    label: "Settle & write-back",
    tone: "tC",
    blurb: "Release the final leg and close the loop back to Shopify.",
    stages: [
      {
        id: "payout-deliver",
        label: "Delivery-leg payout (none on a 100/0 tier)",
        short: "Delivery-leg payout released against the verified photo. A 100/0 tier has no such leg.",
        kind: "step",
        status: "shipped",
        milestone: "mvp",
        plan: "Plan 5",
        surface: "Backoffice + Airwallex",
        description:
          "The delivered photo releases the remaining 30% via the same rail, updating the balance ledger and `payment_events`. Since 2026-08-10 that release is immediate in every workflow mode — uploading the proof IS the approval, so a florist no longer waits on a human in `semi`. The AI photo check still runs and still records a verdict to `photo_verifications`, but as of 2026-08-20 that verdict is NOT a gate any more: `review`/`fail`/`pass`/an absent verdict all release the 30% the same way, because an audit of every verdict recorded so far (5/5 `review`, including two shoe-box photos the agent still scored `review` instead of failing hard) showed the check's calibration isn't trustworthy enough yet to hold real money on — see `lib/payoutHold.ts`'s header comment. `app_settings.hold_delivery_payouts` remains as the operator's manual override, now defaulting to off — and since 2026-08-14 a held leg whose ONLY recorded reason was that switch releases itself on the next cron tick once the switch goes back off (`sweepHeldPayouts`), instead of sitting there with no UI to release it by hand. A `tier-hold`/`provisional-shop` hold (or a legacy `photo-verdict` hold parked before it was disabled) is a substantive finding and is never swept — it stays `held` until a human calls the approve/reject API directly (see `pay-deliver-no-release-surface`), and shows its actual reason (not just \"held\") in the CX attention list. Balance and transactions are visible to the florist and in the backoffice payments ledger. ON A 100/0 TIER (tier 1 today) THIS LEG DOES NOT EXIST. A 100/0 split makes the delivery amount zero, `issueLeg` returns `zero-split` and writes NO `payouts` row, so there is nothing to hold, sweep, release or claw back on the photo. The photo is still required, still stored, still verified and still written back to Shopify plus the customer's delivered email — it is proof of delivery, not collateral. The outcome is flagged as `singlePayment` on the payout result (rather than looking like a failure) so the upload route and the florist's order page confirm the delivery instead of going silent, which is what a missing leg would otherwise render as: an uploaded proof stuck behind a \"we couldn't approve that photo\" badge forever.",
        code: [
          "dashboard/lib/payout.ts (payoutOnDelivered, sweepHeldPayouts)",
          "dashboard/lib/payoutHold.ts (payoutHoldReason, shouldSweepReleaseHeldPayout)",
          "dashboard/lib/cxAttention.ts (held-payout reason surfaced per row)",
          "dashboard/app/api/payouts/held-sweep/route.ts (cron: releases stale delivery-gate holds)",
          "ingest-worker/src/index.ts (cron tick → held-sweep, alongside outbox drain)",
          "dashboard/components/payments/PaymentsLedger.tsx",
          "dashboard/app/api/payouts/[id]/retry/route.ts",
          "dashboard/app/api/payouts/manual/route.ts",
          "dashboard/components/payments/IssueCardForm.tsx",
          "dashboard/components/payments/RetryPayoutAction.tsx",
        ],
        branches: [
          {
            id: "pay-deliver-no-release-surface",
            trigger: "A delivery leg holds on a substantive finding (tier-hold / provisional-shop, or a legacy photo-verdict hold parked before 2026-08-20) — the cron sweep deliberately leaves these alone.",
            handling: "The CX attention list flags it with its real reason (`lib/cxAttention.ts`), the Control panel (/) renders it as a money row, and its button lands on `/orders/<id>#payout` where `components/orders/HeldPayoutCard.tsx` offers Release / Reject.",
            manual: "One click from the Control panel: the row links to the held-payout card on the order page (finance/admin only — other roles see the row but not the buttons, matching the API gate). The `POST /api/orders/payout/approve|reject` routes are unchanged; they simply have a caller in the UI again. Same fix as the accept-leg twin, `reachout-cold-accept-unvetted`.",
            automated: "None — and none should exist unattended for these reasons; they're findings, not stale switches (see `shouldSweepReleaseHeldPayout`).",
            // Open 2026-08-10 → handled 2026-09-01. The hold logic never
            // changed; what was missing was a human-facing release button
            // after /cx was removed, which the Control panel restored.
            status: "handled",
            milestone: "mvp",
          },
          {
            id: "pay-deliver-unchecked-photo",
            trigger:
              "The AI photo check doesn't run — providers switched off, or the call throws — and the 30% releases against a photo nobody and nothing has looked at. A florist could upload anything. (As of 2026-08-20 this is one instance of a broader fact: the delivery leg releases regardless of the photo verdict, checked or not — see `deliver-bad-photo` and `lib/payoutHold.ts` — but a run that never happened at all is still the harder case to detect after the fact, since there's no verdict to review even after the money moved.)",
            handling: "Deliberate: absence of a finding is not a finding. Detectable after the fact, and recoverable by clawback.",
            manual:
              "Every delivery still writes a `photo_verifications` row when the check ran, so a gap in that table is the signal that releases went out unchecked. CX reviews the photo on the order page and claws back the leg if it isn't a delivery.",
            automated:
              "None yet — a released-unchecked leg is not currently surfaced anywhere on its own. Worth a CX-hub roll-up so a verification outage doesn't pass silently.",
            status: "open",
            milestone: "mvp",
          },
          {
            id: "settle-fail",
            trigger: "The delivery-leg release fails.",
            handling: "Enqueued in the effects outbox + retried with backoff; a dead effect surfaces in the CX hub.",
            manual: "Staff can force a retry right from the payment record (Retry issue on /payments/[id]) instead of waiting out the backoff — same guards (kill switch, exposure cap, funds) as the automatic path.",
            automated: "The failed release auto-enqueues a payout effect (retryPayoutRow); the drain cron re-attempts with backoff, then marks it dead → CX hub (Sprint 1b).",
            status: "handled",
            milestone: "mvp",
            plan: "Sprint 1b",
          },
        ],
      },
      {
        id: "writeback",
        label: "Write back to Shopify + notify client",
        short: "Metafield + note + CUSTOMER-VISIBLE fulfilment on the Shopify order; client comms.",
        kind: "step",
        status: "shipped",
        milestone: "mvp",
        plan: "Plan 6",
        surface: "Backoffice",
        description:
          "Status is written back to the Shopify order (a timeline note + tag — NOT an `fc.status`/`fc.florist` metafield pair; those were dropped, since neither showed up in Shopify's real metafieldDefinitions list, see the comment in lib/shopifyWriteback.ts) so staff see truth in one place, and the customer gets 'assigned' / 'on the way' / 'delivered' email notifications — gated so we never double-send against Shopify's own emails. Two real metafields ride along when the value is known: our Florist ID (`florists.florist_number` — a Facundo-minted 7-digit integer for a florist that doesn't already have one, assigned per-shop by staff via `assign_florist_number()`/POST /api/florists/assign-number from a reserved block starting at 9,000,000, a considered-but-unconfirmed default since the target Shopify field has no live values to check it against — see lib/floristNumber.ts; a florist with a real known id gets it entered by hand instead; set at accept, and re-sent to every one of that florist's active orders whenever staff mint or hand-correct it afterward — `resendFloristNumberForActiveOrders()` in lib/shopifyWriteback.ts, called from both POST /api/florists/assign-number and POST /api/florists/operational) and the florist's payment (the quoted payout_price, sent at accept — not the delivery-leg-dependent sum; re-sent at delivery only if the real issued-legs total ends up different, e.g. a held delivery leg). Confirmed live against production Shopify admin on 2026-08-21: `custom.tookan_florist_id` ('Tookan Florist Id') and `custom.tookan_cost_of_order` ('Tookan Cost Of Order') — NOT `custom.odoo_florist_order_id`, which real order data showed tracks the order's own Odoo record, not the florist. See the mapping comment in lib/shopifyWriteback.ts. The 'on the way' notice fires when staff move the order to out-for-delivery. Every client email now renders through the shared branded HTML shell (lib/emailTemplate.ts). Each of the three client notices (and every other outbound email type — offer, issue replies, CX alert, recruiting) is individually on/off toggleable in Settings → Notifications, default ON; turning one off just skips that email and logs why, it never blocks the underlying idempotency claim from being retried once re-enabled (client notices) or the rest of the loop (offer still goes out by push, issue threads/CX alert push still fire). Write-back is guarded by a `shopify_writeback_enabled` safeguard (Settings → External services, default OFF) so we can run against a live shop while testing without mutating real orders, and every external call (Shopify/Airwallex/Resend, in + out) is recorded in the SYSTEM → External operations log. In **semi** (step) mode each of the three client notices is step-gated — a previewed, editable customer email waits for a human to approve before it fires — but write-back is deliberately NOT gated even in semi: `gateWriteback()` always fires immediately (a status/metafield sync to Shopify's backoffice-only fields is low-risk enough not to wait on a human). A metafield CORRECTION (the old value already existed and differs from the new one — not a first-time set) instead gets its old → new value appended straight onto the Shopify order's own note, so staff see the diff on the order itself rather than in a pre-send preview. **Separately from all of the above, the order's CUSTOMER-VISIBLE fulfilment status is now synced at two points** (lib/shopifyFulfillment.ts, deliberately a different module from shopifyWriteback.ts, whose contract is 'never touches customer-visible fulfilment status'): on florist-or-CX accept a `fulfillmentCreateV2` flips the Shopify order unfulfilled → fulfilled, and on the florist's delivery-photo upload a `fulfillmentEventCreate` sets the shipment `OUT_FOR_DELIVERY`. `notifyCustomer` is always false (Shopify would otherwise mail the buyer its own shipping confirmation) and NO tracking info is ever sent — a florist hand-delivers, there is no carrier, and a tracking number would additionally trip the Mechanic `docs/flow-shopify/order_on_their_way.liquid` task into sending an Ongage 'on the way' email at accept time, days before the bouquet exists. OUT_FOR_DELIVERY rather than DELIVERED because the photo proves the bouquet was made and dispatched, not that the recipient has it; this rail has no arrival signal. Both writes need a `write_fulfillments` scope the token did not previously carry, and both ride on the SAME `shopify_writeback_enabled` switch as the staff-facing writeback — deliberately one switch, not two (a second was built and backed out on 2026-09-16: 'touch Shopify or don't' is what ops actually reason about). The consequence is worth stating: that switch is ON in production and used to mean only 'write notes, tags and metafields', which a buyer never sees; it now ALSO changes the order's customer-visible fulfilment status, so shipping this code IS the activation, with no dormant period. Because fulfilling at accept makes 'Shopify says fulfilled while a florist is still in flight' the NORMAL state on this rail, `orderClosure()` gained a `weFulfilled` argument (fed by the `shopify_fulfilled` order event this module stamps); without it every accepted florist order would raise a Shopify-conflict on the CX desk within one reconcile tick. Shopify's `archived` signal still conflicts regardless, since that is a human acting in the admin.",
        code: [
          "dashboard/lib/shopifyWriteback.ts (writeBackStatus + safeguard)",
          "dashboard/lib/shopifyFulfillment.ts (fulfilOnAccept + markOutForDelivery — CUSTOMER-VISIBLE)",
          "dashboard/lib/fulfilmentRules.ts (pure helpers + the dry-run signal reader)",
          "ingest-worker/src/shopifyLifecycle.ts (orderClosure's weFulfilled branch)",
          "dashboard/components/settings/IntegrationsPanel.tsx (the one Shopify switch that gates both)",
          "dashboard/lib/externalOps.ts (external-ops log)",
          "dashboard/app/(staff)/operations/page.tsx (SYSTEM → External ops)",
          "dashboard/lib/clientComms.ts (notifyClient — assigned/on_the_way/delivered, idempotent claim)",
          "dashboard/app/api/orders/status/route.ts (fires the on_the_way notice on → out_for_delivery)",
          "dashboard/lib/emailTemplate.ts (shared branded HTML shell)",
          "dashboard/lib/emailToggles.ts (per-email-type on/off read, Settings → Notifications)",
        ],
        branches: [
          {
            id: "fulfilment-scope-missing",
            trigger:
              "The Shopify token lacks `write_merchant_managed_fulfillment_orders`, so both customer-visible fulfilment writes are rejected. CONFIRMED LIVE 2026-09-15: the app has `write_fulfillments` and `read_merchant_managed_fulfillment_orders` but NOT the write half, and both store locations are merchant-managed — so fulfillment orders are readable, their `supportedActions` come back as HOLD/SPLIT with no CREATE_FULFILLMENT, and fulfillmentCreateV2 fails with 'The api_client does not have access to the fulfillment order'. That message reads like a bad token rather than a missing scope, which is what makes this worth writing down. Shopify NEVER upgrades an existing token when the requested scopes change — it needs a fresh OAuth grant.",
            handling:
              "A scope failure comes back in GraphQL's TOP-LEVEL `errors`, not in `userErrors`, so `shopifyFulfillment.ts::graphql` surfaces the message verbatim rather than reporting a silent success; every attempt lands in the External operations log with the real reason. The accept and the photo upload both continue regardless — the fulfilment write is best-effort and must never fail the thing that earned the florist their payout. Re-granting is `dashboard/scripts/shopify-reauth.sh`, which prints the consent URL, verifies the granted scopes against /admin/oauth/access_scopes.json, and rotates SHOPIFY_ADMIN_TOKEN everywhere.",
            manual:
              "Run shopify-reauth.sh with the fulfilment scope added, confirm `write_fulfillments` appears in the granted list it echoes back, then re-run the accept/photo steps on the affected orders — both writes are idempotent.",
            automated:
              "Not yet: nothing detects a systematically-failing scope and alerts on it. Today it shows only as repeated `fulfilment_create` failures in the external-ops log.",
            status: "open",
            milestone: "mvp",
            plan: "Plan 6 / Feature 1",
          },
          {
            id: "fulfilment-already-fulfilled",
            trigger:
              "The Shopify order has no fulfillable fulfillment orders when we try to fulfil it — a retry, a re-accept after a release, or staff fulfilling by hand in the Shopify admin first.",
            handling:
              "Idempotent by construction: `fulfilOnAccept` probes `fulfillmentOrders` first and only sends OPEN/IN_PROGRESS ones. When none are fulfillable it returns ok+skipped carrying the EXISTING fulfilment id, so the later delivery-photo leg still has something to attach its OUT_FOR_DELIVERY event to instead of failing. The photo leg is stateless for the same reason — it re-reads the fulfilment from Shopify rather than trusting anything we stored at accept.",
            manual: "None needed.",
            automated:
              "`fulfillableOrders()` filters to OPEN/IN_PROGRESS (unknown status reads as NOT fulfillable, so an unrecognised shape can never be guessed at against a real order) — covered in lib/fulfilmentRules.test.mjs.",
            status: "handled",
            milestone: "mvp",
            plan: "Plan 6 / Feature 1",
          },
          {
            id: "writeback-fail",
            trigger: "The Shopify write-back API call fails.",
            handling: "Retryable via the effects outbox; the failure (and every write, sent or safeguarded) is now recorded truthfully in the External operations log — writeBackStatus returns its real ok/error instead of swallowing it.",
            manual: "CX sees the failed write in SYSTEM → External operations and can update the Shopify order by hand.",
            automated: "writeBackStatus returns a real outcome + logs it to external_ops; the shopify_writeback effect is retryable through the outbox. A paging alert on repeated failures is still pre-go-live monitoring work.",
            status: "in-progress",
            milestone: "later",
            plan: "Plan 6 / Feature 1",
          },
          {
            id: "writeback-doublesend",
            trigger: "Risk of sending the same client notification twice.",
            handling: "An idempotent claim guarantees each notification fires at most once.",
            manual: "None needed — the claim prevents duplicates.",
            automated: "An idempotent `client_comms` claim guarantees each notification fires at most once.",
            status: "handled",
            milestone: "mvp",
            plan: "Plan 6",
          },
        ],
      },
      {
        id: "delivered",
        label: "Delivered",
        short: "Order fulfilled, florist paid in full, Shopify in sync.",
        kind: "endpoint",
        status: "shipped",
        milestone: "mvp",
        surface: "—",
        description:
          "The happy path terminates: the customer has flowers, the florist is paid 70/30 against real, verified proof, and Shopify reflects the final state. The customer's 'delivered' email now carries the proof photo itself via a signed, expiring link (no login needed); the florist sees their standing, a legible accept/delivery payout split, and a per-order timeline in the PWA. The order rests in a terminal delivered state.",
        code: ["dashboard/lib/clientComms.ts (proof photo in delivered email)", "dashboard/app/api/orders/proof/route.ts (signed customer link)", "dashboard/components/florist/OrderTimeline.tsx", "dashboard/components/florist/offer/OfferPayout.tsx", "dashboard/components/florist/FloristEarnings.tsx"],
      },
    ],
  },
];

// Cross-cutting exceptions that can fire at *any* stage, not just one node.
export const CROSS_CUTTING: Branch[] = [
  {
    id: "x-tick-volume-limits",
    trigger:
      "Enough orders are live at once that one offer-wave tick either reads past PostgREST's 1,000-row cap (the rest are silently missing) or makes more calls than the platform allows one invocation (50 on the Cloudflare Free plan), so the tick dies part way and the orders after that point are never advanced.",
    handling:
      "HANDLED in the garden, by design dormant in production: every wave read is paged, and with WAVES_MAX_ORDERS_PER_TICK set the tick acts on at most that many orders and resumes from a saved cursor.",
    manual:
      "Nothing to do. An order waiting for its turn shows as reaching_out exactly as before; the next tick, a minute later, gets to it.",
    automated:
      "lib/waves.ts reads stale offers, held assignments (one joined read instead of id lists in the URL) and pending orders through lib/fetchAll.ts::fetchAllRows. With the cap set (only the garden dashboard sets it, dashboard/wrangler.jsonc env.garden), lib/waveBatch.ts::WaveBudget limits the orders acted on per call and app_settings.waves_cursor_order_id (supabase/migrations/2026-10-14-waves-cursor.sql) records where the walk stops; the response says `more` and how many subrequests it used, and the garden worker calls again while `more` holds (GARDEN_WAVES_CALLS_PER_TICK). Production leaves the cap unset and walks everything in one call.",
    status: "handled",
    milestone: "later",
  },
  {
    id: "x-planner-instead-of-handoff",
    trigger: "In the garden, Concierge cannot answer a florist alone (a delivery problem, a change request, a complaint, low confidence) and no person is meant to read the queue.",
    handling: "Garden only: the guard's escalation becomes `propose` (the Planner picks a step) or, for money, a promise or terms, `hold` (held by policy, a rule gap, nobody paged). Either way the florist is told at once, in their language and on their channel, that we have the message and will come back shortly. A florist who asked for a person, an opt-out or an open issue still goes to a person.",
    manual: "Nobody for proposed or held cases; the draft is kept on the thread. Rule gaps are read in aggregate.",
    automated: "lib/cxAgentGuard.ts::escalationDecision with `planner: true` (set by lib/agentTurn.ts only when lib/plannerSwitch.ts::plannerEnabled and the thread is support) maps escalations to propose/hold. Every turn and guard decision is appended to `agent_events` (lib/caseEvents.ts), whose pure reducer gives the turn count, what the case waits on, the consecutive model errors, and each problem's plans and hold (one problem per conversation and intent, so a held money question never silences a later question). The acknowledgement leaves through lib/agentTurn.ts's normal send path with the text from lib/plannerAck.ts::ackText and is recorded as an `ack` event; a failed one is recorded, never paged. Rule gaps name their agent (concierge for a guard hold). Money steps never run alone (lib/planPolicy.ts::STEP_POLICY).",
    status: "in-progress",
    milestone: "later",
  },
  {
    id: "x-planner-model-fails",
    trigger: "In the garden, the Planner's model keeps answering badly (no tool call, broken JSON, a wrong shape) or not at all on a problem. Free models are non-deterministic, so one failure says nothing; many failures on similar messages are the signal.",
    handling: "Garden only: three tries per tick, each with the earlier errors compacted into the prompt; the problem stays waiting for the next tick. After 9 consecutive errors it is held with a rule gap naming the error type and a fingerprint of the triggering message. No default plan and never a person. Near-identical messages share a fingerprint, so the failures cluster on Garden pulse, and a cluster that keeps coming back becomes a factory card for the Planner.",
    manual: "Nobody per case. A factory card when the cluster rule fires (agents/factory/cluster-rule.mjs, docs/agent-factory/cluster-cards.md).",
    automated: "lib/planner.ts::planWithErrorCounter (MODEL_TRIES_PER_TICK, MAX_MODEL_ERRORS in lib/caseEvents.ts) and lib/planner.ts::messageFingerprint; lib/gardenPulse.ts::ruleGapCases clusters them by agent, error and fingerprint; agents/factory/cards.mjs::clusterCards turns a cluster into a card only when it recurs on 5 days with more than 20 cases each, across 3 days, each day's Wilson lower bound above the baseline rate.",
    status: "in-progress",
    milestone: "later",
  },
  {
    id: "x-planner-routine-case",
    trigger: "In the garden, a case the Planner would spend a model call on is routine: no florist left (list ran out, no match, or a supply step just failed), a client asking for money back or a discount, or a client who only says thank you.",
    handling: "Garden only: a skill decides it with no AI. No florist walks offer-wider, cold-offer, ask-to-move-date, skipping what was tried, then hands the case to the model; a money ask is held by policy with a rule gap; a pure thank-you closes. Anything with a question, a worry or a detail in it still goes to the model. Measured on the 599 plans of 14-17 Oct: about a third of plans become skills.",
    manual: "Nobody.",
    automated: "lib/planSkills.ts::skillPlan, called by lib/planRunner.ts before lib/planner.ts::callPlanner; the plan is an ordinary `plan` event with model `skill:<name>`, so lib/planPolicy.ts::runPlan still decides what runs.",
    status: "handled",
    milestone: "later",
  },
  {
    id: "x-garden-ai-budget-full",
    trigger: "In the garden, the free model providers run out of room for the day, or orders arrive faster than the AI budget can work them.",
    handling: "Garden only: the router spills to a paid lane (Haiku 5.5 on the garden's OpenRouter key) capped at $0.95 a UTC day, under the key's own $1; the pretend people never use it. New orders wait in a waiting room and are let in oldest first at the pace the governor allows (calls a day, calls an hour, dollars a day); one that waits six hours is turned away.",
    manual: "Nobody.",
    automated: "agents/router/src/limits.ts (dollar book, `x-router-free-only`), agents/router/src/pools.ts::PAID_USD_PER_DAY, ingest-worker/src/gardenBudget.ts::governor, ingest-worker/src/gardenLife.ts (garden_waiting_room, admissionsThisTick).",
    status: "handled",
    milestone: "later",
  },
  {
    id: "x-client-writes-in",
    trigger: "A client emails about their order (a complaint on delivery day, a late order, a nervous or rude message, a question about the florist). The sender is no florist, so the message used to escalate as `unmatched-sender` for a person to read.",
    handling: "Garden only: the sender is matched to the order's buyer and the message goes to the Planner, which chooses a step (apologise and reschedule, ask to move the date, close) instead of a person. The client gets an immediate acknowledgement in the order's language, and the move-date and apology emails are sent in it too. Production still sends it to a person.",
    manual: "Production: CX reads the escalated thread, attached to the order when the reply was threaded to one. Garden: nobody; money steps are held by policy with a rule gap.",
    automated: "lib/conversations.ts::ingestInbound, when lib/plannerSwitch.ts::plannerEnabled, calls lib/clientInbound.ts::recogniseClient (the threaded order's buyer_email, else the buyer's latest order), keeps one thread per client order, logs the message as a `client_reply` communication and appends `plan_requested` with trigger `client_message` to the conversation's case (lib/caseEvents.ts), then lib/plannerAck.ts::acknowledgeClient emails the acknowledgement in `orders.locale` and appends an `ack` event. lib/approvalExecutors.ts::planClientEmail sends email.client.move_date / apology in the same locale. The Planner runs on its own tick (app/api/orders/plans/tick). The garden's pretend clients write these through ingest-worker/src/gardenLife.ts.",
    status: "in-progress",
    milestone: "later",
  },
  {
    id: "x-provisional-hold-never-fires",
    trigger:
      "A shop outside the network accepts a cold offer above `cold_offer_auto_payout_cap_eur` and the accept leg is ISSUED rather than held. The control that is supposed to put an unvetted shop's large payout in front of a human has never fired.",
    handling:
      "OPEN — no handling. Found 2026-09-03 by the France end-to-end run; the reachout-cold-offer node above still describes the hold as working.",
    manual:
      "Nothing catches it today. CX sees an issued leg, not a held one, so there is no row to review and nothing to release or refuse.",
    automated:
      "`shouldHoldAcceptLeg` (lib/coldOffer.ts) returns false on its first line unless `florists.trust_tier === '5'`. The tier is minted by `mintProvisionalActivation`, which writes it only `if (florist.trust_tier == null)` (lib/coldOfferActivate.ts:54) — a deliberate guard so a vetted shop is never downgraded to provisional. But ingest stamps `trust_tier = '2'` on everything it scrapes: 8,254 of the 8,272 non-test florists in the staging table are tier 2 and NOT ONE is tier 5. So the tier is never null, never becomes '5', and the cap is unreachable. Reproduced 2026-09-03 in staging: a Lyon shop outside the network accepted a EUR 104 cold offer and the EUR 72.80 accept leg came back `issued`, `hasCard:true`, with the shop's row showing provisional_activated_at set and trust_tier still '2'. SECOND, INDEPENDENT DEFECT: the cap is compared against the LEG (70% = EUR 72.80), not the payout (EUR 104), so even a correctly-tiered shop would slide under a EUR 90 cap. The fix has to distinguish 'a tier a human chose' from 'the ingest default', which the current schema cannot express. Re-confirmed 2026-09-04, now as a systemic condition rather than one order: SEVEN shops in the staging table carry `provisional_source='cold_offer'` from real accepted cold offers (4 on 20 Aug, 2 on 2 Sep, 1 on 3 Sep) and EVERY ONE is trust_tier '2' — 8,254 of 8,272 non-test florists are tier 2 and the tier-5 count is still exactly zero. Seven accepts, seven times the cap could not fire.",
    status: "open",
    milestone: "mvp",
  },
  {
    id: "x-support-not-joined-mislabelled",
    trigger:
      "A florist with a real order attached to this conversation (a cold offer, or a shop a staff member manually attached to an order via `POST /api/orders/assign`, which deliberately bypasses the onboarded filter — see the florist-accept stage's handling above) writes in before `florists.joined_at` is set. Concierge correctly refuses to answer unattended, but until 2026-10-14 it filed the escalation as `not_eligible`, whose label — \"This shop is excluded, or is not the kind of shop this assistant serves\" — is false on both counts and reads to CX as a dismiss-this-shop signal for what is usually a live lead worth a fast reply.",
    handling:
      "HANDLED. The label: a `not_joined` escalation reason (lib/cxAgentGuard.ts, lib/conversationReasons.ts) fires instead whenever the shop is not excluded, so `not_eligible` now means only what it says. The cause underneath: a shop staff attach by hand now joins when it accepts, exactly as a cold-offer shop does (the owner's decision 2026-10-14, option A), so it stops writing in as un-joined once it has taken the order.",
    manual:
      "CX reads an accurate reason on /conversations and can act on it directly (check the order, answer by hand, or run the shop through onboarding) instead of being pointed at the exclusion queue. A hand-attached shop that has accepted shows as joined, with the same provisional tier a cold-offer shop gets.",
    automated:
      "lib/agentTurn.ts computes `eligible` (support: `!excluded_at`) and `notJoinedYet` (support: `!joined_at`) separately and passes both to lib/cxAgentGuard.ts::escalationDecision, which checks `eligible` first and `notJoinedYet` second. At assign, app/api/orders/assign stamps `offer_audience='manual'` when lib/coldOffer.ts::manualAssignAudience says the shop is neither joined nor onboarded (the same shops the wave would have had to cold-offer); joined or onboarded shops stay `network` and nothing changes for them. At accept, app/api/florist/respond and app/api/orders/reachout both ask lib/coldOffer.ts::provisionalSourceOnAccept, which maps `cold` → `cold_offer` and `manual` → `manual_assign`, and call the one lib/coldOfferActivate.ts::mintProvisionalActivation before payoutOnAccept. Same tier, radius, `joined_at` and stage as a cold accept; only `florists.provisional_source` differs. `manual` deliberately does not feed lib/sequences/reconcile.ts::enrolLapsedColdOffers, because a manual candidate can lapse without ever having been sent an offer. Needs supabase/migrations/2026-10-14-offer-audience-manual.sql; until it runs, the stamp is refused, logged, and the shop behaves as before.",
    status: "handled",
    milestone: "later",
  },
  {
    id: "x-provisional-shop-skips-cold-gate",
    trigger:
      "A shop that joined by accepting a cold offer is treated as ONBOARDED on every later order, so the cold-offer gate — lead-time floor, payout ceiling, contactability — is skipped for it entirely.",
    handling:
      "OPEN — no handling. Found 2026-09-04 by the France re-run; it is a downstream consequence of x-provisional-hold-never-fires.",
    manual:
      "Invisible to the desk: the offer looks like an ordinary network offer (`offer_audience='network'`), so there is no approval row and nothing signals that a gate was bypassed.",
    automated:
      "`mintProvisionalActivation` writes `lifecycle_stage='onboarding'`, and lib/waves.ts computes `candOnboarded = ['production','onboarding'].includes(candStage)`. An onboarded candidate is auto-offered directly, never reaching `coldOfferBlock`. Measured 2026-09-04 in staging: a scraped Lyon florist provisionally activated by the previous day's run took rank 1 on all four Lyon test orders and was auto-offered a 4-hour-lead order and a EUR 137 payout with NO gate — the same two scenarios that correctly blocked `too-urgent` and `payout-too-high` a day earlier. The gate itself is intact: when the ladder walked past that shop, rank 2 blocked both correctly. Compounds with x-provisional-hold-never-fires, since trust_tier stays '2': the same unvetted shop is simultaneously ungated on offers and unheld on money. It also silently removes TEST COVERAGE — three of the four cold-offer scenarios no longer reach the cold path at rank 1. Fix: a provisional shop must not count as onboarded for the cold gate (and should not carry the full `match_weight_onboarded`, the heaviest weight in the config at 3.0 against 0.25 for distance, which is why one such shop outranked 160 others on every Lyon order).",
    status: "open",
    milestone: "mvp",
  },
  {
    id: "x-refill-races-placement",
    trigger:
      "The wave engine writes candidates onto — or sends an offer for — an order that was accepted moments earlier, because the order's status changed between the tick's SELECT and its write.",
    handling: "HANDLED — `stillAdvanceable()` re-reads the order's status immediately before the refill and the send.",
    manual:
      "Nothing to do on the placed order itself; the sibling sweep expires the stray offer within a tick. The cost is a florist who was emailed an order that is already gone and would be refused if they tapped Accept (`accepted` is not in ACCEPTABLE_ORDER_STATUSES).",
    automated:
      "`advanceWaves` selects `status in ('matched','reaching_out')` then works its orders one at a time, so an accept can land between the SELECT and the write. The escalate branch was always CAS'd on `o.status`; the refill and send paths had no row to CAS against, so they now re-read via `stillAdvanceable()` (lib/waves.ts) immediately before writing. That narrows the window to one indexed read rather than closing it — the same guarantee the escalate CAS gives. Originally measured 2026-09-03: an order accepted at 11:15:12.6, paid at 11:15:12.9, and a `rematched` event added three real Paris florists at 11:15:20.2; a second order showed the send-path twin `payout_accept → shopify_writeback → outreach_sent`. Re-run 2026-09-04 against the same two scenarios: the accepted order's timeline ends at `shopify_writeback` with no later `rematched`, and the late-accept order's refill landed 7s BEFORE the accept with its three new candidates closed `expired`, `sent_at` NULL — no florist was emailed a placed order.",
    status: "handled",
    milestone: "mvp",
  },
  {
    id: "x-open-never-recorded",
    trigger:
      "A florist opens the offer, reads it, and does not answer. The system cannot tell that apart from a florist who never opened the email at all.",
    handling: "HANDLED — redeeming the offer's magic link stamps `status='opened'` and `opened_at` (lib/offerOpened.ts).",
    manual:
      "The desk can now prefer phoning the shop that actually looked: an opened offer is distinguishable from an unopened one.",
    automated:
      "Deliberately NOT the email provider's open pixel: transport is per-environment and staging runs Ongage, which has no open webhook at all, so the pixel would be missing exactly where we do QA — and a pixel is a claim about a mail client, not a person. A click-through is stronger evidence and we own it on both transports. `markOfferOpened` is CAS'd from 'sent', so a re-open keeps the first timestamp and a later state is never rewound, and it is not stamped on the staff view-as branch. Verified 2026-09-04 in staging: redeeming an offer's real `purpose='offer'` token took `use_count` 0 → 1 and left the assignment `status='opened'`, `opened_at` set. CAVEAT FOR ANYONE RE-TESTING: `scripts/act-as.mjs::floristSession` mints its token with NO `assignment_id`, so `markOfferOpened(admin, null)` is correctly a no-op and `france-e2e-florist.mjs open` reports a FALSE FAILURE. Redeem the row's real offer token instead until that harness is fixed.",
    status: "handled",
    milestone: "mvp",
  },
  {
    id: "x-silence-reads-as-refusal",
    trigger:
      "An order whose offers all EXPIRED unanswered is described to the operator as 'Every shop we asked said no'. Silence is rendered as refusal.",
    handling: "HANDLED — the two CxReasons now render as separate headlines in lib/operator.ts.",
    manual:
      "The rule the desk works to is that a shop which refused is never phoned. The old headline made an operator conclude there was nobody left to ring, when in fact every one of those shops was still callable — they simply never answered.",
    automated:
      "Two different CxReasons used to map to the same headline in lib/operator.ts. `wave_ceiling` ('No answer after every wave — untried shops remain') now renders as 'No answer from any shop we asked'; the genuinely-ambiguous 'Needs next florist — no live offer' renders as 'Nobody is being asked right now', which claims neither refusal nor silence because that row cannot tell which it was. Measured 2026-09-03 on an order with five expired offers and zero declines; verified 2026-09-04 by scripts/verify-operator.mjs, where a `wave_ceiling` order renders the new headline and 'Every shop we asked said no' no longer appears anywhere in the product.",
    status: "handled",
    milestone: "mvp",
  },
  {
    id: "x-ai-reply-wrong",
    trigger:
      "The outreach assistant answers a florist unattended and says something false, off-policy, or simply wrong — in a language nobody on the team reads.",
    handling:
      "Bounded by escalating whole question CATEGORIES before the answer is examined, plus a hard ceiling on unattended replies.",
    manual: "Every escalated thread lands on /conversations with the draft, its confidence and the reason, for a human to approve, edit or replace.",
    automated:
      "The gate is deterministic and independent of the model's opinion of itself. (1) CATEGORY: for a PROSPECT, anything about money, contracts, legal terms, a complaint, or a request for a person escalates on the INTENT, before the generated text is looked at — recognising the question is far more reliable than vetting the answer. (2) The TURN CAP: after N consecutive unattended replies a human takes over regardless of confidence; a human replying resets it. (3) Backstops: an invented currency figure or percentage outside the approved 70/30, or a promise of orders, forces escalation — including claims the model itself lists in `facts_asserted` but keeps out of its prose. The model is also handed the approved pitch VERBATIM from the catalog, so editing /messages changes what it may say with no deploy. Every reply is stored with its full structured output, because \"why did it think that\" is unanswerable from a confidence score. For a florist ALREADY IN THE NETWORK the same gate runs, with two differences: the allowed figures are not a constant but the exact amounts lib/supportFacts.ts read out of that order's payouts a moment earlier (lib/cxAgentGuard.ts::moneyClaimOutsideFacts escalates any figure outside that set — so \"we paid you 84.50\" can be said and \"84.51\" cannot); and CATEGORY escalation covers all seven non-answerable support intents — complaint, wants_human, delivery_problem, opt_out, change_request, question_terms and unclear (`SUPPORT_ESCALATE_INTENTS`, all seven live as of 2026-08-15 ahead of the production pilot) — leaving order_status, payout_status, photo_help and the disclosure-guarded asked_if_ai as the only intents a support reply can send unattended. An order with an open issue escalates unconditionally before a reply is even drafted (lib/supportFacts.ts::hasOpenIssue, checked in lib/agentTurn.ts, with lib/cxAgentGuard.ts::escalationDecision's own `openIssue` check as a backstop) — a human is already on the thread, so nothing goes out, not even the asked_if_ai disclosure. A support thread with no order, or no facts to read, never reaches the model at all. `not_eligible` (an excluded shop, or the wrong taxonomy for this shop's `joined_at`) and `not_joined` (support-only: a real order is attached but the shop hasn't finished joining) are two different reasons on the /conversations queue since 2026-10-14 — folding the second into the first read as \"exclude this shop\" to CX for what is usually a live cold-offer or staff-manual-assign lead (see the x-support-not-joined-mislabelled branch below).",
    status: "in-progress",
    milestone: "later",
  },
  {
    id: "x-inbound-autoresponder",
    trigger:
      "An out-of-office reply arrives. If it were answered, two machines would write to each other indefinitely, with a real business's inbox in the middle — and it would also count as engagement and advance the funnel.",
    handling: "Detected and suppressed before the model exists in the path at all.",
    manual: "None needed.",
    automated:
      "`classifyInbound` checks `Auto-Submitted`, `X-Autoreply`, `Precedence: bulk`, `List-Id`, plus localized subject prefixes in all six markets, and stores the message `suppressed` without a reply. Opt-out is checked FIRST, so an auto-responder that happens to contain an unsubscribe request is still honoured as one.",
    status: "handled",
    milestone: "later",
  },
  {
    id: "x-inbound-opt-out",
    trigger: "A florist replies STOP, or asks to be removed, and an eager assistant tries to talk them out of it.",
    handling: "The model never sees it. The opt-out is applied, every live sequence stops, and the thread closes.",
    manual: "None needed.",
    automated:
      "`isOptOut` runs before anything else on the inbound path: a BARE keyword in any of the six markets is an opt-out, while the same word inside a sentence is not — \"stop by the shop next week\" and \"arrêtez-moi si je me trompe\" are ordinary replies from interested people, and treating either as an opt-out would silently lose them. The word lists are accent-folded once at load, which is what makes \"löschen\" and \"loeschen\" the same word.",
    status: "handled",
    milestone: "later",
  },
  {
    id: "x-inbound-wrong-order",
    trigger:
      "A florist's reply is attached to the wrong order, putting one shop's words on another shop's job — or on the right shop's other order, which is quieter and worse.",
    handling: "Prevented by refusing to guess. Matching is ordered, deterministic, and stops rather than approximating.",
    manual: "An unmatched message escalates with no order, and CX attaches it by hand from /conversations.",
    automated:
      "lib/inboundMatch.ts tries exactly two things: a signed reply-address token (r+<token>@ the inbound domain) minted per ASSIGNMENT, so it settles order and florist together; then In-Reply-To / References against the Message-ID we set on the original email. There is deliberately no third step reading the subject or the body — a florist with three live orders writing \"the address is wrong\" has not told us which one. A match naming a different florist than the sender is DISCARDED rather than preferred, which is what happens when a thread is forwarded between shops.",
    status: "handled",
    milestone: "later",
  },
  {
    id: "x-support-facts-stale",
    trigger:
      "The facts are read, the model writes, and by the time the florist reads the answer the payout has moved. They were told the 30% is waiting on their photo; it released while they were reading.",
    handling: "Not solved. The window is seconds and the failure is a stale truth rather than an invented one, but it is real.",
    manual: "The florist sees the live figures on the same order page the chat sits under, and a second question re-reads.",
    automated:
      "Nothing yet. Options if it bites: re-read the facts immediately before send and abandon the reply if any amount changed, or state the reading time in the answer. Both cost latency on the common case to fix an uncommon one, so neither is built until we see it happen.",
    status: "open",
    milestone: "later",
  },
  {
    id: "x-support-thread-unanswered",
    trigger:
      "The assistant hands a florist's question to a person, tells them so, and nobody picks it up. A promise with a clock on it is worse than never having offered one.",
    handling: "The escalation is put where CX actually works, not only where it was written.",
    manual: "Reply from /conversations, which pre-fills the assistant's refused draft so approving it is one click.",
    automated:
      "An escalated support thread now raises a `message`-category reason on the /cx desk against its order (lib/cxAttention.ts), always flagged unread. Before this it set cx_unread and appeared on /conversations alone — a page nobody opens between orders — so a waiting florist was invisible on the surface the team lives on.",
    status: "handled",
    milestone: "later",
  },
  {
    id: "x-cold-payout-fraud",
    trigger:
      "The cold offer is a fraud primitive if left unbounded: list a plausible florist on a map, wait to be offered an order, click accept, take the 70% card, never deliver. The shop passed no checks, its address is self-declared, and the listing is one we scraped.",
    handling:
      "Bounded rather than prevented. Four limits stack so a successful fraud is small, one-at-a-time, and visible.",
    manual:
      "CX can exclude the shop, which stops every future offer and any live recruiting run.",
    automated:
      "(1) `cold_offer_max_payout_eur` means the expensive order is never cold-offered — the cheapest control, and it removes the whole tail. (2) Tier 5's EUR 150 exposure cap means a provisional shop can hold ONE order's exposure at a time; `guardExposureAndFunds` already sums outstanding issued+pending legs per florist. (3) Above `cold_offer_auto_payout_cap_eur` the leg is held for a human. (4) Cards are single-use, so loss is bounded to the issued amount. Shipping recommendation: leave `cold_offer_enabled` off and turn it on per city once a few have run through CX by hand.",
    status: "in-progress",
    milestone: "later",
  },
  {
    id: "x-persona-is-not-real",
    trigger:
      "Every outreach follow-up is signed by a named person who does not exist — one invented persona per market. A prospect asks to meet her, calls asking for her by name, or two florists in one city compare emails and notice the same person wrote both.",
    handling:
      "Settled: every agent discloses it is AI. In writing, once per thread on the first model-written reply, and immediately whenever asked. By voice, unprompted, before anything else.",
    manual:
      "Anything the agent hands over is answered by a real person on the persona's own reply-to address, so the name a florist has been writing to is still the name that picks it up.",
    automated:
      "EU AI Act Art. 50 has applied since 2 August 2026 in all five markets, and the persona is exactly what removes the \"obvious from context\" exemption — an AI-written email signed by a named human points the reader the other way. So: `conversations.ai_disclosed_at` stamps the one-per-thread proactive line (a timestamp, not a flag, because \"when did we tell them\" is the answerable question); intent `asked_if_ai` is ANSWERED rather than escalated, exempt from the turn cap and the confidence floor because escalating it produces the silence the rule exists to prevent, and guarded by `replyDisclosesAi` so a fluent non-answer cannot go out. The persona's signature NOTE is suppressed on AI replies — the seeded one reads \"I read every reply myself\", which under a disclosure line contradicts it outright. Voice discloses in the opening before capture begins, recorded per call on `voice_calls.notice_played`. The FUNNEL touches carry no disclosure and need none: they are hand-written catalog copy, a mail merge rather than an AI interacting with anyone.",
    status: "handled",
    milestone: "mvp",
  },
  {
    id: "x-sequence-preempt",
    trigger:
      "A real order lands near a florist who is midway through the recruiting funnel, so they could get 'we have an order for you' and 'join our network' in the same hour.",
    handling:
      "An order offer preempts recruiting: the run pauses, and resumes at the same step if the order goes elsewhere.",
    manual: "CX can stop a recruiting run from the florist's page before offering.",
    automated:
      "`pauseRecruitingFor` parks every live recruiting run when the offer goes out. Resuming is a SWEEP, not a callback: an order stops being live in half a dozen ways (it expires, they decline, someone else accepts, staff withdraw or reassign it, the order is cancelled), and hanging a hook off each one guarantees the next path added forgets. Every tick, `resumePausedRecruiting` asks the only question that matters — does this florist have a live offer right now? — and reactivates the run at the SAME `step_index`, so a prospect who had seen two touches resumes at the third rather than starting the pitch over. `accepted` counts as live, so nothing recruits a florist mid-delivery. A global minimum gap between any two touches backs this up.",
    status: "handled",
    milestone: "mvp",
  },
  {
    id: "x-test-shops",
    trigger:
      "Test mode makes the florist experience impossible to actually drive. It redirects every florist email/SMS to the shared staff test inbox and swaps the magic link and the unsubscribe link for inert sentinels — correctly, because that inbox is readable by several staff and a magic link is a LOGIN to a real shop. The cost is that nobody can click the link they were just sent, so the one flow that matters most to a florist is the one flow we can never rehearse end to end.",
    handling:
      "A per-florist `is_test_shop` flag marks a shop WE own. For those, and only those, test mode stops redirecting and stops substituting: real address, real tokens, working link. Every unflagged florist keeps the old behaviour byte for byte, so the safety property doesn't depend on anyone remembering anything — it is a property of the row, not of a per-send checkbox a mis-click could defeat. Sends are still logged with `test_mode: true` PLUS `test_shop: true`, so the audit explains why real credentials went out rather than hiding it. Matching is governed separately by `app_settings.test_shop_matching`: 'exclude' (default) keeps a paying customer's order off a test shop entirely; 'only' routes matching exclusively to test shops so the whole loop can be watched fire. 'only' is a deliberate foot-gun — orders outside a test shop's radius then match nobody and escalate — so the Settings copy says so plainly.",
    manual:
      "Admin-only toggle on the florist page (ops can't set it — it is a trust decision, not an operational edit). The matching mode is a Settings selector.",
    automated:
      "`lib/offerVars.ts` resolves `redirectToTestInbox = testMode && !isTestShop` once and every consumer branches on THAT, never on `testMode` directly; `lib/floristMagicEmail.ts` applies the same rule. `passesHardFilter` in BOTH matcher copies (dashboard/lib/match.ts + ingest-worker/src/match.ts) takes the mode as an argument and defaults to 'exclude', so a caller that was never updated fails safe rather than open; the worker's `loadTestShopMatching` likewise falls back to 'exclude' on any read error.",
    status: "handled",
    milestone: "mvp",
    plan: "Test shops",
  },
  {
    id: "x-forwarded-magic-link",
    trigger:
      "A florist forwards one of our messages — to a colleague, a personal address, a WhatsApp group — and the sign-in link inside it grants whoever opens it full access to that florist's account: orders, payout history, bank details, team invites.",
    handling: "Bounded, not solved: 30-day expiry, per-send revocation, and a use_count that makes sharing visible.",
    manual:
      "CX revokes the specific token (`florist_magic_tokens.revoked_at`) without locking the florist out of anything else they hold. A `use_count` far above 1 on one token is the signal worth looking at.",
    automated:
      "Every token expires 30 days after mint and is scoped to one send. Nothing today detects a forward as it happens, or ties a redeem to the device/IP the message was sent to.",
    // Deliberately `open`, so it surfaces in the page's help-wanted roll-up:
    // we chose the full-session model with eyes open (the alternatives — a
    // re-auth wall on money screens, or an order-scoped no-session token —
    // were weighed and rejected), but "bounded" is not the same as "handled",
    // and the team should keep seeing this until it is.
    status: "open",
    milestone: "later",
  },
  {
    id: "x-magic-link-session-fixation",
    trigger:
      "The reverse of a forwarded link: someone sends a florist a link built from THEIR OWN magic token. The florist clicks, is silently signed into the sender's account, and any photo, note or detail they enter lands in the wrong shop's records.",
    handling: "Staff sessions are protected; a florist-to-florist swap is currently silent.",
    manual: "None today — nothing surfaces the swap to the florist at the moment it happens.",
    automated:
      "A staff session is never swapped: an allow-listed ops/admin user lands in read-only view-as instead, and any other staff role is bounced to sign-in. A florist already signed in as a DIFFERENT florist is still swapped without a prompt — the deliberate cost of keeping the core one-click flow one click. A 'Continue as <shop>?' interstitial is the known fix, weighed and deferred.",
    // `open` on purpose: staff are covered, florists aren't, and the team
    // should keep seeing that gap rather than have it buried in a comment.
    status: "open",
    milestone: "later",
  },
  {
    id: "x-order-edited",
    trigger: "Customer edits the order on Shopify after it's in flight (address, items, date).",
    handling: "`orders/edited` webhook triggers an unwind / re-evaluation.",
    manual: "CX re-checks the changed order and re-assigns if the florist can no longer fulfil it.",
    automated:
      "The `orders/edited` webhook triggers an unwind/re-evaluation path (handleEditClawback) so a changed order isn't fulfilled against stale data.",
    status: "handled",
    milestone: "mvp",
    plan: "Plan 6",
  },
  {
    id: "x-order-cancelled",
    trigger: "Customer cancels the order on Shopify mid-flight.",
    handling: "`orders/cancelled` webhook unwinds the assignment + claws back the accept leg.",
    manual: "CX confirms the cancellation with the florist so they stand down.",
    automated:
      "The `orders/cancelled` webhook unwinds the assignment and claws back any accept-leg payout already issued (unwindOrder + clawbackOrder).",
    status: "handled",
    milestone: "mvp",
    plan: "Plan 6",
  },
  {
    id: "x-worker-outage",
    trigger: "The Worker or Supabase is down while events arrive.",
    handling: "Durable Workflows + queue retries recover; lost events need the sweep.",
    manual: "On recovery, CX reconciles in-flight orders against Shopify by hand.",
    automated:
      "Durable Workflows + queue retries recover in-flight orders; a reconciliation sweep catches anything lost entirely during the outage.",
    status: "planned",
    milestone: "later",
    plan: "Monitoring (pre-go-live)",
  },
  {
    id: "x-fraud",
    trigger: "A florist games the loop (accepts and never delivers, fakes proof to trigger payout).",
    handling: "Trust tiers + clawback + proof verification gate exposure.",
    manual: "CX reviews a suspicious florist's history and drops their trust tier.",
    automated:
      "Trust tiers gate exposure, AI proof verification gates the payout, and repeated flags auto-downgrade the tier; proactive fraud detection is still open.",
    status: "open",
    milestone: "later",
  },
  {
    id: "x-cx-spof",
    trigger: "A time-critical order stalls (unsent offer, cold wave, held payout) and no human is looking.",
    handling: "A cron-driven sweep pages CX by email (on by default, toggleable in Settings → Notifications — the safety alert) + web-push (opted-in staff devices, never gated by that toggle) whenever SLA-breaching or high-urgency work sits unattended, throttled so a busy queue re-alerts at most every 15 minutes (immediately on any change to the breaching set).",
    manual: "CX can still open the Control panel anytime; the sweep is a backstop, not a replacement for watching the hub.",
    automated: "POST /api/cx/alert-sweep (ingest-worker cron, every minute) filters gatherAttention() to urgency ≥ 75 or a passed SLA, emails cx_email (unless app_settings.email_cx_alert_enabled is off, in which case only the web-push fires) and web-pushes subscribed staff, throttled via app_settings.cx_alert_last_sent_at/cx_alert_last_hash. Binding offer expiry self-escalation is separate, still open (Sprint 2). BUILT BUT INERT IN PRODUCTION, found 2026-09-16: the sweep ran and decided to alert 1,408 times in 14 days, and every one was skipped: the email leg is `disabled-by-settings` and no staff device is subscribed to push (`no subscriptions`). So it currently pages nobody. The volume (~100 a day) suggests the email leg may have been turned off on purpose for noise, which is a threshold problem, not a reason to page no one. Needs a decision: tune the threshold and re-enable email, or get staff devices subscribed.",
    status: "open",
    milestone: "mvp",
  },
  {
    id: "x-customer-refund",
    trigger: "An order is cancelled / disputed after the customer was already charged.",
    handling: "Only florist-side clawback exists — there's no customer-refund path or record in our system.",
    manual: "CX issues an ad-hoc Shopify refund with nothing recorded on our side.",
    automated: "A customer-refund path + client dispute intake (`order_issues` source=client) records and drives it (Sprint 5).",
    status: "open",
    milestone: "later",
  },
  {
    id: "x-manual-payout-blind-spot",
    trigger: "A manual (order-less) ad-hoc payout fails, gets stuck, or its card is disputed.",
    handling: "Nothing surfaces it today — the CX attention list and the dead-effect surfacing are both order-scoped and drop any row with no order_id/assignment_id.",
    manual: "Staff must notice a stuck/disputed manual payout by checking the Payments ledger directly (filter by status) — there is no proactive alert.",
    automated: "None yet — would need a non-order CX lane or a distinct alerting path for order-less money.",
    status: "open",
    milestone: "later",
  },
];

// ---------------------------------------------------------------------------
// Derived helpers (pure) — used for the legend counts, the MVP roll-up, and the
// per-stage error-handling health bar. Kept here so the page stays presentational.

export interface LifecycleSummary {
  stages: number;
  stagesShipped: number;
  branches: number;
  branchesHandled: number;
  branchesInProgress: number;
  branchesOpen: number;
  /** MVP-milestone failure modes not yet fully handled (open/in-progress/planned)
   *  — the "must-close before go-live" count. */
  mvpGaps: number;
}

const allBranches = (): Branch[] => [
  ...PHASES.flatMap((p) => p.stages.flatMap((s) => s.branches ?? [])),
  ...CROSS_CUTTING,
];

export function summarize(): LifecycleSummary {
  const stages = PHASES.flatMap((p) => p.stages);
  const branches = allBranches();
  return {
    stages: stages.length,
    stagesShipped: stages.filter((s) => s.status === "shipped").length,
    branches: branches.length,
    branchesHandled: branches.filter((b) => b.status === "handled").length,
    branchesInProgress: branches.filter((b) => b.status === "in-progress").length,
    branchesOpen: branches.filter((b) => b.status === "open").length,
    mvpGaps: branches.filter(
      (b) => b.milestone === "mvp" && b.status !== "handled",
    ).length,
  };
}

/** Every branch we've flagged as an open question, with the stage it hangs off
 *  (or "Anywhere" for cross-cutting) — powers the "help wanted" roll-up. */
export function openQuestions(): Array<{ stageLabel: string; branch: Branch }> {
  const fromStages = PHASES.flatMap((p) =>
    p.stages.flatMap((s) =>
      (s.branches ?? [])
        .filter((b) => b.status === "open")
        .map((branch) => ({ stageLabel: s.label, branch })),
    ),
  );
  const fromCross = CROSS_CUTTING.filter((b) => b.status === "open").map((branch) => ({
    stageLabel: "Anywhere",
    branch,
  }));
  return [...fromStages, ...fromCross];
}

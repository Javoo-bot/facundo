import { createServiceClient } from "@/lib/supabaseAdmin";
import { sendOffer } from "@/lib/reachoutSend";
import { captureError } from "@/lib/monitor";
import { isFulfilmentSlaBreached } from "@/lib/fulfilmentBreach";
import { coldOfferBlockReason } from "@/lib/coldOffer";
import { workingSetConfig } from "@/lib/workingSetServer";
import { orderWorkingSetDecision } from "@/lib/workingSetDecision";
import { suggestedTimeoutMinutes, DEFAULT_OFFER_WINDOWS, type OfferWindows } from "@/lib/reachout";
import { refillDecision, escalationApprovalPreview, type EscalationReason } from "@/lib/waveGuards";
import { refillCandidates, isRefillError } from "@/lib/candidateRefill";
import type { OrderStatus } from "@/lib/orderStatus";
import { loadMatchConfig } from "@/lib/matchConfig";

// The offer-wave engine. Runs on a cron tick. Its behavior is gated by the global
// `workflow_mode` (the automation level):
//   - manual: it only expires lapsed offers + escalates when candidates run out.
//             It never sends or files an approval — humans drive every send.
//   - auto:   it auto-sends the next-ranked candidate (including the FIRST offer on
//             a freshly-matched order) REGARDLESS of the candidate's lifecycle
//             stage — a prospect never needs human approval in auto, same as an
//             onboarded shop — and asks ingest/refill for exhausted batches while
//             delivery time remains before escalating.
//   - semi:   instead of sending, it FILES a pending offer approval for a human to
//             approve/edit/skip (see lib/approvals.ts); at most one pending approval
//             per order.
// Always (every mode): a live offer past its binding `offer_expires_at` is expired
// (CAS-guarded so a florist accepting in the same instant wins), and an order that
// runs out of candidates escalates to CX. Also always: an `accepted` order whose
// florist went dark (no ready/delivered progress, past its SLA or delivery buffer)
// is PROPOSED to CX as a reassign approval rather than handed over unattended — an
// only reshuffles who's queued next (whether that next offer actually SENDS is
// still mode-gated below); escalates instead if no candidate remains. Idempotent
// under overlapping ticks.

// `reoffered` is gone: nothing reoffers any more. A fulfilment breach now files
// a `reassign` approval for a human (counted in `filed`) instead of handing the
// order to the next shop unattended, because an accepted order belongs to the
// florist who accepted it. Keeping a counter that could only ever report 0
// would be a worse lie than dropping it.
export interface WaveResult { expired: number; advanced: number; filed: number; escalated: number; stuck: number; refilled: number; skipped: number }

/** How far down the candidate list one tick will walk past shops it cannot
 *  reach at all. A bound, not a policy: the skipped rows are closed as it goes,
 *  so a longer list simply continues on the next tick a minute later. Keeps one
 *  order with a run of unreachable candidates from monopolising the tick. */
const UNREACHABLE_SCAN_LIMIT = 5;

/** The wave-loop knobs (Settings → Matching / Offers) plus the response-window
 *  ladder, read once per tick. Never throws: a failed read yields the shipped
 *  defaults, because the wave engine must not stop when a settings read does —
 *  the same rule loadMatchConfig follows. */
interface WaveSettings { maxWaves: number; cxReserveHours: number; parallelSends: number; windows: OfferWindows }

async function waveSettings(admin: ReturnType<typeof createServiceClient>): Promise<WaveSettings> {
  try {
    const { data: s } = await admin
      .from("app_settings")
      .select(
        "match_max_waves, cx_reserve_hours, offer_parallel_sends, offer_window_rush_min, offer_window_sameday_min, offer_window_standard_min, offer_window_far_min, offer_window_nodate_min"
      )
      .eq("id", 1)
      .maybeSingle();
    return {
      maxWaves: s?.match_max_waves ?? 4,
      cxReserveHours: s?.cx_reserve_hours ?? 2,
      parallelSends: Math.max(1, Math.min(10, Number(s?.offer_parallel_sends ?? 1))),
      // Per-tier fallback, mirroring lib/offerVars.ts: one null column degrades
      // to that tier's shipped default, not to zero.
      windows: {
        rushMin: s?.offer_window_rush_min ?? DEFAULT_OFFER_WINDOWS.rushMin,
        samedayMin: s?.offer_window_sameday_min ?? DEFAULT_OFFER_WINDOWS.samedayMin,
        standardMin: s?.offer_window_standard_min ?? DEFAULT_OFFER_WINDOWS.standardMin,
        farMin: s?.offer_window_far_min ?? DEFAULT_OFFER_WINDOWS.farMin,
        noDateMin: s?.offer_window_nodate_min ?? DEFAULT_OFFER_WINDOWS.noDateMin,
      },
    };
  } catch {
    return { maxWaves: 4, cxReserveHours: 2, parallelSends: 1, windows: DEFAULT_OFFER_WINDOWS };
  }
}

async function currentMode(admin: ReturnType<typeof createServiceClient>): Promise<"manual" | "semi" | "auto"> {
  const { data } = await admin.from("app_settings").select("workflow_mode").eq("id", 1).single();
  return (data?.workflow_mode as "manual" | "semi" | "auto" | undefined) ?? "manual";
}

/** How many waves this order has already had. The first `match_top_n`
 *  candidates are wave 1 (written by the match, before any refill), so this is
 *  refills + 1. Counting the `rematched` events rather than dividing the
 *  assignment count by topN keeps it correct when topN changed mid-order, when
 *  a wave came back short (fewer than topN florists left), or when staff added
 *  a florist by hand. */
async function wavesSoFar(admin: ReturnType<typeof createServiceClient>, orderId: string): Promise<number> {
  const { count } = await admin
    .from("order_events")
    .select("id", { count: "exact", head: true })
    .eq("order_id", orderId)
    .eq("type", "rematched");
  return (count ?? 0) + 1;
}

/** May we offer THIS order to this not-yet-onboarded shop? Delegates every
 * decision to the pure `coldOfferBlockReason`; this function only fetches its
 * inputs. Fails closed on any read error — an unreadable row must never be the
 * reason a company card goes to a stranger. */
/**
 * Why this shop may not be cold-offered this order, or null when it may.
 *
 * Returns the REASON rather than a verdict. It used to return a boolean, and
 * the string coldOfferBlockReason() had just computed was discarded one line
 * later — so an approval filed for CX said only "a human must send this", and
 * "37% of orders never got an offer" could not be broken down into why. Nobody
 * could tell whether the payout ceiling, the minimum lead time or missing email
 * addresses was the thing to change.
 */
async function coldOfferBlock(
  admin: ReturnType<typeof createServiceClient>,
  floristId: string,
  orderId: string,
  deliveryAt: string | null
): Promise<string | null> {
  try {
    const [{ data: settings }, { data: florist }, { data: assignment }] = await Promise.all([
      admin.from("app_settings").select("cold_offer_enabled, cold_offer_max_payout_eur").eq("id", 1).single(),
      admin
        .from("florists")
        .select("id, email, joined_at, excluded_at, deleted_at, lifecycle_stage, order_emails_opt_out, lat, lng")
        .eq("id", floristId)
        .single(),
      admin
        .from("order_assignments")
        .select("payout_price")
        .eq("order_id", orderId)
        .eq("florist_id", floristId)
        .limit(1)
        .maybeSingle(),
    ]);
    if (!florist) return "florist-missing";
    return coldOfferBlockReason(
      florist,
      { payoutEur: (assignment?.payout_price as number | null) ?? null, deliveryAt },
      settings,
      Date.now()
    );
  } catch (e) {
    // An eligibility check that THREW is not the same as a shop that failed a
    // gate, and recording it as one would hide a broken lookup inside a normal
    // business reason. It still blocks the send — failing closed is right — but
    // it says so in its own words.
    captureError("waves.coldOfferBlock", e);
    return "lookup-failed";
  }
}

/** The two statuses this engine is entitled to act on. */
const ADVANCEABLE: OrderStatus[] = ["matched", "reaching_out"];

/**
 * Is this order STILL one we may act on?
 *
 * The tick selects its orders once and then works them one at a time, so an
 * order can be accepted — and paid — between the select and the write. Measured
 * 2026-09-03: a florist accepted at 11:15:12.6, the accept leg was issued at
 * 11:15:12.9, and the same tick added three fresh candidates at 11:15:20.2.
 * Eight seconds after the money moved, on an order nobody could still take.
 *
 * The escalate branch at the bottom of this function already guards itself, by
 * CAS-ing its UPDATE on `o.status`. The two writes above it could not: a
 * candidate INSERT and an outbound email have no row to CAS against. So they
 * re-read instead, immediately before writing.
 *
 * This narrows the window to a single indexed read rather than closing it — an
 * accept landing inside that read still races. It is the same guarantee the
 * escalate CAS gives, and the failure it prevents (emailing a florist an order
 * that is already placed, then refusing them when they say yes) is the one that
 * actually reached a shop.
 */
async function stillAdvanceable(
  admin: ReturnType<typeof createServiceClient>,
  orderId: string
): Promise<boolean> {
  const { data } = await admin.from("orders").select("status").eq("id", orderId).maybeSingle();
  return data != null && ADVANCEABLE.includes(data.status as OrderStatus);
}


export async function advanceWaves(): Promise<WaveResult> {
  const admin = createServiceClient();
  const nowIso = new Date().toISOString();
  const mode = await currentMode(admin);
  const wsConfig = await workingSetConfig(admin);
  const waveCfg = await waveSettings(admin);
  let expired = 0, advanced = 0, filed = 0, escalated = 0, stuck = 0, refilled = 0, skipped = 0;

  // 1. Expire lapsed live offers (sent/opened past their binding expiry) — all modes.
  const { data: stale } = await admin
    .from("order_assignments")
    .select("id, order_id")
    .in("status", ["sent", "opened"])
    .lt("offer_expires_at", nowIso);
  for (const off of stale ?? []) {
    const { data: won } = await admin
      .from("order_assignments")
      .update({ status: "expired" })
      .eq("id", off.id)
      .in("status", ["sent", "opened"]) // CAS: skip if the florist just accepted/declined
      .lt("offer_expires_at", nowIso) // re-check the SAME expiry we selected on: a staff
      // resend (lib/reachoutSend.ts::sendOffer, opts.resend) can write a brand-new
      // offer_expires_at microseconds after this tick's SELECT read the row as
      // stale — without this, the UPDATE's status-only CAS would still match and
      // expire the freshly re-sent offer out from under it.
      .select("id");
    if (won?.length) {
      expired++;
      await admin.from("order_events").insert({ order_id: off.order_id, type: "offer_expired", payload: { assignmentId: off.id }, actor: "system" });
    }
  }

  // 1.5. Accept-SLA auto-reoffer, all modes: an order stuck `accepted` where the
  //      florist went dark — no ready/delivered progress and either past the
  //      assignment's binding SLA or within a short buffer of the delivery
  //      deadline. Files a `reassign` approval for a human in EVERY mode: an
  //      accepted order belongs to the florist who accepted it, and a clock
  //      running out is a reason to ask someone, not to take it back.
  const nowMs = Date.now();
  const { data: acceptedOrders } = await admin.from("orders").select("id, delivery_at").eq("status", "accepted").is("deleted_at", null);
  if (acceptedOrders?.length) {
    const orderIds = acceptedOrders.map((o) => o.id);
    const deliveryByOrder = new Map(acceptedOrders.map((o) => [o.id, o.delivery_at as string | null]));
    const { data: heldAssignments } = await admin
      .from("order_assignments")
      .select("id, order_id, sla_deadline_at")
      .eq("status", "accepted")
      .in("order_id", orderIds);
    if (heldAssignments?.length) {
      const assignmentIds = heldAssignments.map((a) => a.id);
      const { data: progress } = await admin
        .from("delivery_events")
        .select("assignment_id")
        .in("assignment_id", assignmentIds)
        .in("type", ["ready_photo", "delivered_photo"]);
      const hasProgress = new Set((progress ?? []).map((e) => e.assignment_id));

      for (const a of heldAssignments) {
        const wsDecision = await orderWorkingSetDecision(admin, a.order_id, wsConfig, "waves.accept_sla_working_set", captureError);
        if (wsDecision === "out") continue;

        const breached = isFulfilmentSlaBreached({
          slaDeadlineAt: a.sla_deadline_at,
          deliveryAt: deliveryByOrder.get(a.order_id) ?? null,
          hasProgress: hasProgress.has(a.id),
          nowMs,
        });
        if (!breached) continue;

        // ASK THEM FOR A PHOTO. DO NOT TAKE THE ORDER AWAY.
        //
        // This used to reassign the order to the next-ranked shop unattended,
        // and then briefly filed a `reassign` approval instead. Both are the
        // wrong FIRST move. An accepted order belongs to the florist who
        // accepted it; a clock running out is a reason to chase somebody, not
        // to take their work off them.
        //
        // A photo is the simplest proof of "yes, I accepted and I am doing it",
        // so that is what the desk asks for. Approving this sends the shop that
        // question (see lib/approvalExecutors.ts, kind `chase_photo`). Moving
        // the order on is still available as a `reassign` — it is just no
        // longer what happens by default to a shop that is merely busy.
        //
        // Worst before this on same-day work: progress means a PHOTO, and the
        // proximity rule fires within an hour of delivery, so a florist who
        // accepted forty minutes before delivery could not possibly have one
        // and was eligible to lose the order on the very next tick.
        //
        // NOT RE-ASKED EVERY MINUTE. The dedupe key stops a second approval
        // while one is pending, and the open-issue check stops a fresh one the
        // moment the last was actioned — otherwise the desk would be told to
        // chase the same shop sixty times an hour.
        const { data: openChase } = await admin
          .from("order_issues")
          .select("id")
          .eq("order_id", a.order_id)
          .eq("type", "awaiting_photo")
          .eq("status", "open")
          .limit(1);
        if (openChase?.length) continue;

        const { error: rErr } = await admin.from("order_approvals").insert({
          order_id: a.order_id, assignment_id: a.id, kind: "chase_photo", status: "pending",
          dedupe_key: `chase_photo:${a.order_id}`,
          preview: { type: "reason", reason: "This florist accepted and has not started. Ask them for a photo." },
          payload: {}, created_by: "system",
        });
        if (!rErr) filed++;
        // 23505 = another tick filed it first (the dedupe index) — benign.
        else if ((rErr as { code?: string }).code !== "23505") captureError("waves.file_chase_photo", rErr);
        // Any other outcome (order already changed, assignment raced with a
        // concurrent decline/delivery/cancel) is a benign no-op under
        // overlapping ticks — reassignOrder already rolled itself back.
      }
    }
  }

  // 2. Advance orders that need the next florist offered: matched (never offered) or
  //    reaching_out with no live offer. What "advance" means depends on the mode.
  const { data: pending } = await admin
    .from("orders")
    .select("id, status, delivery_at, delivery_address")
    .in("status", ["matched", "reaching_out"])
    .is("deleted_at", null);
  for (const o of pending ?? []) {
    const wsDecision = await orderWorkingSetDecision(admin, o.id, wsConfig, "waves.advance_working_set", captureError);
    if (wsDecision === "out") continue;

    // Keep at most `offer_parallel_sends` live offers open per order. The
    // default of 1 preserves the original sequential funnel. With a higher
    // value, the tick fills the empty live slots from the next-ranked candidates
    // while leaving existing sent/opened offers until their own expiry.
    const { data: live } = await admin
      .from("order_assignments")
      .select("id")
      .eq("order_id", o.id)
      .in("status", ["sent", "opened"]);
    const liveCount = live?.length ?? 0;
    const targetLive = mode === "auto" ? waveCfg.parallelSends : 1;
    const openSlots = Math.max(0, targetLive - liveCount);
    if (openSlots <= 0) continue;

    // Past the delivery deadline → no time for another wave; hand to CX.
    const pastDeadline = o.delivery_at != null && o.delivery_at < nowIso;

    const { data: next } = pastDeadline
      ? {
          data: [] as {
            id: string;
            draft_subject: string | null;
            draft_body: string | null;
            florist_id: string;
            florists: { lifecycle_stage: string | null } | { lifecycle_stage: string | null }[] | null;
          }[],
        }
      : await admin
          .from("order_assignments")
          .select("id, draft_subject, draft_body, florist_id, florists(lifecycle_stage)")
          .eq("order_id", o.id)
          .in("status", ["candidate", "queued"])
          .order("rank", { ascending: true, nullsFirst: false })
          .limit(Math.max(UNREACHABLE_SCAN_LIMIT, openSlots + UNREACHABLE_SCAN_LIMIT - 1));

    // Walk the candidates in rank order until one is actually offered (or filed
    // for approval). Normally that is the first — the loop only advances past a
    // candidate we CANNOT REACH AT ALL: no usable address, no usable number, so
    // the send delivered on no channel and retrying reaches the same nobody.
    //
    // Before this loop existed the engine did `stuck++; continue` on that
    // outcome, which moved to the next ORDER and left this one retrying the same
    // dead shop every minute forever — never reaching rank 2, never escalating.
    // Found by QA/A2's order D, where a shared email address wedged an order for
    // 90 minutes with a perfectly reachable florist sitting one rank below.
    //
    // Only `florist-unreachable` advances the walk. Transient and configuration
    // failures deliberately stop it and leave the order for the next tick — see
    // lib/offerChannels.ts::floristUnreachable for why an SMS provider outage
    // must not be read as a list full of unreachable shops.
    let offeredOrFiled = false;
    let sentOrFiledHere = 0;
    let skippedHere = 0;
    // Everything below this line writes: an offer email, a cold-offer stamp, or
    // an approval. None of it may touch an order that has been placed since the
    // select above. See stillAdvanceable().
    if ((next ?? []).length && !(await stillAdvanceable(admin, o.id))) continue;
    for (const cand of next ?? []) {
      if (mode === "manual") {
        // Humans drive every send; the wave only keeps offers fresh + escalates.
        offeredOrFiled = true;
        break;
      }
      // Auto only auto-offers ONBOARDED florists. A non-onboarded (prospect) leading
      // candidate is deferred to a human via an offer approval — a real offer never
      // reaches a shop we haven't onboarded without someone approving it. (Ranking
      // puts onboarded first, so this only fires once onboarded candidates run out.)
      const fl = cand.florists as { lifecycle_stage: string | null } | { lifecycle_stage: string | null }[] | null;
      const candStage = Array.isArray(fl) ? fl[0]?.lifecycle_stage ?? null : fl?.lifecycle_stage ?? null;
      const candOnboarded = ["production", "onboarding"].includes(candStage ?? "");
      // COLD OFFER: the ONE deliberate exception to "auto never auto-offers a
      // shop we haven't onboarded". A cold offer is the point — the order IS
      // the introduction. It stays narrow: eligibility is decided by the pure
      // coldOfferBlockReason (settings switch off by default, a payout ceiling,
      // a minimum lead time, and the shop must be contactable and locatable),
      // and in `semi` this still falls through to an approval, which is where
      // cold offers belong until the numbers are trusted.
      // Held so it can be written onto the approval below. Only computed on the
      // branch that can actually cold-offer, exactly as before.
      const coldBlock =
        !candOnboarded && mode === "auto"
          ? await coldOfferBlock(admin, cand.florist_id, o.id, o.delivery_at ?? null)
          : null;
      const coldOk = !candOnboarded && mode === "auto" && coldBlock === null;
      if (mode === "auto" && (candOnboarded || coldOk)) {
        if (coldOk) {
          // Mark it before sending so the accept path knows to mint a
          // provisional activation, and so the audit says which offers were cold.
          await admin.from("order_assignments").update({ offer_audience: "cold" }).eq("id", cand.id);
        }
        const r = await sendOffer(cand.id, "system");
        if (r.ok) {
          advanced++;
          offeredOrFiled = true;
          sentOrFiledHere++;
          if (sentOrFiledHere >= openSlots) break;
          continue;
        }
        if (r.error === "florist-unreachable") {
          // This shop is a dead end — nothing we hold reaches them. Close the
          // candidate so the list moves on, and try the next rank in THIS tick.
          // CAS-guarded on the sendable statuses so a racing staff send or a
          // concurrent tick can't have its work closed out from under it.
          const { data: closed } = await admin
            .from("order_assignments")
            .update({ status: "expired" })
            .eq("id", cand.id)
            .in("status", ["candidate", "queued"])
            .select("id");
          if (closed?.length) {
            skipped++;
            skippedHere++;
            // `expired` is reused rather than adding a status (every consumer —
            // the next-candidate query, the resend rules, CX cold-wave detection
            // — already treats it as "this candidate's chance is over"). The
            // event carries the truth that the status cannot: we never reached
            // them, so nobody ignored us. The per-channel detail is already on
            // the `communications` rows this send just wrote.
            await admin.from("order_events").insert({
              order_id: o.id,
              type: "offer_skipped",
              payload: { assignmentId: cand.id, floristId: cand.florist_id, reason: r.skipReason ?? "florist-unreachable" },
              actor: "system",
            });
          }
          continue; // next candidate, same order
        }
        // Anything else is transient or a configuration problem that the next
        // candidate would hit too (no test email, a provider outage). Stop the
        // walk and leave the order exactly where it was for the next tick.
        if (r.error !== "not-sendable") stuck++; // "not-sendable" = benign lost race
        offeredOrFiled = true;
        break;
      }
      // semi → file a pending OFFER approval for a human. Deduped on the
      // per-effect dedupe_key (offer:<order>:<candidate>) so overlapping ticks
      // can't double-file; the panel renders the editable draft (no
      // rendered-html preview needed — offers keep their subject/body edit UI).
      const { error: insErr } = await admin.from("order_approvals").insert({
        order_id: o.id, assignment_id: cand.id, kind: "offer", status: "pending",
        dedupe_key: `offer:${o.id}:${cand.id}`,
        draft_subject: cand.draft_subject, draft_body: cand.draft_body, created_by: "system",
        // WHY a human is being asked. In `semi` the step gate is the answer and
        // no cold check ran; in `auto` it is whichever gate refused the cold
        // offer. Free text by design (see the migration): a reason nobody has
        // thought of yet must never fail the insert that files CX work.
        block_reason: mode === "semi" ? "semi-mode" : coldBlock,
      });
      // 23505 = another tick filed it first (the partial-unique index) — benign.
      // Any other insert error is a real failure worth surfacing (the approval
      // silently never gets filed otherwise).
      if (!insErr) filed++;
      else if ((insErr as { code?: string }).code !== "23505") captureError("waves.file_approval", insErr);
      offeredOrFiled = true;
      sentOrFiledHere++;
      break;
    }

    if (offeredOrFiled) continue;
    // Every candidate we looked at was unreachable and the scan window was full,
    // so there may be more below it. Leave the refill/escalate decision to a
    // later tick rather than declaring the list exhausted on partial evidence —
    // the walk resumes where it left off, since the skipped rows are no longer
    // `candidate`. Bounded work per tick either way.
    if (skippedHere > 0 && (next?.length ?? 0) >= UNREACHABLE_SCAN_LIMIT) continue;

    {
      // The candidate list ran out. Before handing this to a human, try to
      // REFILL it with the next-ranked untried florists — one wave of
      // `match_top_n` more — and only escalate when a guard says stop.
      //
      // Why auto only: in `manual` the wave engine never sends, so refilling
      // would quietly grow the candidate list while nobody offers anybody, and
      // the escalation that a human is waiting for would never arrive. In
      // `semi` the escalation is itself a proposal for CX to approve; adding
      // candidates behind that approval would decide the question the approval
      // exists to ask. Both keep their pre-refill behavior exactly.
      // Default says only what every mode knows: this order's list ran out.
      // `pool_exhausted` is a stronger claim and is set below ONLY when a
      // refill actually ran and found nobody.
      let reason: EscalationReason = pastDeadline ? "past_delivery_deadline" : "candidates_exhausted";
      if (mode === "auto" && !pastDeadline) {
        const waves = await wavesSoFar(admin, o.id);
        const decision = refillDecision({
          wavesSoFar: waves,
          maxWaves: waveCfg.maxWaves,
          // The window the NEXT offer would actually get, from the same ladder
          // lib/offerVars.ts locks in at send time — so the guard reasons about
          // the real fuse, not a nominal one. It shortens as delivery nears,
          // which is what lets a late order fit more tries.
          nextWindowMin: suggestedTimeoutMinutes(o.delivery_at ?? null, waveCfg.windows),
          cxReserveHours: waveCfg.cxReserveHours,
          deliveryAt: o.delivery_at ?? null,
          nowMs: Date.now(),
        });
        if (decision.refill) {
          // Same guard as the send walk: a refill writes candidate rows, and an
          // order accepted since the select must not collect fresh ones. This is
          // the write that was measured landing 8s after the payout.
          if (!(await stillAdvanceable(admin, o.id))) continue;
          const config = await loadMatchConfig(admin);
          const added = await refillCandidates(admin, o.id, config, {
            actor: "system",
            eventExtra: { wave: waves + 1, trigger: "wave_refill" },
          });
          if (isRefillError(added)) {
            // A ranking/insert failure must not silently strand the order at
            // `reaching_out` with nothing live — fall through and escalate, so
            // a human picks it up.
            captureError("waves.refill", new Error(added.error));
          } else if (added.added > 0) {
            refilled++;
            // Next tick sends the first of them; nothing to escalate.
            continue;
          } else {
            // The refill ran and found nobody — the one path entitled to say
            // the pool itself is dry.
            reason = "pool_exhausted";
          }
        } else {
          reason = decision.reason;
        }
      }

      if (mode === "semi") {
        // Step mode: propose the escalation for CX rather than escalating unattended.
        const { error: eErr } = await admin.from("order_approvals").insert({
          order_id: o.id, kind: "escalate", status: "pending",
          dedupe_key: `escalate:${o.id}`,
          preview: { type: "reason", reason: escalationApprovalPreview(reason) },
          payload: { from: o.status, reason },
          created_by: "system",
        });
        if (!eErr) filed++;
        else if ((eErr as { code?: string }).code !== "23505") captureError("waves.file_escalate", eErr);
        continue;
      }

      // No candidate left (refill exhausted or blocked by a guard, all
      // skipped/declined, or past deadline) → escalate to CX, CAS-guarded from
      // this order's current status. Fires for `reaching_out` (auto/manual ran
      // the list out) so nothing silently stalls. The reason rides on the ORDER
      // as well as the event: the CX desk triages by it, and "12 shops ignored
      // us" needs a different human response than "no florist exists here".
      const { data: esc } = await admin
        .from("orders")
        .update({ status: "escalated", escalation_reason: reason })
        .eq("id", o.id)
        .eq("status", o.status)
        .select("id");
      if (esc?.length) {
        escalated++;
        await admin.from("order_events").insert({
          order_id: o.id,
          type: "escalated",
          payload: { reason },
          actor: "system",
        });
      }
    }
  }

  return { expired, advanced, filed, escalated, stuck, refilled, skipped };
}

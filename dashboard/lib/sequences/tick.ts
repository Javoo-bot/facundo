// The sequence engine's cron step. Deliberately thin: every decision belongs to
// the pure lib/sequences/schedule.ts::nextDecision, and this file only does the
// I/O around it — claim a row, resolve who/what/where, send, record.
//
// Modelled on lib/waves.ts, including its CAS discipline: the claim re-checks
// the exact `next_action_at` the SELECT read, so a click landing between the
// read and the update cannot have its cancellation quietly overwritten.

import { createServiceClient } from "@/lib/supabaseAdmin";
import { defaultFrom, defaultFromAddress } from "@/lib/emailFrom";
import { captureError } from "@/lib/monitor";
import { sendEmail } from "@/lib/email";
import { chooseReplyTo, floristReplyAddress } from "@/lib/replyToken";
import { sendSms } from "@/lib/sms";
import { emailEnabled } from "@/lib/emailToggles";
import { smsEnabled } from "@/lib/smsToggles";
import { logCommunication } from "@/lib/communications";
import { loadOverrides } from "@/lib/messageOverrides";
import { resolveFloristSendLocale } from "@/lib/floristLocale";
import { resolveFloristSmsPhone, countryToRegion } from "@/lib/phone";
import { buildRecruitingTouch, buildRecruitingSmsContent } from "@/lib/recruitingContent";
import { resolveVoiceFor } from "@/lib/messageVoice";
import { resolvePersona, personaFromName, type Persona } from "@/lib/personas";
import { composeRecruitingEmail } from "@/lib/recruitingEmail";
import { buildJoinUrl, needsNewJoinToken, joinTokenExpiry } from "@/lib/floristJoin";
import { ensureUnsubscribeToken } from "@/lib/offerVars";
import { randomUUID } from "node:crypto";
import { FLORIST_BASE } from "@/lib/emailLinks";
import { nextDecision, type Enrolment } from "./schedule.ts";
import { openStateOfRun, type MessageFeedback, type OpenState } from "./openState.ts";
import { remainingBudget, isCapped } from "./sendBudget.ts";
import { CAMPAIGN_TIME_ZONE } from "./sendWindow.ts";
import { trackRecruitEmailSent } from "@/lib/reachout/events";
import { sequenceDef, isSequenceId, stepKind, type SequenceStep } from "./definitions.ts";
import { stop } from "./enrol.ts";
import { loadStepConfig, disabledStepKeys } from "./timingOverrides.ts";
import { applyStepTiming } from "@/lib/flows/timing";
import { resolveSequence } from "@/lib/flows/customSteps";
import { resumePausedRecruiting, enrolLapsedColdOffers, enrolReactivations, enrolNewlyScrapedShops } from "./reconcile.ts";
import { BUMP_TO_CONTACTED_FROM } from "@/lib/pipeline";
// Reasons live in their own alias-free module so the /testing UI can share them
// and a test can prove every one has copy — see tickBlocked.test.mjs.
import type { TickBlockedReason } from "./tickBlocked.ts";

type Admin = ReturnType<typeof createServiceClient>;

export interface TickResult {
  considered: number;
  sent: number;
  skipped: number;
  stopped: number;
  waiting: number;
  capped: boolean;
  resumed: number;
  coldEnrolled: number;
  reactivated: number;
  /** Freshly scraped shops put into recruit_cold this tick — the opt-in
   *  `sequence_auto_enrol_scraped` sweep. Always 0 while the switch is off. */
  autoEnrolled: number;
  /** Why the auto-enrol sweep skipped what it skipped (reason → count), so
   *  "autoEnrolled: 0" is never a mystery. Empty when nothing was considered. */
  autoEnrolSkipped: Record<string, number>;
  /** Null when the tick actually ran. Set when it returned without looking at
   *  a single enrolment — the difference between "nothing to do" and "off". */
  blocked: TickBlockedReason | null;
}

const SELECT_COLUMNS =
  "id, florist_id, sequence_id, status, track, step_index, created_at, engaged_at, last_touch_at, touches_email, touches_sms, next_action_at";

/** Sends since midnight UTC, against `sequence_daily_send_cap`. A bug that
 * enrols thousands of florists at once would otherwise torch the sending
 * domain in one tick; this is the blast-radius guard, not a rate limit.
 *
 * Counts BOTH the tick's own steps (`recruit.<step>`, via stepKind) and the
 * manual day-0 send from /discovery (`recruiting`, app/api/outreach/send).
 * Until 2026-08-19 only the former was counted, so a staff batch of 300
 * day-0 emails left the cap untouched and the tick could add a full day's
 * worth on top — the cap is meant to bound what the DOMAIN sends, whoever
 * pressed the button. */
async function sentToday(admin: Admin): Promise<number> {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const { count } = await admin
    .from("communications")
    .select("id", { count: "exact", head: true })
    .eq("audience", "florist")
    .eq("status", "sent")
    .or("kind.like.recruit.%,kind.eq.recruiting")
    .gte("created_at", midnight.toISOString());
  return count ?? 0;
}

/**
 * What we know about this run's opens, for the t2/t3 gates.
 *
 * Reads the provider feedback on the recruiting mail actually sent on this run
 * and hands it to the pure resolver. The three-way answer is the point: see
 * openState.ts for why "we heard nothing" must not be collapsed into "they did
 * not open it".
 *
 * FAILS TO `unknown`. A query error, a missing table, a slow read — none of
 * those are evidence about a florist's behaviour, and `unknown` satisfies both
 * gates, so a failure here degrades the funnel to its pre-gate behaviour
 * (everyone gets every touch) rather than silently muting a step.
 */
async function resolveOpenState(
  admin: Admin,
  floristId: string,
  enrolment: Enrolment
): Promise<OpenState> {
  try {
    // THE HOUR OF SLACK IS LOAD-BEARING, for the same reason
    // get_visual_funnel_stats documents it: app/api/outreach/send/route.ts
    // SENDS first and enrols second — the send is what enrols them — so the
    // day-0 communications row is written BEFORE created_at. Bounding at
    // created_at exactly would discard the most important message in the run.
    const since = new Date(Date.parse(enrolment.created_at) - 60 * 60 * 1000).toISOString();
    const { data, error } = await admin
      .from("communications")
      .select("id, email_events(event_type, occurred_at)")
      .eq("florist_id", floristId)
      .eq("channel", "email")
      .eq("status", "sent")
      .or("kind.like.recruit.%,kind.eq.recruiting")
      .gte("created_at", since)
      .limit(50);
    if (error) {
      captureError("sequences.resolveOpenState", error);
      return "unknown";
    }

    // engaged_at is the SCANNER-FILTERED click (lib/sequences/clickQuality.ts),
    // so it is the one signal here already known to be a human. It proves the
    // message was seen regardless of what the open pixel did or didn't report.
    const hasHumanClick = Boolean(enrolment.engaged_at);

    const messages: MessageFeedback[] = (data ?? []).map((c) => {
      const events = ((c as { email_events?: { event_type?: string; occurred_at?: string }[] | null }).email_events ?? []);
      const firstOf = (t: string) =>
        events.filter((e) => e.event_type === t).map((e) => e.occurred_at).sort()[0] ?? null;
      return {
        deliveredAt: firstOf("delivered"),
        openedAt: firstOf("opened"),
        openCount: events.filter((e) => e.event_type === "opened").length,
        bouncedAt: firstOf("bounced") ?? firstOf("complained"),
        hasHumanClick,
      };
    });
    return openStateOfRun(messages);
  } catch (e) {
    captureError("sequences.resolveOpenState", e);
    return "unknown";
  }
}

async function coldOfferFollowupSwitch(admin: Admin): Promise<boolean> {
  try {
    const { data, error } = await admin
      .from("sequence_step_timing")
      .select("step_key,enabled")
      .eq("sequence_id", "cold_offer_followup")
      .in("step_key", ["co1", "co2"]);
    if (error) {
      captureError("sequences.coldOfferFollowupSwitch", error);
      return false;
    }
    // No rows means the order-offer follow-up has not been deliberately enabled.
    // A true row for either built-in step is enough to let the scoped engine run;
    // disabledStepKeys still suppresses any individual step explicitly set false.
    return (data ?? []).some((r) => r.enabled === true);
  } catch (e) {
    captureError("sequences.coldOfferFollowupSwitch", e);
    return false;
  }
}

export async function runSequences(limit = 50): Promise<TickResult> {
  const admin = createServiceClient();
  const result: TickResult = { considered: 0, sent: 0, skipped: 0, stopped: 0, waiting: 0, capped: false, resumed: 0, coldEnrolled: 0, reactivated: 0, autoEnrolled: 0, autoEnrolSkipped: {}, blocked: null };

  const { data: settings } = await admin
    .from("app_settings")
    // Literal, not a template — Supabase parses this at the type level.
    .select(
      "test_mode, test_email, test_phone, sequence_enabled, sequence_auto_enrol_scraped, sequence_min_gap_hours, sequence_daily_send_cap, message_voice, email_recruiting_enabled, sms_recruiting_enabled"
    )
    .eq("id", 1)
    .single();

  // Fails closed: an unreadable settings row means the engine does nothing,
  // rather than sending under assumed defaults. The two cases are reported
  // apart because they need different fixes — one is a switch in Settings, the
  // other is a database that isn't answering.
  if (!settings) {
    result.blocked = "settings-unreadable";
    return result;
  }
  const broadSequencesEnabled = Boolean(settings.sequence_enabled);
  const coldOfferFollowupEnabled = await coldOfferFollowupSwitch(admin);
  if (!broadSequencesEnabled && !coldOfferFollowupEnabled) {
    result.blocked = "sequence-disabled";
    return result;
  }

  const testMode = settings.test_mode ?? true;
  const testEmail = settings.test_email ?? null;
  const testPhone = settings.test_phone ?? null;
  const minGapHours = settings.sequence_min_gap_hours ?? 48;
  // null = no ceiling, 0 = kill switch, undefined = fall back to the bounded
  // default. The rule and its reasoning live in sendBudget.ts; the only thing
  // that belongs here is not paying for the count query when it cannot matter.
  const rawCap = settings.sequence_daily_send_cap;
  let budget = remainingBudget(rawCap, rawCap === null ? 0 : await sentToday(admin));
  if (isCapped(budget)) {
    result.capped = true;
    result.blocked = "daily-cap";
    return result;
  }

  // Repair state the send paths can't finish on their own, BEFORE selecting
  // what's due — so a run resumed on this tick can also send on this tick.
  result.resumed = broadSequencesEnabled ? await resumePausedRecruiting(admin) : 0;
  result.coldEnrolled = coldOfferFollowupEnabled ? await enrolLapsedColdOffers(admin) : 0;
  result.reactivated = broadSequencesEnabled ? await enrolReactivations(admin) : 0;
  // Opt-in: freshly scraped shops enter recruit_cold on their own. Runs here,
  // before the due-select, so a shop enrolled on this tick gets its day-0
  // touch on this same tick (step 0 is due immediately) rather than a minute
  // later — and so it is subject to the same daily budget as everything else.
  const auto = broadSequencesEnabled ? await enrolNewlyScrapedShops(admin, settings) : { enrolled: 0, skipped: {} };
  result.autoEnrolled = auto.enrolled;
  result.autoEnrolSkipped = auto.skipped;

  const nowIso = new Date().toISOString();
  let dueQuery = admin
    .from("sequence_enrolments")
    .select(SELECT_COLUMNS)
    .eq("status", "active")
    .lte("next_action_at", nowIso);
  if (!broadSequencesEnabled && coldOfferFollowupEnabled) {
    dueQuery = dueQuery.eq("sequence_id", "cold_offer_followup");
  }
  const { data: due } = await dueQuery
    .order("next_action_at", { ascending: true })
    .limit(limit);

  // One persona query for the whole tick rather than one per enrolment.
  const { data: personaRows } = await admin.from("outreach_personas").select("*").eq("active", true);
  const personas = (personaRows ?? []) as Persona[];

  // What staff changed on /flows: the waits, and which steps are switched off.
  // One read per tick for the same reason as the personas above — the table has
  // one row per STEP, not per florist. Best-effort: an unreadable table means
  // every step runs on its code default and nothing is silently off
  // (lib/sequences/timingOverrides.ts).
  const stepConfig = await loadStepConfig(admin);
  const stepTiming = stepConfig.timing;
  const disabledSteps = disabledStepKeys(stepConfig);

  for (const row of due ?? []) {
    result.considered++;
    if (budget <= 0) {
      result.capped = true;
      break;
    }
    if (!isSequenceId(row.sequence_id)) continue;

    const def = resolveSequence(sequenceDef(row.sequence_id), stepConfig, applyStepTiming);
    const enrolment = row as unknown as Enrolment;

    // Resolve the florist first: the persona-availability input to the
    // scheduler depends on their locale.
    const { data: florist } = await admin
      .from("florists")
      .select(
        "id, name, email, locale, address, city_id, joined_at, excluded_at, deleted_at, join_token, join_token_expires_at, unsubscribe_token, phone_mobile, phone_web, phone_maps, order_emails_opt_out, order_emails_snoozed_until, order_sms_opt_out, order_sms_snoozed_until"
      )
      .eq("id", row.florist_id)
      .single();

    // Reasons to abandon the run outright rather than skip one touch.
    if (!florist) {
      await stop(admin, row.id, "staff");
      result.stopped++;
      continue;
    }
    // Joining means the OPPOSITE thing depending on who the sequence is for.
    // For a prospect it is the goal, so it ends the run; for a reactivation
    // sequence it is the precondition, and without this branch the recruiting
    // rule would kill every reactivation run on its first tick.
    if (def.audience === "prospect" && florist.joined_at) {
      await stop(admin, row.id, "joined");
      result.stopped++;
      continue;
    }
    if (def.audience === "network" && !florist.joined_at) {
      // They left the network, or were never in it — either way this sequence
      // is addressed to somebody who does not exist.
      await stop(admin, row.id, "staff");
      result.stopped++;
      continue;
    }
    if (florist.excluded_at || florist.deleted_at) {
      await stop(admin, row.id, "staff");
      result.stopped++;
      continue;
    }

    const { data: city } = florist.city_id
      ? await admin.from("cities").select("city, country").eq("id", florist.city_id).single()
      : { data: null };

    const locale = resolveFloristSendLocale(
      { locale: florist.locale, address: florist.address },
      city?.country ?? null
    );
    const persona = resolvePersona(locale, personas);

    // Resolved HERE, immediately before the decision, rather than carried on
    // the row: an open that landed since this row was claimed must count. This
    // is the same reason engaged_at is re-read rather than trusted from the
    // claim — a shop that opened at 12:29 must not get the 12:30 "you did not
    // open it" email.
    const openState = await resolveOpenState(admin, row.florist_id as string, enrolment);

    const decision = nextDecision(enrolment, def, Date.now(), {
      minGapHours,
      hasPersona: persona !== null,
      disabledSteps,
      openState,
      // Only the recruiting funnel is same-day and open-gated, so only it needs
      // civil hours. Putting a window on the cold-offer follow-up would delay a
      // bridge to a real order that has already gone elsewhere.
      sendWindow: row.sequence_id === "recruit_cold" ? { timeZone: CAMPAIGN_TIME_ZONE } : null,
    });

    if (decision.action === "wait") {
      // Park it rather than re-reading this row every minute.
      await admin
        .from("sequence_enrolments")
        .update({ next_action_at: decision.until, updated_at: nowIso })
        .eq("id", row.id)
        .eq("next_action_at", row.next_action_at);
      result.waiting++;
      continue;
    }

    if (decision.action === "stop") {
      await stop(admin, row.id, decision.reason === "not_active" ? "staff" : decision.reason);
      result.stopped++;
      continue;
    }

    // CLAIM. CAS on the exact next_action_at this iteration read, so an
    // overlapping tick — or an engagement webhook that just re-anchored the
    // clock — cannot have its change silently trampled. Only the winner sends.
    const { data: claimed } = await admin
      .from("sequence_enrolments")
      .update({ next_action_at: decision.nextActionAt, updated_at: nowIso })
      .eq("id", row.id)
      .eq("status", "active")
      .eq("next_action_at", row.next_action_at)
      .select("id");
    if (!claimed?.length) continue; // lost the race, or the click beat us here

    // THE LINKS THE EMAIL NEEDS. Until 2026-08-19 the tick only READ
    // `join_token`/`unsubscribe_token` and quietly sent without the CTA or the
    // unsubscribe link when they were missing — which every auto-enrolled shop
    // is (tokens used to be minted by the manual send route), and which any
    // manually enrolled shop becomes once its 30-day join token expires before
    // step 2/3. A recruiting email with no "join" button is the funnel failing
    // at its one job, and one with no unsubscribe is the kind the manual route
    // refuses to send at all. Mint-or-reuse, same rules as the manual routes
    // (`needsNewJoinToken`; `ensureUnsubscribeToken` is CAS-guarded), after
    // the claim so a lost race mints nothing. Prospects only — a joined
    // florist needs no join link, and `needsNewJoinToken` already says so.
    if (def.audience === "prospect") {
      if (needsNewJoinToken(florist as { join_token: string | null; join_token_expires_at: string | null; joined_at: string | null }, new Date())) {
        const token = randomUUID();
        const { error: mintErr } = await admin
          .from("florists")
          .update({ join_token: token, join_token_expires_at: joinTokenExpiry(new Date()) })
          .eq("id", florist.id);
        if (mintErr) captureError("sequences.tick.mintJoinToken", mintErr);
        else florist.join_token = token;
      }
      if (!florist.unsubscribe_token) {
        florist.unsubscribe_token = await ensureUnsubscribeToken(admin, florist.id as string, null);
      }
    }

    const sentChannels = await deliver(admin, {
      enrolmentId: row.id,
      step: decision.step,
      channels: decision.channels,
      florist,
      city: city ?? null,
      locale,
      persona,
      settings,
      testMode,
      testEmail,
      testPhone,
    });

    if (sentChannels.email || sentChannels.sms) {
      result.sent++;
      budget--;
      // Mirror the send into PostHog so the funnel exists there as well as in
      // Postgres. `gate` and `openState` are carried deliberately: without them
      // the open-branching is invisible, and there would be no way to notice
      // that (say) every shop is being classified `unknown` because a webhook
      // stopped arriving. Awaited, not floating — a fire-and-forget promise is
      // killed by the Worker isolate teardown.
      await trackRecruitEmailSent(row.florist_id as string, {
        step: decision.step.key,
        sequence: row.sequence_id as string,
        city: city?.city ?? null,
        country: city?.country ?? null,
        locale,
        gate: decision.step.gate ?? openState,
        testMode,
      });
      await admin
        .from("sequence_enrolments")
        .update({
          // PAST THE STEP ACTUALLY SENT, not one past where the run was.
          // nextDecision walks over steps it cannot use — disabled, no persona,
          // channel capped, or (since the same-day funnel) an open gate that
          // does not match — so the two are different numbers the moment any
          // step is skipped. Advancing by one rewinds the run onto the skipped
          // steps and sends them AGAIN: observed on staging 2026-09-09, where
          // five shops received t2 twice because t3's gate had sent them past
          // it and the index came back to t2 on the next tick.
          step_index: decision.stepIndex + 1,
          last_touch_at: new Date().toISOString(),
          touches_email: enrolment.touches_email + (sentChannels.email ? 1 : 0),
          touches_sms: enrolment.touches_sms + (sentChannels.sms ? 1 : 0),
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      // A prospect we have now actually written to is `contacted`, whoever
      // pressed the button. The manual send route does this bump itself; the
      // tick never did, because until auto-enrolment every recruiting run
      // began with a manual send that had already moved the stage. An
      // auto-enrolled shop gets its FIRST touch from here, so without this it
      // would finish the funnel still at `found` and read as never contacted.
      // Only forward from found/targeted — never rewinds a later stage.
      if (def.audience === "prospect") {
        const { error: bumpErr } = await admin
          .from("florists")
          .update({ lifecycle_stage: "contacted" })
          .eq("id", row.florist_id)
          .in("lifecycle_stage", BUMP_TO_CONTACTED_FROM);
        if (bumpErr) captureError("sequences.tick.bumpContacted", bumpErr);
      }
    } else {
      // Nothing went out (opted out, no address, a toggle off). Still ADVANCE
      // the step — otherwise the run jams on an unsendable touch forever and
      // the florist never reaches the end of the funnel or the stop condition.
      result.skipped++;
      await admin
        .from("sequence_enrolments")
        .update({ step_index: decision.stepIndex + 1, updated_at: new Date().toISOString() })
        .eq("id", row.id);
    }
  }

  return result;
}

interface DeliverCtx {
  enrolmentId: string;
  step: SequenceStep;
  channels: ("email" | "sms")[];
  florist: Record<string, unknown>;
  city: { city: string | null; country: string | null } | null;
  locale: ReturnType<typeof resolveFloristSendLocale>;
  persona: Persona | null;
  settings: Record<string, unknown>;
  testMode: boolean;
  testEmail: string | null;
  testPhone: string | null;
}

/** Send one touch. Every refusal is logged as a `skipped` communications row
 * with its reason — the existing convention, and the only way "why did this
 * florist never hear from us" is answerable later. */
async function deliver(admin: Admin, ctx: DeliverCtx): Promise<{ email: boolean; sms: boolean }> {
  const { step, channels, florist, city, locale, persona, settings, testMode, testEmail, testPhone } = ctx;
  const kind = stepKind(step);
  const floristId = florist.id as string;
  const out = { email: false, sms: false };

  const overrides = await loadOverrides(admin, locale);
  const joinToken = florist.join_token as string | null;
  const joinUrl = joinToken ? buildJoinUrl(FLORIST_BASE, joinToken) : null;

  const skip = (channel: "email" | "sms", error: string) =>
    logCommunication({
      channel, audience: "florist", kind, floristId,
      subject: null, body: null, testMode, status: "skipped",
      provider: channel === "email" ? "resend" : "telnyx", error, actor: "system",
    }).catch(() => {});

  // ---- email ----
  if (channels.includes("email")) {
    if (!emailEnabled(settings, "recruiting")) {
      await skip("email", "disabled-by-settings");
    } else if (!florist.email) {
      await skip("email", "no-email");
    } else if (florist.order_emails_opt_out) {
      await skip("email", "opted-out");
    } else if (
      florist.order_emails_snoozed_until &&
      new Date(florist.order_emails_snoozed_until as string).getTime() > Date.now()
    ) {
      await skip("email", "snoozed");
    } else if (testMode && !testEmail) {
      await skip("email", "no-test-email");
    } else {
      // A DUPLICATE renders the shape of the step it copied (`copyOf`) under
      // its OWN key, so it has the right paragraphs and its own words. A
      // built-in step is its own shape, and `copyOf` is undefined.
      const built = buildRecruitingTouch(
        (step.copyOf ?? step.key) as never,
        locale,
        overrides,
        {
          city: city?.city ?? null,
          // We only claim reviews when we have them; the tick has no rating in
          // hand here, so it takes the honest branch rather than the flattering
          // one. (The day-0 email, which does have the signal, is sent by the
          // outreach panel, not by this tick.)
          hasReviews: false,
          joinUrl,
        },
        step.ns ?? "recruit",
        step.key
      );

      const voice = resolveVoiceFor(settings, kind, step.voice);

      const unsubToken = florist.unsubscribe_token as string | null;
      const unsubscribeUrl = unsubToken
        ? `${FLORIST_BASE}/florist/unsubscribe/${unsubToken}?locale=${locale}&channel=email`
        : null;

      // The shell, the signature and the plain-text half all live in
      // lib/recruitingEmail.ts so /flows can send a test through this exact
      // composition rather than through a second copy of it.
      const { html, bodyText } = composeRecruitingEmail(built, {
        locale,
        overrides,
        voice,
        persona: step.from === "persona" && persona ? persona : null,
        unsubscribeUrl,
        testMode,
      });

      const from =
        step.from === "persona" && persona
          ? `${personaFromName(persona)} <${defaultFromAddress()}>`
          : defaultFrom();

      const sent = await sendEmail({
        to: testMode ? testEmail! : (florist.email as string),
        from,
        // In test mode EVERY shop's mail goes to the one test inbox, and the
        // recruiting subject is per-CITY — so fifteen Madrid shops produce
        // fifteen identical subject lines and the tester cannot tell which
        // florist any of them is for. That makes the funnel unverifiable by
        // hand: you cannot deliberately open shop A, click shop B, and then
        // check the ranking matched. Prefixing with the shop and the step is
        // what makes a test-mode inbox readable.
        //
        // Never applied to a live send — a real florist must see the subject
        // the marketing lead wrote, not our internal step key.
        subject: testMode ? `[${florist.name ?? "?"} · ${step.key}] ${built.subject}` : built.subject,
        body: bodyText,
        html,
        // The signed per-florist address first, so a reply identifies the shop
        // even from an unknown address with its threading headers dropped. The
        // persona inbox only when inbound mail is not configured.
        replyTo: chooseReplyTo(floristReplyAddress(floristId), persona?.reply_to),
        context: { audience: "florist", kind, floristId, testMode, actor: "system" },
      });
      out.email = sent.ok;
    }
  }

  // ---- sms ----
  if (channels.includes("sms")) {
    if (!smsEnabled(settings, "recruiting")) {
      await skip("sms", "disabled-by-settings");
    } else if (florist.order_sms_opt_out) {
      await skip("sms", "opted-out");
    } else if (
      florist.order_sms_snoozed_until &&
      new Date(florist.order_sms_snoozed_until as string).getTime() > Date.now()
    ) {
      await skip("sms", "snoozed");
    } else if (!joinUrl) {
      // The link is the only content an outreach text has.
      await skip("sms", "no-join-token");
    } else if (!florist.unsubscribe_token) {
      await skip("sms", "no-unsubscribe-token");
    } else if (step.key !== "t1" && step.key !== "r1") {
      await skip("sms", "step-has-no-sms-copy");
    } else {
      const intended = resolveFloristSmsPhone(
        florist as never,
        countryToRegion(city?.country ?? null)
      );
      if (!intended) {
        await skip("sms", "no-phone");
      } else if (testMode && !testPhone) {
        await skip("sms", "no-test-phone");
      } else {
        const body = buildRecruitingSmsContent(
          locale, overrides,
          {
            city: city?.city ?? null,
            joinUrl,
            unsubscribeUrl: `${FLORIST_BASE}/florist/unsubscribe/${florist.unsubscribe_token}?locale=${locale}&channel=sms`,
            personaName: persona?.name ?? null,
          },
          step.key === "r1" ? "r1" : "t1"
        );
        const sent = await sendSms({
          to: testMode ? testPhone! : intended,
          body,
          context: { operation: "sequence_sms", audience: "florist", kind, floristId, testMode, actor: "system" },
        });
        out.sms = sent.ok;
      }
    }
  }

  if (!out.email && !out.sms) {
    captureError(
      "sequences.deliver.nothing_sent",
      new Error(`no channel delivered for enrolment ${ctx.enrolmentId} step ${step.key}`)
    );
  }

  return out;
}

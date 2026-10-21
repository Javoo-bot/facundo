import { isAllowed, getStaffRole } from "@/lib/allowlist";
import { defaultFrom } from "@/lib/emailFrom";
import { sendEmail } from "@/lib/email";
import { chooseReplyTo, floristReplyAddress } from "@/lib/replyToken";
import { sendSms } from "@/lib/sms";
import { smsEnabled } from "@/lib/smsToggles";
import { resolveFloristSmsPhone, countryToRegion } from "@/lib/phone";
import { buildRecruitingSmsContent } from "@/lib/recruitingContent";
import { resolveFloristLocale } from "@/lib/i18n";
import { loadOverrides } from "@/lib/messageOverrides";
import { buildJoinUrl } from "@/lib/floristJoin";
import { FLORIST_BASE } from "@/lib/emailLinks";
import { createServerClient } from "@/lib/supabase";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { BUMP_TO_CONTACTED_FROM } from "@/lib/pipeline";
import { logCommunication } from "@/lib/communications";
import { emailEnabled } from "@/lib/emailToggles";
import { enrol } from "@/lib/sequences/enrol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ITEMS = 50;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface SendItem {
  floristId: string;
  subject: string;
  body: string;
}

type Admin = ReturnType<typeof createServiceClient>;

/** Send the recruiting SMS for one florist, logging every outcome (including
 * the reasons we DIDN'T send). Never throws — the caller is mid-batch.
 *
 * Deliberately mirrors the offer-SMS rules rather than inventing new ones:
 * test mode redirects to the configured test phone (a real prospect must never
 * receive test traffic), the opt-out link is always appended, and a florist
 * who has already opted out of texts is skipped. */
async function sendRecruitingSms(
  admin: Admin,
  floristId: string,
  opts: { testMode: boolean; testPhone: string | null; actor: string | null }
): Promise<void> {
  const { testMode, testPhone, actor } = opts;
  const skip = (error: string) =>
    logCommunication({
      channel: "sms", audience: "florist", kind: "recruiting", floristId,
      subject: null, body: null, testMode, status: "skipped", provider: "telnyx", error, actor,
    }).catch(() => {});

  const { data: f } = await admin
    .from("florists")
    .select("id, locale, city_id, phone_mobile, phone_web, phone_maps, order_sms_opt_out, order_sms_snoozed_until, unsubscribe_token, join_token, joined_at")
    .eq("id", floristId)
    .single();
  if (!f) return void (await skip("florist-not-found"));
  // Already a partner — the recruiting pitch is not for them.
  if (f.joined_at) return void (await skip("already-joined"));
  if (f.order_sms_opt_out) return void (await skip("opted-out"));
  if (f.order_sms_snoozed_until && new Date(f.order_sms_snoozed_until).getTime() > Date.now()) {
    return void (await skip("snoozed"));
  }
  // No signup link means the SMS has nothing to point at — its only content is
  // the link. The email (which can carry a plain reply-to) still goes.
  if (!f.join_token) return void (await skip("no-join-token"));
  if (!f.unsubscribe_token) return void (await skip("no-unsubscribe-token"));

  const { data: city } = await admin.from("cities").select("city, country").eq("id", f.city_id).single();
  const intended = resolveFloristSmsPhone(f, countryToRegion(city?.country ?? null));
  if (!intended) return void (await skip("no-phone"));
  if (testMode && !testPhone) return void (await skip("no-test-phone"));
  const to = testMode ? testPhone! : intended;

  const locale = resolveFloristLocale({ locale: f.locale }, city?.country ?? null);
  const overrides = await loadOverrides(admin, locale);
  const body = buildRecruitingSmsContent(locale, overrides, {
    city: city?.city ?? null,
    joinUrl: buildJoinUrl(FLORIST_BASE, f.join_token),
    // channel=sms so opting out of texts never silences their email too.
    unsubscribeUrl: `${FLORIST_BASE}/florist/unsubscribe/${f.unsubscribe_token}?locale=${locale}&channel=sms`,
  });

  await sendSms({
    to, body,
    context: { operation: "recruiting_sms", audience: "florist", kind: "recruiting", floristId, testMode, actor },
  });
}

export async function POST(request: Request): Promise<Response> {
  // AUTH GATE — session + allow-list, before any service-role work.
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError("Not signed in.", 401);
  if (!(await isAllowed(user.email))) return jsonError("This account is not authorized.", 403);
  const role = await getStaffRole(user.email);
  if (!role || !["ops", "admin"].includes(role)) return jsonError("Your role doesn't allow this.", 403);
  const sentBy = user.email ?? null;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
    return jsonError(`items must be an array of 1..${MAX_ITEMS} entries.`, 400);
  }
  for (const it of items) {
    const v = it as Partial<SendItem>;
    if (typeof v.floristId !== "string" || typeof v.subject !== "string" || typeof v.body !== "string") {
      return jsonError("each item needs floristId, subject, body (strings).", 400);
    }
  }

  const admin = createServiceClient();

  // AUTHORITATIVE test-mode read — server-side, every send. Client cannot spoof it.
  const { data: settings } = await admin
    .from("app_settings")
    // Literal, not a template — Supabase parses this string at the type level,
    // and an interpolated one degrades to a ParserError. Keep in step with
    // lib/smsToggles.ts::SMS_TOGGLE_COLUMNS.
    .select("test_mode, test_email, email_recruiting_enabled, test_phone, sms_offer_enabled, sms_recruiting_enabled")
    .eq("id", 1)
    .single();
  const testMode = settings?.test_mode ?? true; // fail safe: default to test mode
  const testEmail = settings?.test_email ?? null;
  if (!emailEnabled(settings, "recruiting")) {
    // Settings → Notifications toggle is off — log one skipped row per
    // intended recipient, nothing in the batch is attempted.
    await Promise.all(
      (items as SendItem[]).map((item) =>
        logCommunication({
          channel: "email", audience: "florist", kind: "recruiting", floristId: item.floristId,
          subject: item.subject, body: item.body, testMode, status: "skipped",
          provider: "resend", error: "disabled-by-settings", actor: sentBy,
        })
      )
    );
    return jsonError("Recruiting/outreach emails are turned off in Settings.", 400);
  }
  if (testMode && (!testEmail || !EMAIL_RE.test(testEmail))) {
    // Nothing in the batch was attempted — log one skipped row per intended recipient.
    await Promise.all(
      (items as SendItem[]).map((item) =>
        logCommunication({
          channel: "email", audience: "florist", kind: "recruiting", floristId: item.floristId,
          subject: item.subject, body: item.body, testMode, status: "skipped",
          provider: "resend", error: "no-test-email", actor: sentBy,
        })
      )
    );
    return jsonError("Test mode is on but no valid test email is configured (Settings).", 400);
  }
  const from = defaultFrom();

  // The recruiting SMS rides alongside the email rather than being its own
  // action: same reviewer, same click, same audit trail. It FAILS CLOSED —
  // lib/smsToggles.ts only sends on an explicit `true`, so this stays dark
  // until Settings turns it on. Cold SMS to a shop that never asked to hear
  // from us is the send worth being conservative about.
  const smsRecruitingEnabled = smsEnabled(settings, "recruiting");
  const testPhone = (settings as { test_phone?: string | null } | null)?.test_phone ?? null;

  const results: { floristId: string; status: "sent" | "failed"; error?: string }[] = [];
  // Sequential — small N, keeps us well under Resend rate limits and simple.
  // Each iteration is independent: a lookup/send failure for one florist is
  // recorded and the loop continues — it never aborts the whole batch.
  for (const item of items as SendItem[]) {
    let status: "sent" | "failed" = "failed";
    let error: string | null = null;
    let providerId: string | null = null;
    let intended: string | null = null;
    let toAddress: string | null = null;

    try {
      const { data: florist } = await admin
        .from("florists")
        .select("id, name, email")
        .eq("id", item.floristId)
        .single();

      intended = florist?.email ?? null;

      if (!florist) {
        error = "Florist not found.";
        // No floristId here: the id didn't resolve to a row, and communications.
        // florist_id has an FK — passing the phantom id would fail the audit insert.
        await logCommunication({
          channel: "email", audience: "florist", kind: "recruiting",
          subject: item.subject, body: item.body, testMode, status: "skipped",
          provider: "resend", error, actor: sentBy,
        });
      } else if (!intended) {
        error = "Florist has no email address.";
        await logCommunication({
          channel: "email", audience: "florist", kind: "recruiting", floristId: item.floristId,
          subject: item.subject, body: item.body, testMode, status: "skipped",
          provider: "resend", error, actor: sentBy,
        });
      } else {
        toAddress = testMode ? testEmail : intended;
        const sent = await sendEmail({
          to: toAddress!,
          from,
          // Same reason as lib/sequences/tick.ts: in test mode every shop's
          // mail lands in one inbox with the same per-city subject, so without
          // the shop's name the tester cannot tell fifteen of them apart. `t1`
          // matches the step key the follow-ups use, so a whole run reads as
          // one labelled thread. Never applied to a live send.
          subject: testMode ? `[${florist.name ?? "?"} · t1] ${item.subject}` : item.subject,
          body: item.body,
          replyTo: chooseReplyTo(floristReplyAddress(item.floristId)),
          context: { audience: "florist", kind: "recruiting", floristId: item.floristId, testMode, actor: sentBy },
        });
        if (sent.ok) {
          status = "sent";
          providerId = sent.id;
        } else {
          error = sent.error;
        }
      }
    } catch (e) {
      // Defensive: sendEmail/lookup should not throw, but a bad florist must
      // never abort the batch for the rest.
      error = e instanceof Error ? e.message : "unexpected error";
    }

    // ---- recruiting SMS leg ----
    // Independent of the email result on purpose: a bounced address is not a
    // reason to withhold the text, and vice versa. Never throws into the loop.
    if (smsRecruitingEnabled) {
      try {
        await sendRecruitingSms(admin, item.floristId, { testMode, testPhone, actor: sentBy });
      } catch {
        // Logged inside; a failed text must not change the email's result.
      }
    }

    const { error: insertError } = await admin.from("outreach").insert({
      florist_id: item.floristId,
      channel: "email",
      status,
      intended_address: intended,
      to_address: toAddress,
      test_mode: testMode,
      subject: item.subject,
      body: item.body,
      provider_message_id: providerId,
      error,
      sent_by: sentBy,
    });
    if (insertError) {
      // The send itself already happened (or failed) — surface the audit-log
      // write failure as part of this item's error rather than losing it.
      error = error ? `${error}; also failed to record outreach: ${insertError.message}` : `Failed to record outreach: ${insertError.message}`;
    }

    results.push({ floristId: item.floristId, status, ...(error ? { error } : {}) });
  }

  // Auto-advance lifecycle: any florist we just successfully emailed moves to
  // 'contacted' — but only from 'found'/'targeted' (never downgrade someone
  // already further along). Best-effort: a bump failure must not fail the send.
  const sentIds = results.filter((r) => r.status === "sent").map((r) => r.floristId);
  if (sentIds.length > 0) {
    const { error: bumpError } = await admin
      .from("florists")
      .update({ lifecycle_stage: "contacted" })
      .in("id", sentIds)
      .in("lifecycle_stage", BUMP_TO_CONTACTED_FROM);
    if (bumpError) {
      console.error("outreach send: lifecycle bump failed", bumpError.message);
    }

    // Start the follow-up funnel. THIS send is touch 1, so the enrolment begins
    // at step 1 with the counters already spent — the tick must never re-send
    // the email the florist just received.
    //
    // Best-effort and idempotent: enrolment failure must not fail a send that
    // already happened, and the partial unique index makes a double-clicked
    // batch a no-op rather than a doubled funnel.
    await Promise.all(
      sentIds.map((floristId) =>
        enrol(admin, {
          floristId,
          sequenceId: "recruit_cold",
          firstTouchSent: { email: true, sms: smsRecruitingEnabled },
        }).catch(() => ({ ok: false }))
      )
    );
  }

  return Response.json({ results, test_mode: testMode });
}

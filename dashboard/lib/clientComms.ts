import { createServiceClient } from "@/lib/supabaseAdmin";
import { defaultFrom } from "@/lib/emailFrom";
import { sendEmail } from "@/lib/email";
import { captureError } from "@/lib/monitor";
import { buildProofUrl } from "@/lib/photoToken";
import { FLORIST_BASE } from "@/lib/emailLinks";
import { logCommunication } from "@/lib/communications";
import { escapeHtml, renderEmailShell, renderHeadline, renderParagraphs } from "@/lib/emailTemplate";
import { tWithOverrides, type Locale } from "@/lib/i18n";
import { loadOverrides } from "@/lib/messageOverrides";
import { emailEnabled } from "@/lib/emailToggles";
import { gateEffect, type GateResult } from "@/lib/effectGate";
import type { ApprovalPreview } from "@/lib/types";
import type { SupabaseClient } from "@supabase/supabase-js";

export type ClientNoticeKind = "assigned" | "on_the_way" | "delivered";

// For the "delivered" email: find this order's delivery-proof photo (via its
// fulfilling assignment) and turn it into a signed, expiring customer URL, plus
// an HTML fragment (headline + body + photo) sized for the shared shell.
// Returns null (→ plain-paragraph email) when there's no photo or no signing
// secret configured — never throws.
async function deliveredPhotoHtml(
  admin: SupabaseClient,
  orderId: string,
  locale: Locale,
  overrides: Record<string, string>,
  subject: string,
  textBody: string
): Promise<string | null> {
  try {
    const { data: asg } = await admin.from("order_assignments").select("id").eq("order_id", orderId).in("status", ["accepted", "delivered"]).limit(1).maybeSingle();
    if (!asg) return null;
    const { data: de } = await admin.from("delivery_events").select("photo_key").eq("assignment_id", asg.id).eq("type", "delivered_photo").order("created_at", { ascending: false }).limit(1).maybeSingle();
    const key = de?.photo_key as string | undefined;
    if (!key) return null;
    // Proof photo is served from /api/orders/proof (host-agnostic) → the shared
    // florist/customer base. Always defined, so the delivered email reliably
    // carries the photo instead of silently dropping it when APP_BASE_URL is
    // unset. See lib/emailLinks.ts.
    const url = buildProofUrl(FLORIST_BASE, key);
    if (!url) return null;
    return (
      renderHeadline(subject) +
      renderParagraphs(textBody) +
      `<img src="${url}" alt="Your delivered flowers" width="536" style="display:block;max-width:100%;width:100%;height:auto;border-radius:10px;margin-top:4px" />` +
      `<p style="margin:10px 0 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:#7C8A81">${escapeHtml(tWithOverrides(overrides, locale, "email.client.delivered.photoNote"))}</p>`
    );
  } catch {
    return null; // best-effort — fall back to plain paragraphs
  }
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

type BuiltClientEmail =
  | { ok: true; to: string; from: string; subject: string; body: string; html: string; testMode: boolean }
  | { ok: false; reason: string; testMode: boolean };

// Render the exact client email that would go out for (order, kind) — settings,
// toggles, test-mode routing, overrides, and the delivered-photo variant all resolved
// — WITHOUT claiming or sending. Shared by the preview (semi-mode approval) and the
// real send, so what CX approves is byte-identical to what ships. `edits` (optional,
// from an approved-with-changes) override the catalog subject/body.
export async function buildClientEmail(
  admin: SupabaseClient,
  orderId: string,
  kind: ClientNoticeKind,
  edits?: { subject?: string | null; body?: string | null },
): Promise<BuiltClientEmail> {
  // Customers are English-only for now, by decision — the future gap-closer is
  // resolving `orders.locale` here instead of hardcoding "en".
  const locale: Locale = "en";
  const { data: s } = await admin
    .from("app_settings")
    .select("test_mode, test_email, email_client_assigned_enabled, email_client_on_the_way_enabled, email_client_delivered_enabled")
    .eq("id", 1)
    .single();
  const testMode = s?.test_mode ?? true;
  const testEmail = s?.test_email ?? null;
  if (!emailEnabled(s, `client_${kind}`)) return { ok: false, reason: "disabled-by-settings", testMode };
  if (testMode && (!testEmail || !EMAIL_RE.test(testEmail))) return { ok: false, reason: "no-test-email", testMode };

  const { data: order } = await admin.from("orders").select("buyer_email, buyer_name").eq("id", orderId).single();
  const intended = order?.buyer_email ?? null;
  if (!testMode && (!intended || !EMAIL_RE.test(intended))) return { ok: false, reason: "no-buyer-email", testMode };
  const to = testMode ? testEmail! : intended!;

  const from = defaultFrom();
  const overrides = await loadOverrides(admin, locale);
  const subject = edits?.subject != null && edits.subject !== "" ? edits.subject : tWithOverrides(overrides, locale, `email.client.${kind}.subject`);
  const body = edits?.body != null && edits.body !== "" ? edits.body : tWithOverrides(overrides, locale, `email.client.${kind}.body`);
  // The delivered email carries the proof photo (signed customer URL) when there
  // is one; everything else is a plain headline + paragraph inside the shell.
  const contentHtml = (kind === "delivered" && (await deliveredPhotoHtml(admin, orderId, locale, overrides, subject, body))) || (renderHeadline(subject) + renderParagraphs(body));
  const html = renderEmailShell(contentHtml, { testMode, locale, overrides });
  return { ok: true, to, from, subject, body, html, testMode };
}

// Send the client notice for (order, kind). Idempotent: one client_comms row per
// (order, kind), claimed BEFORE sending, so a redelivery never double-sends. Best-
// effort — never throws. This is the DIRECT path (manual/auto sends + the executor's
// approved send + outbox retries); the semi-mode gate is gateClientEmail below.
export async function deliverClientEmail(
  orderId: string,
  kind: ClientNoticeKind,
  edits?: { subject?: string | null; body?: string | null },
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const admin = createServiceClient();
    const built = await buildClientEmail(admin, orderId, kind, edits);
    if (!built.ok) {
      // Disabled / no address → log skipped and bail BEFORE the idempotency claim,
      // so turning it back on later still allows exactly one send for this (order, kind).
      await logCommunication({
        channel: "email", audience: "client", kind: `client_${kind}`, orderId,
        testMode: built.testMode, status: "skipped", provider: "resend", error: built.reason, actor: "system",
      });
      return { ok: false, reason: built.reason };
    }

    // Claim FIRST: insert-on-conflict-do-nothing. If 0 rows come back, someone already sent — skip.
    const { data: claimed } = await admin.from("client_comms")
      .upsert({ order_id: orderId, kind, test_mode: built.testMode }, { onConflict: "order_id,kind", ignoreDuplicates: true })
      .select("id");
    if (!claimed || claimed.length === 0) return { ok: false, reason: "already-sent" };

    const sent = await sendEmail({
      to: built.to, from: built.from, subject: built.subject, body: built.body, html: built.html,
      context: { orderId, operation: `client_${kind}`, audience: "client", kind: `client_${kind}`, testMode: built.testMode, actor: "system" },
    });
    await admin.from("order_events").insert({
      order_id: orderId, type: "client_comm", actor: "system",
      payload: { kind, test_mode: built.testMode, ok: sent.ok, error: sent.ok ? null : sent.error },
    });
    return { ok: sent.ok, reason: sent.ok ? undefined : sent.error };
  } catch (e) {
    captureError("comms.deliverClientEmail", e); // best-effort — never block the flow
    return { ok: false, reason: "exception" };
  }
}

// Backwards-compatible direct entry (manual/auto + outbox retry). Void-returning to
// match every existing `.catch()`-guarded call-site.
export async function notifyClient(orderId: string, kind: ClientNoticeKind): Promise<void> {
  await deliverClientEmail(orderId, kind);
}

// Semi-aware entry used by the live routes: in semi it files a previewed approval
// (the exact rendered email) for CX; in manual/auto it sends immediately. If the mail
// isn't sendable (disabled / no address) it just logs the skip — nothing to approve.
export async function gateClientEmail(orderId: string, kind: ClientNoticeKind): Promise<GateResult<{ ok: boolean; reason?: string }>> {
  try {
    const admin = createServiceClient();
    const built = await buildClientEmail(admin, orderId, kind);
    if (!built.ok) {
      const r = await deliverClientEmail(orderId, kind); // logs the skip via the same path
      return { pending: false, result: r };
    }
    const preview: ApprovalPreview = { type: "email", to: built.to, subject: built.subject, html: built.html, testMode: built.testMode };
    return gateEffect({
      kind: `client_${kind}`,
      orderId,
      dedupeKey: `client_${kind}:${orderId}`,
      preview,
      payload: { notice: kind },
      draftSubject: built.subject,
      draftBody: built.body,
      execute: () => deliverClientEmail(orderId, kind),
    });
  } catch (e) {
    captureError("comms.gateClientEmail", e);
    return { pending: false, result: { ok: false, reason: "exception" } };
  }
}

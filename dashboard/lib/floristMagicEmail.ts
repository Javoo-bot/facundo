import { createServiceClient } from "@/lib/supabaseAdmin";
import { defaultFrom } from "@/lib/emailFrom";
import { sendEmail } from "@/lib/email";
import { logCommunication } from "@/lib/communications";
import { mintMagicLink } from "@/lib/floristMagicLinkMint";
import { isSafeDest } from "@/lib/floristMagicLink";
import { renderEmailShell } from "@/lib/emailTemplate";
import { t, type Locale } from "@/lib/i18n";
import { resolveFloristSendLocale } from "@/lib/floristLocale";
import { RENOTIFY_COOLDOWN_MS } from "@/lib/reachout";

// Staff-sent sign-in link: CX emails a florist a one-tap way back into their
// account, or straight to a single order.
//
// Magic links already exist (lib/floristMagicLinkMint.ts) but only ever ride
// along inside an offer email, an issue email, or the accept flow. There was no
// way to send one on its own — so a florist who lost the thread, or who can't
// find an order they were offered, had no staff-side fix.
//
// Deliberately NOT gated on the order-offer unsubscribe: that opt-out is about
// receiving OFFERS. This is account access a human just asked for, in the same
// family as a password reset. It is still skipped for a florist with no email.

export type MagicEmailResult =
  | { ok: true; to: string; testMode: boolean; testShop: boolean; placeholder: boolean }
  | { ok: false; error: "florist-not-found" | "florist-no-email" | "no-test-email" | "bad-dest" | "cooling-down" | string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SendFloristMagicLinkOpts {
  /** Where the link lands. Must be a local path; defaults to the florist home. */
  dest?: string;
  /** Order label shown in the subject when the link points at one order. */
  orderLabel?: string | null;
  orderId?: string | null;
  assignmentId?: string | null;
}

export async function sendFloristMagicLink(
  floristId: string,
  actor: string,
  opts?: SendFloristMagicLinkOpts
): Promise<MagicEmailResult> {
  const admin = createServiceClient();
  const dest = opts?.dest ?? "/florist";
  // Defence in depth — mintMagicLink throws on an unsafe dest, and this path is
  // reachable from an API body. Fail as a clean error, not a 500.
  if (!isSafeDest(dest)) return { ok: false, error: "bad-dest" };

  const [{ data: f }, { data: s }] = await Promise.all([
    admin.from("florists").select("id, name, email, locale, address, city_id, is_test_shop").eq("id", floristId).single(),
    admin.from("app_settings").select("test_mode, test_email").eq("id", 1).single(),
  ]);
  if (!f) return { ok: false, error: "florist-not-found" };

  const intended = f.email ?? null;
  if (!intended || !EMAIL_RE.test(intended)) return { ok: false, error: "florist-no-email" };

  // Same rule as lib/offerVars.ts: test mode diverts to the shared staff inbox
  // and mints an inert token — EXCEPT for a shop we own, where a working link
  // at the shop's own address is the entire point of the flag.
  const testMode = s?.test_mode ?? true;
  const testShop = f.is_test_shop === true;
  const redirectToTestInbox = testMode && !testShop;
  const testEmail = s?.test_email ?? null;
  if (redirectToTestInbox && (!testEmail || !EMAIL_RE.test(testEmail))) return { ok: false, error: "no-test-email" };
  const to = redirectToTestInbox ? testEmail! : intended;

  // Cooldown, reusing the re-notify window: nothing else stops a staffer
  // clicking twice, and each click mints a fresh credential.
  const { data: recent } = await admin
    .from("communications")
    .select("created_at")
    .eq("florist_id", floristId)
    .eq("kind", "magic_link")
    .eq("status", "sent")
    .order("created_at", { ascending: false })
    .limit(1);
  const last = recent?.[0]?.created_at ? Date.parse(recent[0].created_at as string) : NaN;
  if (Number.isFinite(last) && Date.now() - last < RENOTIFY_COOLDOWN_MS) return { ok: false, error: "cooling-down" };

  // `locale` may be null for a florist ingested before that derivation landed —
  // fall back to the country of the city they were ingested under, exactly as
  // lib/offerVars.ts does.
  let cityCountry: string | null = null;
  if (!f.locale && f.city_id) {
    const { data: city } = await admin.from("cities").select("country").eq("id", f.city_id).single();
    cityCountry = city?.country ?? null;
  }
  const locale: Locale = resolveFloristSendLocale(f, cityCountry);
  const tt = (k: string, vars?: Record<string, string | number>) => t(locale, k, vars);

  const isOrderLink = dest !== "/florist";
  const orderLabel = opts?.orderLabel ?? "";
  const subject = isOrderLink && orderLabel
    ? tt("email.magicLink.subjectOrder", { orderLabel })
    : tt("email.magicLink.subject");
  const bodyLine = isOrderLink ? tt("email.magicLink.bodyOrder") : tt("email.magicLink.body");
  const ctaLabel = isOrderLink ? tt("email.magicLink.ctaOrder") : tt("email.magicLink.cta");

  const url = await mintMagicLink(admin, {
    floristId,
    dest,
    purpose: "staff_link",
    assignmentId: opts?.assignmentId ?? null,
    placeholder: redirectToTestInbox,
  });

  const html = renderEmailShell(
    `<h1 style="margin:0 0 12px;font-size:20px">${escapeHtml(tt("email.magicLink.headline"))}</h1>
     <p style="margin:0 0 12px">${escapeHtml(bodyLine)}</p>
     <p style="margin:0;color:#6b7280;font-size:13px">${escapeHtml(tt("email.magicLink.ignore"))}</p>`,
    { testMode, locale, preheader: tt("email.magicLink.preheader"), cta: { label: ctaLabel, url } }
  );
  const bodyText = [tt("email.magicLink.headline"), "", bodyLine, "", url, "", tt("email.magicLink.ignore")].join("\n");

  const sent = await sendEmail({
    to, from: defaultFrom(),
    subject, body: bodyText, html,
    context: {
      operation: "magic_link_email", audience: "florist", kind: "magic_link",
      floristId, orderId: opts?.orderId ?? null, assignmentId: opts?.assignmentId ?? null,
      testMode, actor,
    },
  });
  if (!sent.ok) {
    await logCommunication({
      channel: "email", audience: "florist", kind: "magic_link", floristId,
      orderId: opts?.orderId ?? null, assignmentId: opts?.assignmentId ?? null,
      testMode, status: "failed", provider: "resend", error: sent.error, actor,
    });
    return { ok: false, error: sent.error };
  }
  return { ok: true, to, testMode, testShop, placeholder: redirectToTestInbox };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

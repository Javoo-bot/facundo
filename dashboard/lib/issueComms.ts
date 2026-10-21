import { createServiceClient } from "@/lib/supabaseAdmin";
import { defaultFrom } from "@/lib/emailFrom";
import { sendEmail } from "@/lib/email";
import { captureError } from "@/lib/monitor";
import { logCommunication } from "@/lib/communications";
import { buildIssueFloristEmail, buildIssueCxEmail } from "@/lib/messages/builders";
import { resolveFloristLocale, type Locale } from "@/lib/i18n";
import { loadOverrides } from "@/lib/messageOverrides";
import { emailEnabled } from "@/lib/emailToggles";
import { BACKOFFICE_BASE } from "@/lib/emailLinks";
import { mintMagicLink } from "@/lib/floristMagicLinkMint";
import { orderDest } from "@/lib/floristMagicLink";

// Email side of florist ↔ CX issue messaging ("notify + link back": each email
// carries the message text + a link back to the app to reply). Best-effort and
// test-mode gated, mirroring lib/clientComms.ts. Never throws.
//
// The two link-backs go to DIFFERENT hosts: the CX-facing email links to the
// staff order page (backoffice host), the florist-facing email links to the
// florist PWA order page (florist host). See lib/emailLinks.ts.

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const from = () => defaultFrom();

// Email CX/ops when a florist opens or replies to an issue. Recipient is the
// configured cx_email (or the test sink in test mode). Staff-facing — stays
// English (routed through the shell with an explicit locale for visual
// consistency with the localized florist-facing emails, not for translation).
export async function notifyCxOfIssue(input: {
  orderId: string;
  orderName: string | null;
  assignmentId?: string | null;
  issueId?: string | null;
  issueType: string;
  body: string;
  author: string;
}): Promise<void> {
  try {
    const admin = createServiceClient();
    const { data: s } = await admin.from("app_settings").select("test_mode, test_email, cx_email, email_issue_to_cx_enabled").eq("id", 1).single();
    const testMode = s?.test_mode ?? true;
    if (!emailEnabled(s, "issue_to_cx")) {
      await logCommunication({
        channel: "email", audience: "cx", kind: "issue_to_cx", orderId: input.orderId,
        assignmentId: input.assignmentId ?? null, issueId: input.issueId ?? null,
        testMode, status: "skipped", provider: "resend", error: "disabled-by-settings", actor: input.author,
      });
      return;
    }
    const to = testMode ? s?.test_email ?? null : s?.cx_email ?? null;
    if (!to || !EMAIL_RE.test(to)) {
      // no valid CX/test address — skip
      await logCommunication({
        channel: "email", audience: "cx", kind: "issue_to_cx", orderId: input.orderId,
        assignmentId: input.assignmentId ?? null, issueId: input.issueId ?? null,
        testMode, status: "skipped", provider: "resend", error: "no-cx-or-test-email", actor: input.author,
      });
      return;
    }

    const orderLabel = input.orderName ?? input.orderId.slice(0, 8);
    // Runtime DB-override layer — {} when nothing's overridden for "en",
    // which makes issueLabel() behave exactly as before (see lib/i18n/issueLabels.ts).
    const overrides = await loadOverrides(admin, "en");
    const { subject, html, bodyText: body } = buildIssueCxEmail(overrides, {
      orderLabel,
      issueType: input.issueType,
      author: input.author,
      message: input.body,
      orderUrl: `${BACKOFFICE_BASE}/orders/${input.orderId}`,
      testMode,
    });
    await sendEmail({
      to, from: from(), subject, body, html,
      context: {
        orderId: input.orderId, audience: "cx", kind: "issue_to_cx",
        assignmentId: input.assignmentId ?? null, issueId: input.issueId ?? null,
        testMode, actor: input.author,
      },
    });
  } catch (e) {
    captureError("issueComms.notifyCx", e);
  }
}

// Email the florist when CX replies or resolves. Recipient is the florist's
// shop email (or the test sink in test mode). Links to their order.
// Florist-facing → localized: subject + CTA come from the catalog via the
// florist's own `locale`; `body` is CX's free-typed reply/resolution text and
// is passed through as-is (never translated).
export async function notifyFloristOfIssue(input: {
  assignmentId: string;
  floristId?: string | null;
  orderId?: string | null;
  issueId?: string | null;
  floristEmail: string | null;
  floristLocale?: string | null;
  orderName: string | null;
  body: string;
  kind: "reply" | "resolved";
  actor?: string | null;
}): Promise<void> {
  try {
    const admin = createServiceClient();
    const { data: s } = await admin.from("app_settings").select("test_mode, test_email, email_issue_to_florist_enabled").eq("id", 1).single();
    const testMode = s?.test_mode ?? true;
    if (!emailEnabled(s, "issue_to_florist")) {
      await logCommunication({
        channel: "email", audience: "florist", kind: "issue_to_florist",
        orderId: input.orderId ?? null, floristId: input.floristId ?? null,
        assignmentId: input.assignmentId, issueId: input.issueId ?? null,
        testMode, status: "skipped", provider: "resend", error: "disabled-by-settings", actor: input.actor ?? null,
      });
      return;
    }
    const to = testMode ? s?.test_email ?? null : input.floristEmail;
    if (!to || !EMAIL_RE.test(to)) {
      // no valid florist/test address — skip
      await logCommunication({
        channel: "email", audience: "florist", kind: "issue_to_florist",
        orderId: input.orderId ?? null, floristId: input.floristId ?? null,
        assignmentId: input.assignmentId, issueId: input.issueId ?? null,
        testMode, status: "skipped", provider: "resend", error: "no-florist-or-test-email", actor: input.actor ?? null,
      });
      return;
    }

    const locale: Locale = resolveFloristLocale({ locale: input.floristLocale });
    // Runtime DB-override layer — {} when nothing's been edited for this
    // locale, so subject/CTA below are byte-identical to the old plain-t() calls.
    const overrides = await loadOverrides(admin, locale);
    const orderLabel = input.orderName ?? "your order";
    // One-click sign-in straight to the order's message thread. Test-mode
    // sends get the inert sentinel — this email is redirected to the SHARED
    // staff test inbox, and a real token here is a LOGIN to a real shop (the
    // same rule lib/offerVars.ts applies to the unsubscribe token).
    const orderUrl = await mintMagicLink(admin, {
      floristId: input.floristId ?? "",
      dest: orderDest(input.assignmentId),
      purpose: "issue",
      assignmentId: input.assignmentId,
      placeholder: testMode || !input.floristId,
    });
    // Assembly lives in lib/messages/builders.ts so the editor's preview and
    // this send are the same code path and cannot drift.
    const { subject, html, bodyText: body } = buildIssueFloristEmail(locale, overrides, {
      kind: input.kind === "resolved" ? "resolved" : "replied",
      orderLabel,
      message: input.body,
      orderUrl,
      testMode,
    });
    await sendEmail({
      to, from: from(), subject, body, html,
      context: {
        orderId: input.orderId ?? null, audience: "florist", kind: "issue_to_florist",
        floristId: input.floristId ?? null, assignmentId: input.assignmentId, issueId: input.issueId ?? null,
        testMode, actor: input.actor ?? null,
      },
    });
  } catch (e) {
    captureError("issueComms.notifyFlorist", e);
  }
}

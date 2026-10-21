import { requireAllowedUser, jsonError } from "@/lib/apiAuth";
import { defaultFrom } from "@/lib/emailFrom";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { sendEmail } from "@/lib/email";
import { BACKOFFICE_BASE } from "@/lib/emailLinks";
import { buildTestEmail } from "@/lib/messages/builders";
import { loadOverrides } from "@/lib/messageOverrides";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Settings → "Send test email": renders a sample of the shared branded shell
// and sends it to the configured `test_email`, so deliverability + rendering
// can be verified without waiting for a live order. Always routes through the
// test sink itself (there's no other recipient to pick) and always carries
// the test-mode banner, since this send only ever exists to prove the pipe
// works — never a real customer/florist message.
export async function POST(): Promise<Response> {
  const gate = await requireAllowedUser();
  if (!gate.ok) return gate.res;

  const admin = createServiceClient();
  const { data: s } = await admin.from("app_settings").select("test_email").eq("id", 1).single();
  const to = s?.test_email ?? null;
  if (!to || !EMAIL_RE.test(to)) {
    return jsonError("No valid test email is configured — set one in Settings first.", 400);
  }

  const overrides = await loadOverrides(createServiceClient(), "en");
  const { subject, html, bodyText: body } = buildTestEmail(overrides, {
    sentBy: gate.email,
    sentAt: new Date().toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }),
    backofficeUrl: BACKOFFICE_BASE,
  });

  const from = defaultFrom();
  const sent = await sendEmail({
    to, from, subject, body, html,
    context: { operation: "settings_test_email", audience: "staff", kind: "test", testMode: true, actor: gate.email },
  });

  if (!sent.ok) return Response.json({ ok: false, to, error: sent.error }, { status: 502 });
  return Response.json({ ok: true, to });
}

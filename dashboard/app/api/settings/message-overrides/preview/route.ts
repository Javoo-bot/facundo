import { requireRole } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { isLocale, DEFAULT_LOCALE } from "@/lib/i18n";
import { loadOverrides } from "@/lib/messageOverrides";
import { buildOfferEmailContent, formatOfferWhen, formatOfferReplyWindow, formatOfferDeliverBy } from "@/lib/reachoutSend";
import { formatOfferDeadline } from "@/lib/floristTime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Renders the offer email for the email-templates editor's "Preview" button
// — reuses lib/reachoutSend.ts::buildOfferEmailContent, the EXACT function
// sendOffer calls to build a real send, layered with whatever's currently
// saved in message_overrides for `locale`. Sample data only (this never reads
// a real order/assignment), so the preview can never leak real order/florist
// data and never touches `outreach`/`order_events`. Admin-gated like the rest
// of the editor.
export async function GET(request: Request): Promise<Response> {
  const gate = await requireRole("admin");
  if (!gate.ok) return gate.res;

  const url = new URL(request.url);
  const localeParam = url.searchParams.get("locale");
  const locale = isLocale(localeParam) ? localeParam : DEFAULT_LOCALE;

  const admin = createServiceClient();
  const overrides = await loadOverrides(admin, locale);

  // Sample data only — but rendered through the same formatters sendOffer
  // uses, so the preview shows real in-locale text (e.g. "aujourd'hui" /
  // "1 heure") instead of a hardcoded English "today" / "1 hour" that would
  // silently misrepresent non-EN locales. Sample delivery time is later
  // today (fixed at 18:00 local, not "+N hours", so it can't accidentally
  // cross midnight into tomorrow); sample expiry is 1 hour out, matching the
  // "1 hour" bucket the old hardcoded sample intended to show.
  // The sample shop is the same Girona florist the rest of this fixture
  // describes, so the previewed deadline and delivery times read in ITS zone.
  const SAMPLE_TZ = "Europe/Madrid";
  const now = new Date();
  const sampleDeliveryAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 0, 0).toISOString();
  const sampleExpiresAt = new Date(now.getTime() + 3600_000).toISOString();

  const { html } = buildOfferEmailContent(locale, overrides, {
    area: "Girona · Catalonia",
    city: "Girona",
    orderName: "#1234",
    when: formatOfferWhen(locale, overrides, sampleDeliveryAt),
    replyWindow: formatOfferReplyWindow(locale, overrides, sampleExpiresAt),
    deliverBy: formatOfferDeliverBy(locale, sampleDeliveryAt, SAMPLE_TZ),
    // Preview always shows the absolute-deadline sentence, since that's the
    // normal path for a real send. The countdown fallback (no coordinates on
    // the shop) is exercised in lib/reachoutSend.test.mjs rather than here.
    deadlineTime: formatOfferDeadline(locale, sampleExpiresAt, SAMPLE_TZ),
    payoutPrice: 42,
    assignmentId: "preview",
    testMode: true,
    floristName: "Floristería Preview",
    variant: "full",
    unsubscribeUrl: "https://example.com/florist/unsubscribe/preview",
    howItWorksUrl: "https://example.com/florist/how-it-works",
    helpUrl: "https://example.com/help",
    // Sample only — never a real magic token. This is the admin template
    // EDITOR's preview (no real order or florist involved), so there is
    // nothing to mint against; example.com keeps it inert by construction.
    orderUrl: "https://example.com/florist/m/preview",
    supportEmail: "florists@fc.example.com",
  });

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

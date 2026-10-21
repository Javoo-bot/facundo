import { createServiceClient } from "@/lib/supabaseAdmin";
import { currentFloristLocale } from "@/lib/floristAuth";
import { floristReadContext } from "@/lib/floristView";
import { t } from "@/lib/i18n";
import FloristOrderDetail from "@/components/florist/FloristOrderDetail";
import { computeSplit } from "@/lib/payoutMath";
import { haversineKm } from "@/lib/geo";
import { greetingKey } from "@/lib/floristGreeting";
import { floristTimeZone } from "@/lib/floristTime";
import type { PayoutSplit } from "@/components/florist/offer/OfferPayout";
import type { OrderAssignment, OrderLineItem, OrderIssue, IssueMessage } from "@/lib/types";
import { acceptBlockReason } from "@/lib/lateAccept";
import { localiseLineItems } from "@/lib/translations/lineItems";
import { readThread } from "@/lib/supportThread";
import { photoFeedback, reuploadDecision, type PhotoReview } from "@/lib/photoFeedback";
import OrderChat from "@/components/florist/OrderChat";

export const dynamic = "force-dynamic";

export default async function FloristOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const locale = await currentFloristLocale();
  const ctx = await floristReadContext();
  const notFound = <main className="ds page">{t(locale, "ui.orderDetail.notFound")}</main>;
  if (!ctx) return notFound; // layout gates; defensive
  const { data: a } = await ctx.db.from("order_assignments").select("*").eq("id", id).maybeSingle();
  // RLS returns null for a foreign assignment; under view-as (service client)
  // enforce ownership explicitly against the florist's assignment set.
  if (!a || (ctx.scope && !ctx.scope.assignmentIds.includes(id))) return notFound;
  const { data: order } = await ctx.db.from("orders").select("*").eq("id", a.order_id).maybeSingle();
  const { data: rawItems } = await ctx.db.from("order_line_items").select("*").eq("order_id", a.order_id);
  // What the florist has to ACT on — the product name, the recipe, what goes in
  // the box — in their own language. Shopify's own translations first, a cached
  // model draft for what Shopify hasn't translated, and English whenever either
  // would be wrong (see lib/translations/lineItems.ts). Never throws, so a
  // translation problem can't cost us an offer.
  const items = await localiseLineItems((rawItems ?? []) as OrderLineItem[], locale);
  // The florist's own shop coords (RLS scopes the florists table to the staff
  // allow-list, so read this assignment's florist via the service client — the
  // assignment is already RLS-scoped to this florist, so it's their own shop).
  const admin = createServiceClient();
  const { data: florist } = await admin.from("florists").select("lat, lng, trust_tier, owner_name").eq("id", a.florist_id).maybeSingle();
  const distance = haversineKm(florist?.lat, florist?.lng, order?.delivery_lat, order?.delivery_lng);
  // Time-of-day greeting on the offer, resolved from the SHOP's timezone — the
  // same server-side path the join form uses. Null when we hold no usable
  // coordinates; TimeGreeting then falls back to the browser clock after mount.
  const serverGreeting = greetingKey(floristTimeZone(florist?.lat, florist?.lng));
  // The florist's tier decides how their payout splits between accept and the
  // delivered photo — spelled out on the offer so there are no surprises. Both
  // reads are the florist's own (assignment already RLS-scoped to them).
  let payoutSplit: PayoutSplit | null = null;
  if (florist?.trust_tier) {
    const { data: tier } = await admin
      .from("trust_tiers")
      .select("split_on_accept, split_on_delivery, photo_required, hold_payout")
      .eq("code", florist.trust_tier)
      .maybeSingle();
    if (tier) {
      const s = computeSplit(a.payout_price ?? null, tier);
      payoutSplit = {
        total: a.payout_price ?? null,
        accept: s.accept,
        delivery: s.delivery,
        acceptPct: tier.split_on_accept ?? 0,
        deliveryPct: tier.split_on_delivery ?? 0,
        hold: s.hold,
        photoRequired: s.photoRequired,
        // A 0% delivery leg means this shop is paid in one go on accept. Derived
        // from the tier row, never from the tier CODE, so the offer copy and the
        // money can't drift apart. See lib/payoutMath.ts::isSinglePayment.
        singlePayment: s.singlePayment,
        tierLabel: null,
      };
    }
  }
  // The florist's own delivery-proof photo (RLS on delivery_events is staff-scoped,
  // so read it here via the service client — the assignment is already this florist's).
  // Newest first: a re-uploaded proof writes a NEW event (and a new R2 key when
  // the format differs), and the florist must see the photo they last sent.
  const { data: devents } = await admin
    .from("delivery_events")
    .select("type, photo_key")
    .eq("assignment_id", id)
    .order("created_at", { ascending: false });
  const deliveredPhotoKey = (devents ?? []).find((e) => e.type === "delivered_photo" && e.photo_key)?.photo_key ?? null;
  // Payouts already made on this order. Keyed by this assignment (ownership of
  // `a` is verified above), so ctx.db is safely scoped in both modes.
  const { data: payments } = await ctx.db
    .from("payouts")
    .select("id, leg, status, amount, rail, provider_ref")
    .eq("assignment_id", id)
    .order("created_at", { ascending: true });
  // Why the 30% is still parked, if it is. A held delivery leg used to render
  // one unchanging sentence ("we'll let you know") whether the photo showed the
  // wrong bouquet, was missing half the order, or — the case that actually hit
  // us in QA — was never looked at because our own verifier fell over. Read the
  // latest verdict and the reason the leg was parked, so the page can say which.
  const deliveryLeg = (payments ?? []).find((p) => p.leg === "delivery" && p.status !== "failed" && p.status !== "clawed_back") ?? null;
  let photoReview: PhotoReview | null = null;
  if (deliveryLeg?.status === "held") {
    const [{ data: verification }, { data: parkEvent }, { count: attempts }] = await Promise.all([
      admin.from("photo_verifications").select("verdict, confidence, providers").eq("assignment_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      admin.from("payment_events").select("payload").eq("payout_id", deliveryLeg.id).eq("type", "held_for_review").order("created_at", { ascending: false }).limit(1).maybeSingle(),
      admin.from("photo_verifications").select("id", { count: "exact", head: true }).eq("assignment_id", id),
    ]);
    const fb = photoFeedback(verification);
    // Only a leg parked on the PHOTO can be cleared by sending a better one —
    // the same rule the upload route enforces server-side.
    const parkedForPhoto = (parkEvent?.payload as { reason?: string } | null)?.reason === "photo-verdict";
    const gate = reuploadDecision({ attempts: attempts ?? 0, payoutStatus: "held" });
    if (fb) {
      photoReview = { ...fb, canReupload: parkedForPhoto && gate.allowed, attemptsLeft: gate.attemptsLeft };
    }
  }
  // Issue threads for this order (scoped to this florist's assignment — same
  // ownership guarantee used for delivery_events above).
  const { data: issues } = await admin.from("order_issues").select("*").eq("assignment_id", id).order("created_at", { ascending: false });
  const { data: messages } = await admin.from("issue_messages").select("*").eq("assignment_id", id).order("created_at", { ascending: true });
  const accepted = a.status === "accepted" || a.status === "delivered";
  // Whether the ORDER (not this assignment) is still up for grabs — lets a
  // florist who declined change their mind before someone else takes it.
  const orderOpen = order?.status === "received" || order?.status === "matched" || order?.status === "reaching_out";
  // Whether this florist may accept RIGHT NOW — the same predicate the accept
  // API enforces (lib/lateAccept.ts), evaluated here so the button and the API
  // can't disagree. Computed server-side rather than in the client because the
  // buffer lives in settings and the order's status isn't otherwise exposed to
  // the PWA; the API re-checks regardless, so a page that goes stale just earns
  // an honest 409 rather than a wrong outcome.
  const acceptBlock = order
    ? acceptBlockReason(
        { status: a.status, withdrawn_at: a.withdrawn_at ?? null },
        { status: order.status, deleted_at: order.deleted_at ?? null }
      )
    : "order-closed";
  const view = {
    order_name: order?.order_name, occasion: order?.occasion, greeting: order?.greeting,
    delivery_at: order?.delivery_at, delivery_window: order?.delivery_window, area: order?.delivery_area,
    address: accepted ? order?.delivery_address : null,   // PII: revealed only after accept
    recipient: accepted ? order?.recipient_name : null,
    // Same accept gate as address/recipient. Omitted here until 2026-09-14, which
    // meant a florist at the door had the name and the street but no way to call
    // — the one thing lib/supportFacts.ts already assumed this page was showing
    // when it taught the support agent to answer "what's the recipient's phone?".
    recipient_phone: accepted ? order?.recipient_phone : null,
    distance_km: distance,   // derived (rounded in the UI) — safe to show pre-accept
  };
  // The support thread for this order. Only once the florist has ACCEPTED:
  // before that there are no payouts and no delivery, so lib/supportFacts.ts
  // would hand the agent an empty list and every question would escalate. A
  // chat box that always says "a colleague will get back to you" is worse than
  // no chat box.
  const thread = accepted ? await readThread(a.florist_id, id) : null;
  // Widget-visibility switch — separate from support_agent_enabled, which
  // only gates the AI's auto-reply once the chat is open (lib/agentTurn.ts).
  // Off, the launcher and panel don't render at all.
  const { data: chatSettings } = await admin.from("app_settings").select("florist_chat_enabled").eq("id", 1).maybeSingle();
  return (
    <>
      <FloristOrderDetail assignment={a as OrderAssignment} view={view} items={items} accepted={accepted} orderOpen={orderOpen} acceptBlock={acceptBlock} deliveredPhotoKey={deliveredPhotoKey} payments={payments ?? []} orderId={a.order_id} issues={(issues ?? []) as OrderIssue[]} messages={(messages ?? []) as IssueMessage[]} payoutSplit={payoutSplit} greetingKey={serverGreeting} ownerName={florist?.owner_name ?? null} photoReview={photoReview} />
      {thread && chatSettings?.florist_chat_enabled && (
        <div style={{ marginTop: 12 }}>
          <OrderChat
            assignmentId={id}
            initialMessages={thread.messages}
            initialEscalated={thread.status === "awaiting_human"}
          />
        </div>
      )}
    </>
  );
}

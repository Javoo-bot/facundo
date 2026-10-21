import { createServerClient } from "@/lib/supabase";
import { getSessionUser, getStaffAccess } from "@/lib/authCache";
import SignInScreen from "@/components/SignInScreen";
import OrderDetailClient from "@/components/orders/OrderDetailClient";
import { resolveCandidateEngagement } from "@/lib/candidateEngagement";
import type { Order, OrderLineItem, OrderAssignment, OrderEvent, Florist, Payout, DeliveryEvent, TrustTier, OrderIssue, IssueMessage, OrderApproval, PhotoVerification } from "@/lib/types";
import type { Communication } from "@/components/communications/types";

export const dynamic = "force-dynamic";

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return <SignInScreen />;
  const { allowed, role } = await getStaffAccess(user.email);
  const supabase = await createServerClient();
  if (!allowed) {
    await supabase.auth.signOut();
    return <SignInScreen error="unauthorized" />;
  }
  const canManagePayouts = role === "finance" || role === "admin";
  const isAdmin = role === "admin";

  // Timeline wants newest-first (see brief), unlike the original ascending fetch.
  // `issue_messages` and `order_approvals` only depend on the order `id`
  // (known up front, same as everything else here) so they've been folded
  // into this block instead of being fetched as trailing sequential awaits.
  const [
    { data: order },
    { data: items },
    { data: assignments },
    { data: events },
    { data: settings },
    { data: trustTiers },
    { data: communications },
    { data: issueMessages },
    { data: approvals },
  ] = await Promise.all([
    supabase.from("orders").select("*").eq("id", id).maybeSingle(),
    supabase.from("order_line_items").select("*").eq("order_id", id),
    supabase.from("order_assignments").select("*").eq("order_id", id).order("rank", { nullsFirst: false }),
    supabase.from("order_events").select("*").eq("order_id", id).order("created_at", { ascending: false }),
    supabase.from("app_settings").select("test_mode, workflow_mode").eq("id", 1).maybeSingle(),
    supabase.from("trust_tiers").select("*"),
    // Every message (email + push, all audiences) sent for this order — the
    // per-order "Communications" card, distinct from the events timeline
    // below (which only carries state-change labels, no content).
    supabase.from("communications").select("*").eq("order_id", id).order("created_at", { ascending: false }),
    supabase.from("issue_messages").select("*").eq("order_id", id).order("created_at", { ascending: true }),
    // Step-mode (semi): any offer awaiting a human approve/edit/skip on this order.
    supabase.from("order_approvals").select("*").eq("order_id", id).eq("status", "pending").order("created_at", { ascending: false }),
  ]);
  if (!order) return <div style={{ padding: 24 }}>Order not found.</div>;

  // Direct admin-order deep link — SHOPIFY_SHOP (e.g. "x.myshopify.com") already
  // configured for write-back/reconcile (see lib/shopifyWriteback.ts). Any
  // *.myshopify.com host redirects /admin/orders/{id} to the real admin URL, so
  // no need to know the store's "handle" separately.
  const shopifyOrderUrl = process.env.SHOPIFY_SHOP && order.shopify_order_id
    ? `https://${process.env.SHOPIFY_SHOP}/admin/orders/${order.shopify_order_id}`
    : null;

  const floristIds = (assignments ?? []).map((a) => a.florist_id);
  const assignmentIds = (assignments ?? []).map((a) => a.id);

  // `cities` depends on `order.city_id`, only known once the first block above
  // resolves — folded in here (rather than a trailing sequential await) since
  // this block already waits on assignments/florists first.
  const [{ data: florists }, { data: payouts }, { data: deliveryEvents }, { data: photoVerifications }, { data: issues }, { data: city }] = await Promise.all([
    floristIds.length ? supabase.from("florists").select("*").in("id", floristIds) : Promise.resolve({ data: [] as Florist[] }),
    assignmentIds.length ? supabase.from("payouts").select("*").in("assignment_id", assignmentIds) : Promise.resolve({ data: [] as Payout[] }),
    assignmentIds.length ? supabase.from("delivery_events").select("*").in("assignment_id", assignmentIds) : Promise.resolve({ data: [] as DeliveryEvent[] }),
    // Read-only AI photo-verify judgments — informational for staff QA, does
    // not gate payout (see lib/payoutHold.ts, untouched by this fetch).
    assignmentIds.length
      ? supabase.from("photo_verifications").select("*").in("assignment_id", assignmentIds).order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as PhotoVerification[] }),
    supabase.from("order_issues").select("*").eq("order_id", id).order("created_at", { ascending: false }),
    // City name + country for the vitals strip (orders only carry a city_id).
    order.city_id
      ? supabase.from("cities").select("city, country").eq("id", order.city_id).maybeSingle()
      : Promise.resolve({ data: null as { city: string; country: string } | null }),
  ]);
  // "Add any florist" picker searches the roster on demand via
  // /api/florists/options (FloristPicker.tsx) instead of this page fetching
  // the full (and ever-growing) directory up front — see that route's header.

  // Did each candidate actually SEE the offer? Resolved with the service key
  // because two of its four sources (short_links, florist_magic_tokens) hold
  // credentials and have no staff read policy by design — only derived
  // booleans and timestamps cross to the client. See lib/candidateEngagement.ts.
  //
  // Non-fatal: this is a diagnostic strip on a page whose primary job is
  // showing the order. If it fails, the candidates render exactly as they did
  // before it existed rather than taking the page down with them.
  const engagement = await resolveCandidateEngagement(
    (assignments ?? []).map((a) => ({ id: a.id, florist_id: a.florist_id, sent_at: a.sent_at ?? null }))
  )
    .then((m) => Object.fromEntries(m))
    .catch((err: unknown) => {
      console.error("order page: candidate engagement unavailable —", err instanceof Error ? err.message : err);
      return undefined;
    });

  return (
    <OrderDetailClient
      engagement={engagement}
      canManagePayouts={canManagePayouts}
      isAdmin={isAdmin}
      shopifyOrderUrl={shopifyOrderUrl}
      order={order as Order}
      cityName={city?.city ?? null}
      countryName={city?.country ?? null}
      items={(items ?? []) as OrderLineItem[]}
      assignments={(assignments ?? []) as OrderAssignment[]}
      events={(events ?? []) as OrderEvent[]}
      florists={(florists ?? []) as Florist[]}
      testMode={settings?.test_mode ?? true}
      workflowMode={settings?.workflow_mode ?? "manual"}
      approvals={(approvals ?? []) as OrderApproval[]}
      payouts={(payouts ?? []) as Payout[]}
      deliveryEvents={(deliveryEvents ?? []) as DeliveryEvent[]}
      photoVerifications={(photoVerifications ?? []) as PhotoVerification[]}
      trustTiers={(trustTiers ?? []) as TrustTier[]}
      issues={(issues ?? []) as OrderIssue[]}
      issueMessages={(issueMessages ?? []) as IssueMessage[]}
      communications={(communications ?? []) as unknown as Communication[]}
    />
  );
}

import { createServiceClient } from "@/lib/supabaseAdmin";
import { floristReadContext } from "@/lib/floristView";
import { haversineKm } from "@/lib/geo";
import { acceptBlockReason } from "@/lib/lateAccept";
import FloristInbox from "@/components/florist/FloristInbox";

export const dynamic = "force-dynamic";

export default async function FloristInboxPage() {
  const ctx = await floristReadContext();
  if (!ctx) return null; // layout gates; defensive
  // RLS scopes assignments to the florist; in a staff view-as session we read via
  // the service client and scope explicitly by florist_id (order_assignments
  // carries it directly).
  let q = ctx.db
    .from("order_assignments")
    .select(
      "id, status, offer_kind, offer_expires_at, payout_price, florist_id, withdrawn_at, orders(order_name, delivery_area, delivery_at, delivery_lat, delivery_lng, occasion, status, deleted_at, order_line_items(title, image_url, bouquet_spec, quantity, product_type, unit_price, line_total))"
    )
    // `expired` is in here so a florist who missed the window can still find the
    // order in the app — the offer email links straight to the detail page, but
    // someone reopening the PWA to reconsider would otherwise see nothing. Most
    // expired rows are genuinely dead, so they're filtered below to the ones
    // this florist can actually still accept.
    .in("status", ["candidate", "queued", "sent", "opened", "accepted", "expired"]);
  if (ctx.scope) q = q.eq("florist_id", ctx.floristId);
  const { data } = await q.order("assigned_at", { ascending: false });

  // Distance from the florist's shop to each delivery — a key triage fact. The
  // florists table is staff-scoped under RLS, so read the shop coords via the
  // service client keyed on this florist's id.
  const rows = data ?? [];
  const floristId = ctx.floristId;
  let shopLat: number | null = null;
  let shopLng: number | null = null;
  {
    const admin = createServiceClient();
    const { data: f } = await admin.from("florists").select("lat, lng").eq("id", floristId).maybeSingle();
    shopLat = f?.lat ?? null;
    shopLng = f?.lng ?? null;
  }
  // Keep only the expired rows this florist could still act on, using the same
  // predicate the Accept button and the accept API use (lib/lateAccept.ts) — an
  // offer that lapsed because someone else took the order stays hidden.
  const { data: offerCfg } = await createServiceClient()
    .from("app_settings")
    .select("late_accept_buffer_hours")
    .eq("id", 1)
    .maybeSingle();
  const bufferHours = offerCfg?.late_accept_buffer_hours ?? 2;
  const nowMs = Date.now();
  const visible = rows.filter((r) => {
    if (r.status !== "expired") return true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped Supabase join shape
    const o = (r as any).orders;
    if (!o) return false;
    return acceptBlockReason(
      { status: r.status, withdrawn_at: (r as { withdrawn_at?: string | null }).withdrawn_at ?? null },
      { status: o.status, deleted_at: o.deleted_at ?? null }
    ) === null;
  });

  // Forward only the DERIVED distance — never the raw recipient coordinates.
  // Props from a Server Component serialize into the client payload whether or
  // not they're rendered, so leaving delivery_lat/lng on the row would ship a
  // pre-accept recipient location to the browser (the address/recipient are
  // deliberately withheld until accept — mirror that here for the coords).
  const withDistance = visible.map((r) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped Supabase join shape
    const { orders, ...rest } = r as any;
    // `status`/`deleted_at` were read only to evaluate the predicate above —
    // drop them rather than shipping order-workflow state to the browser.
    const { delivery_lat, delivery_lng, status: _orderStatus, deleted_at: _orderDeletedAt, ...orderRest } = orders ?? {};
    return { ...rest, orders: orderRest, distance_km: haversineKm(shopLat, shopLng, delivery_lat, delivery_lng) };
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase join shape (orders(...)) is untyped here
  return <FloristInbox rows={withDistance as any[]} />;
}

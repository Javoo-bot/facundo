import SignInScreen from "@/components/SignInScreen";
import Forbidden from "@/components/Forbidden";
import Link from "next/link";
import { getSessionUser, getStaffAccess } from "@/lib/authCache";
import { createServerClient } from "@/lib/supabase";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { backofficeOrderPath, floristOrderPath, formatDemoIds } from "@/lib/testing/demoLinks";
import DemoSplitViewClient from "@/components/testing/DemoSplitViewClient";

export const dynamic = "force-dynamic";

// Presenter split-view for one demo order: a Demo Control Room helper, not a
// third rendering of the order — it links out to the REAL backoffice order
// page and mints a REAL florist magic link rather than re-implementing either
// screen. No iframes (auth headers make them unreliable across origins/cookie
// contexts) — links and cards only. Same admin gate as /testing (see that
// page's comment for why).
export default async function DemoSplitViewPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const user = await getSessionUser();
  if (!user) return <SignInScreen />;
  const { allowed, role } = await getStaffAccess(user.email);
  const supabase = await createServerClient();
  if (!allowed) {
    await supabase.auth.signOut();
    return <SignInScreen error="unauthorized" />;
  }
  if (role !== "admin") return <Forbidden reason="The demo split view is only available to Admins." />;

  const admin = createServiceClient();
  const { data: order } = await admin
    .from("orders")
    .select(
      "id, order_name, status, is_demo, demo_source_order_id, delivery_area, created_at, order_assignments(id, florist_id, status, payout_price, offer_expires_at, accepted_at, delivered_at)"
    )
    .eq("id", orderId)
    .maybeSingle();

  // Never render a real order here, even if someone hand-edits the URL.
  if (!order || order.is_demo !== true) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-12">
        <p className="eyebrow">Demo Control Room</p>
        <h1 className="mt-1 text-lg font-semibold text-ink">Not a demo order</h1>
        <p className="mt-2 text-sm text-ink-soft">
          {order
            ? "This order exists but isn't a demo order (orders.is_demo is not true) — the split view refuses to render real orders."
            : "No order found for this id."}
        </p>
        <Link href="/testing" className="mt-4 inline-block text-sm font-medium text-accent hover:underline">
          ← Back to Demo Control Room
        </Link>
      </div>
    );
  }

  const assignment = order.order_assignments?.[0] ?? null;

  return (
    <DemoSplitViewClient
      order={{
        id: order.id,
        order_name: order.order_name,
        status: order.status,
        delivery_area: order.delivery_area,
        demo_source_order_id: order.demo_source_order_id,
      }}
      assignment={assignment}
      backofficePath={backofficeOrderPath(order.id)}
      floristReferencePath={assignment ? floristOrderPath(assignment.id) : null}
      idBundle={formatDemoIds({ orderId: order.id, floristId: assignment?.florist_id ?? null, assignmentId: assignment?.id ?? null })}
    />
  );
}

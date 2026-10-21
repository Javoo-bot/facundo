import Link from "next/link";
import { createServerClient } from "@/lib/supabase";
import { getSessionUser, getStaffAccess } from "@/lib/authCache";
import SignInScreen from "@/components/SignInScreen";
import IssueThread from "@/components/issues/IssueThread";
import { dueLabel } from "@/lib/callCardFormat";
import type { OrderIssue, IssueMessage } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Reply to a florist, and nothing else.
 *
 * Reached from the Control panel and the order page. That button used to
 * land on `/orders/[id]#issues`, which is the right card on a page carrying
 * thirteen others — the operator arrived at a writing box surrounded by every
 * control in the system.
 *
 * So this page is the box. One column, the width of something you read: what
 * the florist said, what has been said back, and the field to answer in. The
 * order is named at the top for context and is not clickable, because there is
 * nothing else here to do.
 */
export default async function ReplyPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ issue?: string }>;
}) {
  const { id } = await params;
  const { issue: wantedIssue } = await searchParams;

  const user = await getSessionUser();
  if (!user) return <SignInScreen />;
  const { allowed, role } = await getStaffAccess(user.email);
  const supabase = await createServerClient();
  if (!allowed) {
    await supabase.auth.signOut();
    return <SignInScreen error="unauthorized" />;
  }
  const canReply = role === "ops" || role === "admin";

  const [{ data: order }, { data: issues }, { data: messages }] = await Promise.all([
    supabase.from("orders").select("id, order_name, delivery_at, delivery_area").eq("id", id).maybeSingle(),
    supabase.from("order_issues").select("*").eq("order_id", id).order("created_at", { ascending: false }),
    supabase.from("issue_messages").select("*").eq("order_id", id).order("created_at", { ascending: true }),
  ]);
  if (!order) return <div style={{ padding: 24 }}>Order not found.</div>;

  // The one the operator came here for: their explicit pick, else the oldest
  // still-open question, else the most recent thread.
  const all = (issues ?? []) as OrderIssue[];
  const open = all.filter((i) => i.status === "open");
  const issue =
    (wantedIssue && all.find((i) => i.id === wantedIssue)) ??
    open[open.length - 1] ??
    all[0] ??
    null;

  const orderName = order.order_name ?? `#${order.id.slice(0, 8)}`;
  const due = dueLabel(order.delivery_at, Date.now());

  return (
    <div className="ds" style={{ minHeight: "100%" }}>
      <div className="cs-reply">
        <div className="cs-minbar">
          <Link href="/" className="link-subtle" style={{ color: "var(--ink-faint)" }}>← Control panel</Link>
          <span className="cs-minbar-id">{orderName}</span>
          {order.delivery_area && <span>{order.delivery_area}</span>}
          {due && (
            <span className="cs-minbar-due" style={due.overdue ? { color: "var(--crit)" } : undefined}>{due.text}</span>
          )}
        </div>

        {!issue ? (
          <div className="cs-slab" style={{ gridTemplateColumns: "minmax(0,1fr)" }}>
            <div className="cs-slab-r">
              <h1 className="cs-shop" style={{ fontSize: "1.5rem" }}>Nothing to reply to</h1>
              <p className="cs-shop-facts">No florist has raised a question on this order.</p>
              <p style={{ marginTop: 20 }}>
                <Link href="/" className="btn btn-solid" style={{ textDecoration: "none" }}>Back to Control panel</Link>
              </p>
            </div>
          </div>
        ) : (
          <>
            <IssueThread
              issue={issue}
              messages={(messages ?? []).filter((m) => m.issue_id === issue.id) as IssueMessage[]}
              role="staff"
              replyUrl="/api/orders/issues/reply"
            />
            {!canReply && (
              <p className="cs-hint" style={{ marginTop: 14 }}>
                Your role can read this but not reply.
              </p>
            )}
            {/* Every other thread on this order, named but not opened — so a
                second question is findable without putting a second composer
                on a page whose point is one. */}
            {all.length > 1 && (
              <p className="cs-hint" style={{ marginTop: 18 }}>
                {all.length - 1} other {all.length - 1 === 1 ? "thread" : "threads"} on this order:{" "}
                {all
                  .filter((i) => i.id !== issue.id)
                  .map((i, n) => (
                    <span key={i.id}>
                      {n > 0 ? ", " : ""}
                      <Link href={`/orders/${order.id}/reply?issue=${i.id}`} className="link">
                        {i.type.replace(/_/g, " ")}
                        {i.status === "resolved" ? " (resolved)" : ""}
                      </Link>
                    </span>
                  ))}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

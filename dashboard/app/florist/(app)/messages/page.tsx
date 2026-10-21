import { currentFloristLocale } from "@/lib/floristAuth";
import { floristReadContext } from "@/lib/floristView";
import { mergeMessageList } from "@/lib/floristMessages";
import FloristMessages, { type IssueRow, type WelcomeRow } from "@/components/florist/FloristMessages";

export const dynamic = "force-dynamic";

// TWO sources in one list:
//   - order_issues     — something is wrong with a specific order. RLS scopes
//     these to this florist via their assignments (2026-07-14-issue-messaging.sql);
//     a staff view-as session reads via the service client and scopes by the
//     florist's assignment ids.
//   - florist_messages — addressed to the florist, not to an order (the welcome
//     note). Scoped by florist_id, which is also what stops a view-as session's
//     service client from reading someone else's.
// Ordering (unread first, then newest) is lib/floristMessages.ts::mergeMessageList.
export default async function FloristMessagesPage() {
  const ctx = await floristReadContext();
  if (!ctx) return null; // layout gates; defensive
  const locale = await currentFloristLocale();

  let issueQ = ctx.db
    .from("order_issues")
    .select("id, type, status, detail, stage, florist_unread, created_at, assignment_id, orders(order_name, delivery_at)");
  if (ctx.scope) issueQ = issueQ.in("assignment_id", ctx.scope.assignmentIds);

  const [{ data: issueData }, { data: messageData }] = await Promise.all([
    issueQ,
    ctx.db
      .from("florist_messages")
      .select("id, kind, florist_unread, created_at")
      .eq("florist_id", ctx.floristId),
  ]);

  const issues = (issueData ?? []) as unknown as IssueRow[];
  const messages = (messageData ?? []) as unknown as WelcomeRow[];
  const order = mergeMessageList(issues, messages);

  return <FloristMessages order={order} issues={issues} messages={messages} locale={locale} />;
}

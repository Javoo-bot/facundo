/** The florist "Messages" tab now has TWO sources, and this is the seam that
 * puts them in one list.
 *
 *   - `order_issues`  — something is wrong with a specific order. Actionable.
 *                       Links to that order.
 *   - `florist_messages` — addressed to the florist, not to an order (the
 *                       welcome note today). Links to its own detail page.
 *
 * Only the ORDERING lives here, because ordering is the part that is easy to
 * get subtly wrong and worth testing: unread first, then newest. Both sources
 * carry `florist_unread` and `created_at`, so the merge is a pure function over
 * a small normalised shape and needs no I/O.
 *
 * Relative imports only (no "@/..."), so plain `node --test` can reach it. */

export const MESSAGE_KINDS = ["welcome"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export function isMessageKind(x: unknown): x is MessageKind {
  return typeof x === "string" && (MESSAGE_KINDS as readonly string[]).includes(x);
}

/** One row in the merged list, from either source. */
export interface ListItem {
  id: string;
  source: "issue" | "message";
  unread: boolean;
  createdAt: string;
  /** Where tapping it goes. Issues go to their order; messages to their own page. */
  href: string;
}

export interface IssueLike {
  id: string;
  florist_unread: boolean;
  created_at: string;
  assignment_id: string | null;
}

export interface FloristMessageLike {
  id: string;
  florist_unread: boolean;
  created_at: string;
}

function time(iso: string): number {
  const ms = new Date(iso).getTime();
  // An unparseable timestamp sorts oldest rather than throwing or landing at
  // the top — a bad row must not push a real unread message down the list.
  return Number.isFinite(ms) ? ms : 0;
}

/** Merge both sources into one ordered list: unread first, then newest first.
 *
 * Within the unread group a florist message can outrank an order issue and vice
 * versa — deliberately. They are ordered by recency, not by source; pinning one
 * source above the other would bury a live order problem under a welcome note
 * the florist has already seen the content of. */
export function mergeMessageList(issues: IssueLike[], messages: FloristMessageLike[]): ListItem[] {
  const items: ListItem[] = [
    ...issues.map((i) => ({
      id: i.id,
      source: "issue" as const,
      unread: !!i.florist_unread,
      createdAt: i.created_at,
      // An issue whose assignment was cleared (on delete set null) has nowhere
      // specific to go; the florist home is a truthful fallback.
      href: i.assignment_id ? `/florist/orders/${i.assignment_id}` : "/florist",
    })),
    ...messages.map((m) => ({
      id: m.id,
      source: "message" as const,
      unread: !!m.florist_unread,
      createdAt: m.created_at,
      href: `/florist/messages/${m.id}`,
    })),
  ];

  return items.sort((a, b) => {
    if (a.unread !== b.unread) return a.unread ? -1 : 1;
    return time(b.createdAt) - time(a.createdAt);
  });
}

/** The number on the sidebar badge. Both sources, or the badge and the list
 * disagree — a badge reading "1" over an empty list is worse than no badge. */
export function unreadTotal(issueUnread: number | null, messageUnread: number | null): number {
  return (issueUnread ?? 0) + (messageUnread ?? 0);
}

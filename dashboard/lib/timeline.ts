import type { FloristMeeting, FloristNote, Outreach } from "./types";

export type TimelineItem =
  | {
      type: "email";
      at: string;
      subject: string | null;
      body: string | null;
      status: "sent" | "failed";
      toAddress: string | null;
      testMode: boolean;
    }
  | { type: "note"; at: string; author: string | null; body: string }
  | {
      type: "meeting";
      at: string;
      title: string | null;
      outcome: string | null;
      nextFollowUpAt: string | null;
    };

// Merge the three activity sources into one reverse-chronological feed. ISO-8601
// timestamps sort correctly as strings, so no Date parsing needed.
export function buildTimeline(
  outreach: Outreach[],
  notes: FloristNote[],
  meetings: FloristMeeting[]
): TimelineItem[] {
  const items: TimelineItem[] = [
    ...outreach.map((o): TimelineItem => ({
      type: "email",
      at: o.sent_at,
      subject: o.subject,
      body: o.body,
      status: o.status,
      toAddress: o.to_address,
      testMode: o.test_mode,
    })),
    ...notes.map((n): TimelineItem => ({
      type: "note",
      at: n.created_at,
      author: n.author,
      body: n.body,
    })),
    ...meetings.map((m): TimelineItem => ({
      type: "meeting",
      at: m.meeting_at,
      title: m.title,
      outcome: m.outcome,
      nextFollowUpAt: m.next_follow_up_at,
    })),
  ];
  return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

// The soonest meeting follow-up that has a date set — drives the "follow-up due"
// chip on the florist card. Null when no meeting has a next_follow_up_at.
export function earliestPendingFollowUp(
  meetings: FloristMeeting[]
): { at: string; title: string | null } | null {
  const pending = meetings
    .filter((m) => m.next_follow_up_at)
    .sort((a, b) => (a.next_follow_up_at! < b.next_follow_up_at! ? -1 : 1));
  return pending.length ? { at: pending[0].next_follow_up_at!, title: pending[0].title } : null;
}

// Row shape for the `communications` table (Workstream A backbone — see
// supabase/migrations/2026-07-24-communications.sql and
// lib/communicationsRow.ts::CommunicationInput, which is the write-side
// counterpart of this read-side type). One row per outbound message (email,
// push, or SMS) across every audience, carrying the actual subject/body content.

export type CommChannel = "email" | "push" | "sms";
export type CommAudience = "florist" | "client" | "cx" | "staff";
// `received` = an inbound reply from a florist (actor holds the sender).
export type CommStatus = "sent" | "failed" | "skipped" | "received";

export interface Communication {
  id: string;
  created_at: string;
  channel: CommChannel;
  audience: CommAudience;
  kind: string;
  order_id: string | null;
  florist_id: string | null;
  assignment_id: string | null;
  issue_id: string | null;
  to_address: string | null;
  subject: string | null;
  body: string | null;
  html: string | null; // rendered HTML of the actual email sent; null for push and pre-capture rows
  test_mode: boolean;
  status: CommStatus;
  provider: string;
  provider_message_id: string | null;
  error: string | null;
  actor: string | null;
}

/** `/communications` fetches with a nested `orders(order_name)` embed so the
 * Order column can show the human-readable order name without a second
 * round trip per row — same nested-select idiom as PaymentsLedger's
 * `order_assignments(order_id, orders(order_name), ...)`. */
export type CommunicationRow = Communication & {
  orders: { order_name: string | null } | null;
};

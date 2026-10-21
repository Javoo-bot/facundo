// Pure row-assembly for the communications log, extracted so it unit-tests
// under plain `node --test` without pulling in lib/communications.ts's
// runtime import (supabaseAdmin, which uses the `@/` alias `node --test`
// can't resolve) — same reasoning as lib/shopifyTags.ts for shopifyWriteback.ts.
//
// `kind` values in use: 'offer' | 'offer_push' | 'offer_sms' | 'client_assigned' |
// 'client_on_the_way' | 'client_delivered' | 'cx_alert' | 'cx_alert_push' |
// 'issue_to_cx' | 'issue_to_florist' | 'issue_push' | 'recruiting' | 'recruiting_sms' | 'test'.

export interface CommunicationInput {
  channel: "email" | "push" | "sms";
  audience: "florist" | "client" | "cx" | "staff";
  kind: string;
  orderId?: string | null;
  floristId?: string | null;
  assignmentId?: string | null;
  issueId?: string | null;
  to?: string | null; // email address or masked push endpoint; null for a batch push
  subject?: string | null; // null for push
  body?: string | null;
  html?: string | null; // rendered HTML of the actual email sent; null for push and for sends with no HTML alternative
  testMode: boolean;
  /** `received` is an INBOUND message: a florist's reply, logged by
   * lib/conversations.ts::ingestInbound so it shows on /communications and the
   * order page next to what we sent. Its `actor` is the sender's address. */
  status: "sent" | "failed" | "skipped" | "received";
  provider: string; // 'resend' | 'ongage' | 'web-push'
  providerMessageId?: string | null;
  /** The RFC 5322 Message-ID we set on an outbound email. Read back by
   * lib/inboundMatch.ts to attach a reply to this email's order. Distinct from
   * providerMessageId, which is Resend's own opaque id. */
  rfcMessageId?: string | null;
  error?: string | null;
  actor?: string | null; // who/what triggered the send (email or 'system')
}

// Assembles the `communications` insert row from a CommunicationInput. No DB,
// no I/O — safe to unit-test directly.
export function buildCommunicationRow(input: CommunicationInput): Record<string, unknown> {
  return {
    channel: input.channel,
    audience: input.audience,
    kind: input.kind,
    order_id: input.orderId ?? null,
    florist_id: input.floristId ?? null,
    assignment_id: input.assignmentId ?? null,
    issue_id: input.issueId ?? null,
    to_address: input.to ?? null,
    subject: input.subject ?? null,
    body: input.body ?? null,
    html: input.html ?? null,
    test_mode: input.testMode,
    status: input.status,
    provider: input.provider,
    provider_message_id: input.providerMessageId ?? null,
    rfc_message_id: input.rfcMessageId ?? null,
    error: input.error ?? null,
    actor: input.actor ?? null,
  };
}

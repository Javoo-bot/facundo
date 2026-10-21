import { IconAlertTriangle, IconBell, IconChatBubble, IconMail } from "@/components/icons";
import type { CommAudience, CommChannel, CommStatus } from "./types";

// Small gold "tag" style for a real-vs-test signal — copied verbatim from
// components/florist/ActivityTimeline.tsx's TAG_STYLE/email-test-tag
// treatment per the brief ("reuse ... do not invent a new one"): a wash
// background built with color-mix() since the amber token is a CSS var and
// Tailwind's opacity-modifier syntax doesn't compile against it.
const TEST_TAG_STYLE: React.CSSProperties = {
  background: "color-mix(in srgb, var(--tC) 14%, transparent)",
};

export function TestTag({ toAddress }: { toAddress: string | null }) {
  return (
    <span className="ml-1 rounded px-1 text-[10px] font-medium text-amber" style={TEST_TAG_STYLE}>
      test → {toAddress ?? "—"}
    </span>
  );
}

/** Bare channel icon (no label) — used in the per-order compact list's
 * "thumb" slot. */
export function ChannelIcon({ channel, style }: { channel: CommChannel; style?: React.CSSProperties }) {
  const Icon = channel === "email" ? IconMail : channel === "sms" ? IconChatBubble : IconBell;
  return <Icon style={{ width: 16, height: 16, color: "var(--ink-soft)", ...style }} aria-hidden="true" />;
}

const CHANNEL_LABEL: Record<CommChannel, string> = {
  email: "Email",
  push: "Push",
  sms: "SMS",
};

/** Icon + label — used in the `/communications` table's Channel column. */
export function ChannelLabel({ channel }: { channel: CommChannel }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <ChannelIcon channel={channel} />
      {CHANNEL_LABEL[channel]}
    </span>
  );
}

const AUDIENCE_BADGE: Record<CommAudience, string> = {
  florist: "badge-neutral",
  client: "badge-accent",
  cx: "badge-bloom",
  staff: "badge-bloom",
};
const AUDIENCE_LABEL: Record<CommAudience, string> = {
  florist: "Florist",
  client: "Client",
  cx: "CX",
  staff: "Staff",
};

export function AudienceBadge({ audience }: { audience: CommAudience }) {
  return <span className={`badge ${AUDIENCE_BADGE[audience]}`}>{AUDIENCE_LABEL[audience]}</span>;
}

const STATUS_BADGE: Record<CommStatus, string> = {
  sent: "badge-accent",
  failed: "badge-crit",
  skipped: "badge-neutral",
  received: "badge-bloom",
};
const STATUS_LABEL: Record<CommStatus, string> = {
  sent: "Sent",
  failed: "Failed",
  skipped: "Skipped",
  received: "Reply received",
};

export function StatusBadge({ status, error }: { status: CommStatus; error?: string | null }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span className={`badge ${STATUS_BADGE[status]}`}>{STATUS_LABEL[status]}</span>
      {status === "failed" && (
        <span title={error ?? "Send failed"} style={{ display: "inline-flex" }}>
          <IconAlertTriangle style={{ width: 14, height: 14, color: "var(--crit)" }} aria-label={error ?? "Send failed"} />
        </span>
      )}
    </span>
  );
}

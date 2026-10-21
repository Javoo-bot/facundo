"use client";
import { ENGAGEMENT_STAGES, type CandidateEngagement, type EngagementStage } from "@/lib/candidateEngagement";

// The compact engagement trail under each candidate on the order page.
//
// It answers the question the assignment status cannot: `sent` says we handed
// the offer to a provider, which is true whether the florist read it twice or
// never received it at all. Those are opposite problems — one is ours to fix,
// the other is a florist who isn't interested — and telling them apart used to
// mean cross-referencing the communications log by hand.

const LABEL: Record<EngagementStage, string> = {
  sent: "sent",
  delivered: "delivered",
  opened: "opened",
  clicked: "clicked",
  signed_in: "signed in",
};

/** What each stage means, for the hover. Written for whoever is deciding
 *  whether to nudge this florist or move to the next one. */
const MEANING: Record<EngagementStage, string> = {
  sent: "We handed the offer to the provider.",
  delivered: "The provider confirmed it reached the mailbox or handset.",
  opened: "The email was opened.",
  clicked: "They followed the link to the offer.",
  signed_in: "They signed in and landed on this order.",
};

const VIA_LABEL = { email: "email", sms: "SMS", web: "web" } as const;

function when(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString([], {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export default function CandidateProgress({ engagement }: { engagement: CandidateEngagement | undefined }) {
  // No row at all means nothing has been sent — the candidate is queued. Render
  // nothing rather than an all-grey trail implying a failed send.
  if (!engagement || !engagement.at.sent) return null;

  const reachedCount = ENGAGEMENT_STAGES.filter((s) => engagement.at[s]).length;

  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 4, flexWrap: "wrap" }}
      role="img"
      aria-label={
        `Engagement: reached “${LABEL[ENGAGEMENT_STAGES[reachedCount - 1]]}”` +
        ` — stage ${reachedCount} of ${ENGAGEMENT_STAGES.length}`
      }
    >
      {ENGAGEMENT_STAGES.map((stage, i) => {
        const at = engagement.at[stage];
        const reached = !!at;
        const via = engagement.via[stage];
        const title = reached
          ? `${LABEL[stage]}${via ? ` (${VIA_LABEL[via]})` : ""} — ${when(at)}\n${MEANING[stage]}`
          : `Not ${LABEL[stage]}. ${MEANING[stage]}`;
        return (
          <span key={stage} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {i > 0 && (
              <span aria-hidden style={{ color: "var(--ink-faint)", fontSize: ".65rem", opacity: reached ? 1 : 0.45 }}>
                ›
              </span>
            )}
            <span
              title={title}
              style={{
                fontSize: ".7rem",
                lineHeight: 1.6,
                padding: "0 6px",
                borderRadius: 999,
                whiteSpace: "nowrap",
                cursor: "help",
                // Reached stages carry the accent; the rest stay outlined and
                // faint, so the trail reads as a filled progress bar at a
                // glance without needing a legend.
                border: `1px solid ${reached ? "var(--accent)" : "var(--line)"}`,
                background: reached ? "var(--accent)" : "transparent",
                color: reached ? "var(--on-accent, #fff)" : "var(--ink-faint)",
              }}
            >
              {LABEL[stage]}
            </span>
          </span>
        );
      })}
    </div>
  );
}

"use client";
import type { TimelineItem } from "@/lib/timeline";
import { useT } from "@/components/florist/LocaleProvider";

const DOT: Record<TimelineItem["type"], string> = {
  email: "bg-accent",
  note: "bg-bloom",
  meeting: "bg-amber",
};

// Small gold "tag" style (test-mode / follow-up-due callouts) — a wash
// background built with color-mix() since the amber token is a CSS var and
// Tailwind's opacity-modifier syntax doesn't compile against it.
const TAG_STYLE = {
  background: "color-mix(in srgb, var(--tC) 14%, transparent)",
};

function fmt(at: string): string {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return at;
  return new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ItemHeader({ item }: { item: TimelineItem }) {
  const { t } = useT();
  if (item.type === "email") {
    return (
      <p className="font-medium text-ink">
        ✉ {item.status === "sent" ? t("ui.history.timeline.emailSent") : t("ui.history.timeline.emailFailed")}
        {item.subject ? ` — ${item.subject}` : ""}
        {item.testMode && (
          <span className="ml-1 rounded px-1 text-[10px] font-medium text-amber" style={TAG_STYLE}>
            {t("ui.history.timeline.testTag", { address: item.toAddress ?? "—" })}
          </span>
        )}
      </p>
    );
  }
  if (item.type === "note") {
    return <p className="font-medium text-ink">🗒 {t("ui.history.timeline.note")}{item.author ? ` — ${item.author}` : ""}</p>;
  }
  return (
    <p className="font-medium text-ink">
      📅 {t("ui.history.timeline.meeting")}{item.title ? ` — ${item.title}` : ""}
      {item.nextFollowUpAt && (
        <span className="ml-1 rounded px-1 text-[10px] font-medium text-amber" style={TAG_STYLE}>
          {t("ui.history.timeline.followUpTag", { when: fmt(item.nextFollowUpAt) })}
        </span>
      )}
    </p>
  );
}

function ItemBody({ item }: { item: TimelineItem }) {
  const text =
    item.type === "email" ? item.body : item.type === "note" ? item.body : item.outcome;
  if (!text) return null;
  return <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-ink-soft">{text}</p>;
}

export default function ActivityTimeline({ items }: { items: TimelineItem[] }) {
  const { t } = useT();
  if (items.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-line px-3 py-6 text-center text-sm text-ink-faint">
        {t("ui.history.timeline.empty")}
      </p>
    );
  }
  return (
    <ol className="relative ml-2 border-l border-line pl-5 text-sm">
      {items.map((item, i) => (
        <li key={i} className="relative pb-5 last:pb-0">
          <span
            aria-hidden
            className={`absolute -left-[27px] top-1 h-2.5 w-2.5 rounded-full ring-2 ring-surface ${DOT[item.type]}`}
          />
          <time className="text-[11px] text-ink-faint">{fmt(item.at)}</time>
          <ItemHeader item={item} />
          <ItemBody item={item} />
        </li>
      ))}
    </ol>
  );
}

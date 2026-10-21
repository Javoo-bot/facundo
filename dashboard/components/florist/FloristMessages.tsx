import Link from "next/link";
import { issueLabel } from "@/lib/i18n/issueLabels";
import { t, type Locale } from "@/lib/i18n";
import type { ListItem } from "@/lib/floristMessages";

export type IssueRow = {
  id: string;
  type: string;
  status: string;
  detail: string | null;
  stage: string | null;
  florist_unread: boolean;
  created_at: string;
  assignment_id: string | null;
  orders: { order_name: string | null; delivery_at: string | null } | null;
};

/** A florist-addressed message (florist_messages). No body here — `kind`
 * selects the catalog entry, rendered on the detail page. */
export type WelcomeRow = {
  id: string;
  kind: string;
  florist_unread: boolean;
  created_at: string;
};

function when(iso: string): string {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? "" : new Date(t).toLocaleDateString([], { day: "numeric", month: "short" });
}

function UnreadDot({ locale }: { locale: Locale }) {
  return (
    <span
      aria-label={t(locale, "ui.messages.unreadAriaLabel")}
      style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--crit)" }}
    />
  );
}

const cardStyle = {
  display: "grid",
  gap: 4,
  padding: 13,
  textDecoration: "none",
  color: "inherit",
  position: "relative",
} as const;

/** The florist's Messages tab. Two kinds of row share it: order issues (a
 * problem with one specific order) and florist messages (addressed to them,
 * not to an order). `order` decides the sequence — unread first, then newest,
 * see lib/floristMessages.ts — and the two lookup maps supply each row's own
 * rendering. */
export default function FloristMessages({
  order,
  issues,
  messages,
  locale,
}: {
  order: ListItem[];
  issues: IssueRow[];
  messages: WelcomeRow[];
  locale: Locale;
}) {
  const issueById = new Map(issues.map((i) => [i.id, i]));
  const messageById = new Map(messages.map((m) => [m.id, m]));

  return (
    <main className="ds page fc-readable" style={{ display: "grid", gap: 12 }}>
      <div>
        <p className="eyebrow">{t(locale, "ui.messages.eyebrow")}</p>
        <h1>{t(locale, "ui.messages.heading")}</h1>
      </div>

      {order.length === 0 && (
        <div className="ocard" style={{ padding: 16, color: "var(--ink-soft)", fontSize: ".9rem" }}>
          {t(locale, "ui.messages.empty")}
        </div>
      )}

      {order.map((row) => {
        if (row.source === "message") {
          const m = messageById.get(row.id);
          if (!m) return null;
          return (
            <Link key={row.id} href={row.href} className="ocard" style={cardStyle}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                {m.florist_unread && <UnreadDot locale={locale} />}
                <b style={{ fontSize: ".92rem" }}>{t(locale, "ui.messages.welcome.listTitle")}</b>
                <span className="badge badge-accent">{t(locale, "ui.messages.welcome.badge")}</span>
                <span style={{ marginLeft: "auto", fontSize: ".72rem", color: "var(--ink-faint)" }}>
                  {when(m.created_at)}
                </span>
              </div>
              <div style={{ fontSize: ".82rem", color: "var(--ink-soft)" }}>
                {t(locale, "ui.messages.welcome.intro")}
              </div>
            </Link>
          );
        }

        const r = issueById.get(row.id);
        if (!r) return null;
        const resolved = r.status === "resolved";
        return (
          <Link key={row.id} href={row.href} className="ocard" style={cardStyle}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {r.florist_unread && <UnreadDot locale={locale} />}
              <b style={{ fontSize: ".92rem" }}>{r.orders?.order_name ?? t(locale, "ui.messages.orderFallback")}</b>
              <span className={`badge ${resolved ? "badge-accent" : "badge-warn"}`}>
                {resolved ? t(locale, "ui.messages.resolved") : t(locale, "ui.messages.open")}
              </span>
              <span style={{ marginLeft: "auto", fontSize: ".72rem", color: "var(--ink-faint)" }}>
                {when(r.created_at)}
              </span>
            </div>
            <div style={{ fontSize: ".82rem", color: "var(--ink-soft)" }}>
              {issueLabel(locale, r.type)}
              {r.detail ? ` · ${r.detail}` : ""}
            </div>
          </Link>
        );
      })}
    </main>
  );
}

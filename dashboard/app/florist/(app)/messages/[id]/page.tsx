import Link from "next/link";
import { notFound } from "next/navigation";
import { currentFloristLocale } from "@/lib/floristAuth";
import { floristReadContext } from "@/lib/floristView";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { floristSinglePayment } from "@/lib/floristPayoutModel";
import { isMessageKind } from "@/lib/floristMessages";
import { t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

/** A message addressed to the florist rather than to an order — today, the
 * welcome note the join form creates. This is the deep-link target the
 * post-join magic link points at.
 *
 * The body is NOT stored: `kind` selects an i18n catalog entry rendered here,
 * so the copy stays translated and stays editable without touching old rows.
 * See supabase/migrations/2026-08-05-florist-messages.sql. */
export default async function FloristMessagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await floristReadContext();
  if (!ctx) return null; // layout gates; defensive
  const locale = await currentFloristLocale();

  // Filter by florist_id explicitly rather than leaning on RLS. For a real
  // florist it is redundant (RLS already scopes it); for a staff view-as
  // session `ctx.db` is the SERVICE client, which bypasses RLS entirely — so
  // this is the only thing stopping a crafted id from showing another
  // florist's message.
  const { data: message } = await ctx.db
    .from("florist_messages")
    .select("id, kind, created_at, florist_unread")
    .eq("id", id)
    .eq("florist_id", ctx.floristId)
    .maybeSingle();

  if (!message || !isMessageKind(message.kind)) notFound();

  // Opening it is what marks it read. Skipped for a staff view-as session:
  // staff looking at a florist's app must not clear that florist's unread dot.
  if (message.florist_unread && !ctx.viewingAsStaff) {
    const admin = createServiceClient();
    const { error } = await admin
      .from("florist_messages")
      .update({ florist_unread: false, read_at: new Date().toISOString() })
      .eq("id", message.id)
      .eq("florist_unread", true);
    // Best-effort: failing to clear the dot must not fail the page the florist
    // came here to read.
    if (error) console.error("florist/messages/[id]: mark-read failed", error.message);
  }

  const k = `ui.messages.welcome`;
  // The welcome note's "If you take it" section is the first thing a new shop
  // reads about money, and the default text promises 70% now / 30% on the photo.
  // A shop we onboard straight onto the paid-in-full tier would be reading the
  // wrong deal on day one, so the section swaps for its `acceptBodyFull`
  // sibling. Everything else in the note is true either way.
  const singlePayment = await floristSinglePayment();
  const sections = [
    { title: t(locale, `${k}.howTitle`), body: t(locale, `${k}.howBody`) },
    { title: t(locale, `${k}.acceptTitle`), body: t(locale, `${k}.${singlePayment ? "acceptBodyFull" : "acceptBody"}`) },
    { title: t(locale, `${k}.declineTitle`), body: t(locale, `${k}.declineBody`) },
    { title: t(locale, `${k}.nextTitle`), body: t(locale, `${k}.nextBody`) },
  ];

  return (
    <main className="ds page fc-readable" style={{ display: "grid", gap: 14 }}>
      <div>
        <Link href="/florist/messages" className="link-subtle">
          ← {t(locale, "ui.messages.heading")}
        </Link>
      </div>

      <div>
        <span className="badge badge-accent">{t(locale, `${k}.badge`)}</span>
        <h1 style={{ marginTop: 10 }}>{t(locale, `${k}.title`)}</h1>
        <p style={{ color: "var(--ink-soft)", fontSize: ".95rem", lineHeight: 1.55, marginTop: 8 }}>
          {t(locale, `${k}.intro`)}
        </p>
      </div>

      {sections.map((s) => (
        <div key={s.title} className="ocard" style={{ padding: 15 }}>
          <p style={{ fontWeight: 700, fontSize: ".92rem", margin: "0 0 5px" }}>{s.title}</p>
          <p style={{ color: "var(--ink-soft)", fontSize: ".88rem", lineHeight: 1.55, margin: 0 }}>{s.body}</p>
        </div>
      ))}

      <div>
        <Link href="/florist/how-it-works" className="link">
          {t(locale, `${k}.howItWorksLink`)} →
        </Link>
      </div>
    </main>
  );
}

import { currentFloristLocale } from "@/lib/floristAuth";
import { isSafeDest } from "@/lib/floristMagicLink";
import { loadHelpCopy } from "@/lib/help/loadHelp";
import { floristSinglePayment } from "@/lib/floristPayoutModel";
import { findArticle } from "@/lib/help/content";
import HelpCenter from "@/components/help/HelpCenter";

export const dynamic = "force-dynamic";

// The in-app Q&A. Same content module and same renderer as the public /help;
// this shell only differs in where the locale comes from (the florist's own
// account setting rather than a query param), in dropping the "join us" CTA,
// and in the back link.
//
// `?back=` is where the florist came from — set by the "I have a question
// first" button on an offer. Validated with the same `isSafeDest` guard the
// magic-link redirect uses, so a crafted link can't turn this page into an
// open redirect. Anything not a site-relative path is simply dropped and the
// page renders without a back link.

export default async function FloristHelpPage({
  searchParams,
}: {
  searchParams: Promise<{ a?: string; back?: string }>;
}) {
  const { a, back } = await searchParams;
  const locale = await currentFloristLocale();
  // Two published answers ("How and when do I get paid?", "How do I send the
  // delivery photo?") state the 70/30 split, and both are wrong for a shop paid
  // in full on accept. This is the ONE difference between the in-app Q&A and the
  // public one, which has no session and so keeps the default wording.
  const singlePayment = await floristSinglePayment();
  const { tt, supportEmail } = await loadHelpCopy(locale, { singlePayment });

  return (
    <main className="ds page fc-readable">
      <HelpCenter
        variant="app"
        locale={locale}
        tt={tt}
        openId={findArticle(a)?.id ?? null}
        back={isSafeDest(back) ? { href: back! } : null}
        supportEmail={supportEmail}
      />
    </main>
  );
}

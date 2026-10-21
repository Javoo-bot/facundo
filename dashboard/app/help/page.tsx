import type { Metadata } from "next";
import { headers } from "next/headers";
import { isLocale, DEFAULT_LOCALE } from "@/lib/i18n";
import { floristAppUrl } from "@/lib/hostRouting";
import { loadHelpCopy } from "@/lib/help/loadHelp";
import { findArticle } from "@/lib/help/content";
import HelpCenter from "@/components/help/HelpCenter";

export const dynamic = "force-dynamic";

// The PUBLIC Q&A, linked from the footer of the offer and recruiting emails.
// It sits at the URL root rather than under /florist/** because the in-app
// page owns /florist/help — Next would collide otherwise. The root is safe
// here: `lib/hostRouting.ts` passes any non-staff first segment on the florist
// host, and short links are 10 characters (lib/shortLink.ts), so `/help` can
// never be mistaken for one.
//
// Signed out by design: it must be readable by a florist we have emailed but
// who has never signed in. Nothing florist-, order- or customer-specific is
// read — only our own published copy.

export const metadata: Metadata = {
  title: "Questions & answers · Facundo florists",
  description: "How the app works, how you get paid, and what to do when something isn't right.",
};

export default async function PublicHelpPage({
  searchParams,
}: {
  searchParams: Promise<{ locale?: string; a?: string }>;
}) {
  const { locale: localeParam, a } = await searchParams;
  const locale = isLocale(localeParam) ? localeParam : DEFAULT_LOCALE;
  const { tt, supportEmail } = await loadHelpCopy(locale);

  // This page passes the host denylist on EVERY host (not a staff segment, not
  // a /florist path), so it also renders on bo.fc.example.net — which is where
  // staff open it to preview an edit. But /florist/** IS 404'd on that host, so
  // the "see how an order works" link at the foot, being relative, died there.
  // `floristAppUrl` is the existing answer to exactly this: an absolute URL to
  // the florist host when we're on the backoffice one, relative everywhere else.
  const host = (await headers()).get("host");
  const howItWorksHref = `${floristAppUrl(host)}/how-it-works?locale=${locale}`;

  return (
    <main className="ds" style={{ minHeight: "100dvh" }}>
      <HelpCenter
        variant="public"
        locale={locale}
        tt={tt}
        openId={findArticle(a)?.id ?? null}
        supportEmail={supportEmail}
        howItWorksHref={howItWorksHref}
      />
    </main>
  );
}

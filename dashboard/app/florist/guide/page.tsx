import type { Metadata } from "next";
import { resolveFloristLocale, t } from "@/lib/i18n";
import { floristSinglePayment, fullVariant } from "@/lib/floristPayoutModel";

export const metadata: Metadata = {
  title: "Your orders, and getting paid | Facundo",
  description: "How the Facundo florist app works: how an order reaches you, how to accept it, and how you get paid.",
};

/** The florist walkthrough — public, and meant to be sent to a shop directly.
 *
 * PUBLIC on purpose, and outside the `(app)` group: this is what we point a
 * florist at before they have an account, so it must render for a signed-out
 * visitor on the florist host. Same shape as /florist/how-it-works, which it
 * sits alongside — that page sells the offer, this one shows the app.
 *
 * Copy goes through `t()` against `ui.guide.*`, written in all six locales.
 * Nothing here falls back to English any more, so a shop in Girona or Bordeaux
 * reads this in its own language. Note the em-dash ban that lib/floristCopy's
 * guard test enforces on florist-facing copy: this page is squarely inside it,
 * including its <title>.
 *
 * The screenshots are real captures of the app at 430x932, served from
 * public/guide. They are framed as a phone in CSS (.fc-guide-phone) rather
 * than baked into the images, so re-capturing a screen never means re-cutting
 * a device frame.
 */

export const dynamic = "force-dynamic";

const STEPS = [1, 2, 3, 4, 5, 6] as const;

/** The `ui.guide.*` strings that state the 70/30 split, and so have a `*Full`
 * sibling for a florist paid in full on accept. Everything else on the page is
 * true either way and is rendered unchanged.
 *
 * An explicit list, NOT "always try `${key}Full`": t() echoes a missing key back
 * as its own text, so a blanket remap would print `ui.guide.stepsTitle` on the
 * page the moment a key had no variant. Same discipline as
 * lib/help/loadHelp.ts. */
const PAID_IN_FULL_KEYS = new Set([
  // leg1When / leg2When are deliberately NOT here: "The moment you accept" and
  // "When you send the photo" are true on both deals, so they have no variant.
  "ui.guide.leg1Note",
  "ui.guide.leg2Note",
  "ui.guide.barAlt", "ui.guide.sum",
  "ui.guide.step3Extra", "ui.guide.step5Extra",
  "ui.guide.acceptBody",
]);

/** Which screenshot belongs to which step. Steps 3 and 5 have none: accepting
 * is shown by the animation below instead, and the photo-upload screen has not
 * been captured — better an honest gap than a nearby screen implying it is the
 * right one. */
const STEP_SHOT: Record<number, string | null> = {
  1: "02-orders-table",
  2: "03-offer",
  3: null,
  4: "04-workorder",
  5: null,
  6: "06-history",
};

function Phone({ src, alt, small = false }: { src: string; alt: string; small?: boolean }) {
  return (
    <div className={small ? "fc-guide-phone fc-guide-phone--sm" : "fc-guide-phone"}>
      <div className="fc-guide-screen">
        {/* eslint-disable-next-line @next/next/no-img-element -- static export target, no loader */}
        <img src={src} alt={alt} loading="lazy" />
      </div>
    </div>
  );
}

export default async function FloristGuidePage({
  searchParams,
}: {
  searchParams: Promise<{ locale?: string }>;
}) {
  const { locale: raw } = await searchParams;
  const locale = resolveFloristLocale({ locale: raw ?? null });
  // The page is public, but it is also what "See how it works in more detail"
  // opens from inside the app. A florist paid in full on accept who followed
  // that link used to land on a 70/30 bar describing someone else's deal, so
  // when there IS a session we render theirs. No session (the recruiting case,
  // where we do not yet know which shops earn this) keeps the standard pitch.
  const singlePayment = await floristSinglePayment();
  const tt = (k: string) => t(locale, singlePayment ? fullVariant(k, PAID_IN_FULL_KEYS) : k);

  return (
    <main className="ds fc-guide" lang={locale}>
      <div className="fc-guide-wrap">
        <header>
          <p className="eyebrow">{tt("ui.guide.eyebrow")}</p>
          <h1>{tt("ui.guide.title")}</h1>
          <p className="fc-guide-lede">{tt("ui.guide.lede")}</p>
        </header>

        {/* The money first: it is what a florist opens this page to find out.
            Two legs for the split deal; for a florist paid in full, ONE leg
            carrying the whole figure and a second card that is still about the
            photo but no longer about money. The photo card is deliberately not
            dropped: removing it would leave a page that never mentions the
            photo at all, which is the wrong lesson. Its percentage becomes a
            check mark because there is no second payment to size. */}
        <section className="fc-guide-pay">
          <p className="mini-h">{tt("ui.guide.payTitle")}</p>
          <div className="fc-guide-legs">
            <div className="fc-guide-leg fc-guide-leg--a">
              <div className="fc-guide-pct">{singlePayment ? "100%" : "70%"}</div>
              <p className="fc-guide-when">{tt("ui.guide.leg1When")}</p>
              <p className="fc-guide-note">{tt("ui.guide.leg1Note")}</p>
            </div>
            <div className="fc-guide-leg fc-guide-leg--b">
              <div className="fc-guide-pct" aria-hidden={singlePayment || undefined}>
                {singlePayment ? "✓" : "30%"}
              </div>
              <p className="fc-guide-when">{tt("ui.guide.leg2When")}</p>
              <p className="fc-guide-note">{tt("ui.guide.leg2Note")}</p>
            </div>
          </div>
          <div className="fc-guide-bar" role="img" aria-label={tt("ui.guide.barAlt")}>
            {singlePayment ? (
              <span className="fc-guide-bar-a" style={{ flex: 100 }}>100%</span>
            ) : (
              <>
                <span className="fc-guide-bar-a">70%</span>
                <span className="fc-guide-bar-b">30%</span>
              </>
            )}
          </div>
          <p className="fc-guide-sum">{tt("ui.guide.sum")}</p>
        </section>

        <h2>{tt("ui.guide.stepsTitle")}</h2>
        <p className="fc-guide-sub">{tt("ui.guide.stepsSub")}</p>
        <ol className="fc-guide-steps">
          {STEPS.map((n) => {
            const shot = STEP_SHOT[n];
            return (
              <li key={n} className="fc-guide-step">
                <div className="fc-guide-num" aria-hidden="true">{n}</div>
                <div className="fc-guide-body">
                  <h3>{tt(`ui.guide.step${n}Title`)}</h3>
                  <p>{tt(`ui.guide.step${n}Body`)}</p>
                  <p>{tt(`ui.guide.step${n}Extra`)}</p>
                </div>
                <figure className="fc-guide-shot">
                  {shot ? (
                    <>
                      <Phone src={`/guide/${shot}.jpg`} alt={tt(`ui.guide.step${n}Caption`)} />
                      <figcaption>{tt(`ui.guide.step${n}Caption`)}</figcaption>
                    </>
                  ) : (
                    <p className="fc-guide-noshot">{tt(`ui.guide.step${n}Caption`)}</p>
                  )}
                </figure>
              </li>
            );
          })}
        </ol>

        <h2>{tt("ui.guide.acceptTitle")}</h2>
        <p className="fc-guide-sub">{tt("ui.guide.acceptSub")}</p>
        <div className="fc-guide-accept">
          <Phone src="/guide/accept.gif" alt={tt("ui.guide.acceptAlt")} />
          <div>
            <p>{tt("ui.guide.acceptBody")}</p>
            <p>{tt("ui.guide.declineBody")}</p>
          </div>
        </div>

        <h2>{tt("ui.guide.moneyTitle")}</h2>
        <p className="fc-guide-sub">{tt("ui.guide.moneySub")}</p>
        <div className="fc-guide-cards">
          {[
            ["05-balance", "balance"],
            ["06-history", "history"],
            ["07-messages", "messages"],
          ].map(([shot, key]) => (
            <div className="card fc-guide-card" key={key}>
              <Phone src={`/guide/${shot}.jpg`} alt={tt(`ui.guide.${key}Title`)} small />
              <h3>{tt(`ui.guide.${key}Title`)}</h3>
              <p>{tt(`ui.guide.${key}Body`)}</p>
            </div>
          ))}
        </div>

        <h2>{tt("ui.guide.signInTitle")}</h2>
        <p className="fc-guide-sub">{tt("ui.guide.signInSub")}</p>
        <div className="fc-guide-cards">
          <div className="card fc-guide-card">
            <Phone src="/guide/01-login.jpg" alt={tt("ui.guide.waysInTitle")} small />
            <h3>{tt("ui.guide.waysInTitle")}</h3>
            <p>{tt("ui.guide.waysInBody")}</p>
          </div>
          <div className="card fc-guide-card">
            <h3>{tt("ui.guide.accountTitle")}</h3>
            <p>{tt("ui.guide.accountBody")}</p>
          </div>
        </div>

        <footer className="fc-guide-footer">
          <p>{tt("ui.guide.footer")}</p>
        </footer>
      </div>
    </main>
  );
}

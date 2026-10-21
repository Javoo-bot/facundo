import { isLocale, DEFAULT_LOCALE, tWithOverrides } from "@/lib/i18n";
import { loadOverrides } from "@/lib/messageOverrides";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { floristSinglePayment, fullVariant } from "@/lib/floristPayoutModel";

export const dynamic = "force-dynamic";

// Public explainer, linked from the footer of every offer email. For a florist
// we've never worked with it is the only page they see before deciding whether
// we're worth a reply, so it's built as a real marketing surface rather than
// the debug-shaped <ol> in a 480px card it used to be.
//
// Copy lives in the catalog under `ui.howItWorks` and reads through the SAME
// runtime override layer as the emails (staff console -> Email templates), so
// an edit lands here with no deploy. It deliberately does NOT reuse the offer
// email's flowStep1..4: those are instructions about that email ("click
// below"), which means nothing on a web page.

const STEPS = [1, 2, 3, 4];
const PERKS = [1, 2, 3, 4];

/** The `ui.howItWorks.*` strings that state the 70/30 split, and so have a
 * `*Full` sibling for a florist paid in full on accept. Explicit rather than a
 * blanket `${key}Full`, for the reason spelled out in app/florist/guide. */
const PAID_IN_FULL_KEYS = new Set([
  "ui.howItWorks.subtitle",
  "ui.howItWorks.step2Title", "ui.howItWorks.step2Body", "ui.howItWorks.step3Body",
  "ui.howItWorks.payAccept", "ui.howItWorks.payPhoto",
]);

export default async function HowItWorksPage({
  searchParams,
}: {
  searchParams: Promise<{ locale?: string }>;
}) {
  const { locale: localeParam } = await searchParams;
  const locale = isLocale(localeParam) ? localeParam : DEFAULT_LOCALE;

  const overrides = await loadOverrides(createServiceClient(), locale);
  // Public page, but reachable from inside the app (the welcome message links
  // straight here). When a florist IS signed in we describe THEIR deal; with no
  // session it stays the standard pitch, which is what a prospect should read.
  // The key is remapped BEFORE the override lookup, so a staff edit to the
  // `*Full` string reaches these florists with no deploy, exactly as it does
  // for the standard copy.
  const singlePayment = await floristSinglePayment();
  const tt = (key: string) =>
    tWithOverrides(overrides, locale, singlePayment ? fullVariant(key, PAID_IN_FULL_KEYS) : key);

  const steps = STEPS.map((n) => ({ title: tt(`ui.howItWorks.step${n}Title`), body: tt(`ui.howItWorks.step${n}Body`) }));
  const perks = PERKS.map((n) => ({ title: tt(`ui.howItWorks.perk${n}Title`), body: tt(`ui.howItWorks.perk${n}Body`) }));

  return (
    <main className="ds fc-hiw" lang={locale}>
      {/* Scoped to this page: the shared design system has no timeline or
          split-bar primitive, and neither earns promotion for one caller. */}
      <style>{CSS}</style>

      <div className="fc-hiw-wrap">
        <header className="fc-hiw-hero">
          <p className="eyebrow">{tt("ui.howItWorks.eyebrow")}</p>
          <h1>{tt("ui.howItWorks.title")}</h1>
          <p className="fc-hiw-sub">{tt("ui.howItWorks.subtitle")}</p>
        </header>

        {/* The payment split IS the pitch, so it leads instead of hiding at the
            bottom of a list. The bar is proportional and aria-hidden — the
            legend beside it carries the same facts for a screen reader. */}
        <section className="fc-hiw-pay" aria-labelledby="fc-pay-h">
          <h2 id="fc-pay-h">{tt("ui.howItWorks.payTitle")}</h2>
          <div className="fc-hiw-bar" aria-hidden="true">
            {singlePayment ? (
              <span className="fc-hiw-bar-a" style={{ flex: 100 }}>100%</span>
            ) : (
              <>
                <span className="fc-hiw-bar-a">70%</span>
                <span className="fc-hiw-bar-b">30%</span>
              </>
            )}
          </div>
          {/* The legend carries the same facts for a screen reader (the bar is
              aria-hidden). Paid in full reads "100% when you accept, in one
              payment / Nothing left to wait for. Your photo is proof of
              delivery, not a payment gate." */}
          <div className="fc-hiw-legend">
            <p>
              <b>{singlePayment ? "100%" : "70%"}</b> {tt("ui.howItWorks.payAccept")}
            </p>
            <p>
              <b>{singlePayment ? tt("ui.howItWorks.payNothingLeft") : "30%"}</b>{" "}
              {tt("ui.howItWorks.payPhoto")}
            </p>
          </div>
          <p className="fc-hiw-paynote">{tt("ui.howItWorks.payNote")}</p>
        </section>

        <section aria-labelledby="fc-steps-h">
          <h2 id="fc-steps-h" className="fc-hiw-h2">
            {tt("ui.howItWorks.stepsTitle")}
          </h2>
          <ol className="fc-hiw-steps">
            {steps.map((s, i) => (
              <li key={i}>
                <span className="fc-hiw-num" aria-hidden="true">
                  {i + 1}
                </span>
                <div>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="fc-perks-h">
          <h2 id="fc-perks-h" className="fc-hiw-h2">
            {tt("ui.howItWorks.perksTitle")}
          </h2>
          <div className="fc-hiw-perks">
            {perks.map((p, i) => (
              <div className="fc-hiw-perk" key={i}>
                <h3>{p.title}</h3>
                <p>{p.body}</p>
              </div>
            ))}
          </div>
        </section>

        <footer className="fc-hiw-foot">
          <p>{tt("ui.howItWorks.footer")}</p>
          <p className="fc-hiw-mark">Facundo</p>
        </footer>
      </div>
    </main>
  );
}

// Plain CSS rather than inline styles: this needs pseudo-elements (the rule
// joining the step markers) and media queries, neither of which the style prop
// can express. Every value resolves through design-system.css tokens, so dark
// mode and the shared palette come for free.
const CSS = `
.fc-hiw { padding: 0 20px 72px; min-height: 100dvh; }
.fc-hiw-wrap { max-width: 680px; margin: 0 auto; }

.fc-hiw-hero { padding: 64px 0 40px; }
.fc-hiw-hero h1 {
  margin: 10px 0 0; font-size: clamp(1.9rem, 6vw, 2.6rem); line-height: 1.1;
  letter-spacing: -0.02em; color: var(--ink);
}
.fc-hiw-sub {
  margin: 14px 0 0; font-size: 1.05rem; line-height: 1.6; color: var(--ink-soft);
  max-width: 34em;
}

/* --- payment split --- */
.fc-hiw-pay {
  background: var(--surface); border: 1px solid var(--line-strong);
  border-radius: 16px; padding: 24px; margin: 0 0 44px;
}
.fc-hiw-pay h2 { margin: 0; font-size: 1.15rem; letter-spacing: -0.01em; color: var(--ink); }
.fc-hiw-bar { display: flex; gap: 4px; margin: 18px 0 12px; height: 44px; }
.fc-hiw-bar span {
  display: grid; place-items: center; border-radius: 8px;
  font: 700 0.95rem/1 var(--sans);
}
/* The 30% segment is a tinted wash with dark-green text, NOT the accent at
   reduced opacity: 50%-opacity accent under white text lands around 2:1, which
   fails contrast on the one number the florist most needs to read. */
.fc-hiw-bar-a { flex: 70; background: var(--accent); color: #fff; }
.fc-hiw-bar-b {
  flex: 30; background: var(--tA-wash); color: var(--accent-ink);
  border: 1px solid var(--line-strong);
}
/* --accent lightens to #52BD8A in dark mode, where white text on it is also
   ~2:1 — flip the leading segment's label to the page's dark ink instead.
   (That segment reads "70%" on a split tier and "100%" on a paid-in-full one;
   it carries the same class either way, so this applies to both.) */
@media (prefers-color-scheme: dark) {
  .ds:not([data-theme="light"]) .fc-hiw-bar-a { color: #0E1512; }
}
.ds[data-theme="dark"] .fc-hiw-bar-a { color: #0E1512; }
.fc-hiw-legend { display: flex; flex-wrap: wrap; gap: 6px 24px; }
.fc-hiw-legend p { margin: 0; font-size: 0.92rem; color: var(--ink-soft); }
.fc-hiw-legend b { color: var(--ink); }
.fc-hiw-paynote {
  margin: 16px 0 0; padding-top: 14px; border-top: 1px solid var(--line);
  font-size: 0.92rem; color: var(--ink-faint);
}

.fc-hiw-h2 { margin: 0 0 20px; font-size: 1.15rem; letter-spacing: -0.01em; color: var(--ink); }

/* --- numbered steps, joined by a rule down the gutter --- */
.fc-hiw-steps { list-style: none; margin: 0 0 48px; padding: 0; }
.fc-hiw-steps li {
  position: relative; display: grid; grid-template-columns: 34px 1fr; gap: 16px;
  padding: 0 0 26px;
}
.fc-hiw-steps li::before {
  content: ""; position: absolute; left: 16px; top: 38px; bottom: 0;
  width: 1px; background: var(--line-strong);
}
.fc-hiw-steps li:last-child { padding-bottom: 0; }
.fc-hiw-steps li:last-child::before { display: none; }
.fc-hiw-num {
  display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%;
  background: var(--surface); border: 1px solid var(--accent); color: var(--accent);
  font: 700 0.9rem/1 var(--sans); position: relative; z-index: 1;
}
.fc-hiw-steps h3 { margin: 6px 0 4px; font-size: 1rem; color: var(--ink); }
.fc-hiw-steps p { margin: 0; font-size: 0.95rem; line-height: 1.6; color: var(--ink-soft); }

/* --- perks --- */
.fc-hiw-perks { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.fc-hiw-perk { background: var(--surface-2); border-radius: 12px; padding: 16px 18px; }
.fc-hiw-perk h3 { margin: 0 0 4px; font-size: 0.95rem; color: var(--ink); }
.fc-hiw-perk p { margin: 0; font-size: 0.9rem; line-height: 1.55; color: var(--ink-soft); }

.fc-hiw-foot {
  margin-top: 48px; padding-top: 22px; border-top: 1px solid var(--line);
  display: flex; flex-wrap: wrap; gap: 8px 16px; justify-content: space-between;
  align-items: baseline;
}
.fc-hiw-foot p { margin: 0; font-size: 0.88rem; color: var(--ink-faint); }
.fc-hiw-mark { font: 600 0.88rem/1 var(--sans); color: var(--ink-faint); letter-spacing: 0.02em; }

@media (max-width: 560px) {
  .fc-hiw-hero { padding: 40px 0 28px; }
  .fc-hiw-perks { grid-template-columns: 1fr; }
}
`;

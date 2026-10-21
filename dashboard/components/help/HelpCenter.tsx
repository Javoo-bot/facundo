import Link from "next/link";
import { HELP_CATEGORIES, helpKey, helpSections, findArticle, type HelpArticle } from "@/lib/help/content";
import HelpMedia from "@/components/help/HelpMedia";
import HelpJump from "@/components/help/HelpJump";

/**
 * The Q&A itself, shared by the public page (`app/help`) and the in-app page
 * (`app/florist/(app)/help`). Presentational and server-only: it does no I/O
 * and holds no state — the caller resolves the locale, loads the override
 * layer once, and hands in `tt`.
 *
 * STILL zero client JavaScript, including the category tabs. The accordion is
 * native `<details>`/`<summary>` — `name` makes it exclusive, so opening one
 * answer closes the rest, with no state to manage. The tabs are a radio group
 * plus `:has()`, which is the same trick one layer up. Both work before
 * hydration, work with JS off, print, and are keyboard-navigable without us
 * writing any of that.
 *
 * `openId` (from `?a=`) expands one answer server-side AND selects its tab, so
 * a CX link to a single answer still lands on it: /help?a=missing-flower.
 */
export default function HelpCenter({
  variant,
  locale,
  tt,
  openId = null,
  back = null,
  supportEmail,
  howItWorksHref = "/florist/how-it-works",
}: {
  variant: "public" | "app";
  locale: string;
  /** Override-aware catalog lookup, already bound to `locale` by the caller. */
  tt: (key: string, vars?: Record<string, string | number>) => string;
  openId?: string | null;
  /** Where the florist came from (an offer). Public page never has one. */
  back?: { href: string } | null;
  supportEmail: string;
  /** Where "see how an order works" points. Passed in rather than built here
   * because it has to survive being rendered on the backoffice host, where
   * /florist/** is 404'd (see app/help/page.tsx). Only the public variant
   * shows it. */
  howItWorksHref?: string;
}) {
  const sections = helpSections(variant);
  // Which tab opens: the deep-linked answer's category when there is one, else
  // the first — HELP_CATEGORIES leads with "Orders & flowers" deliberately.
  const activeCategory = findArticle(openId)?.category ?? sections[0]?.category;
  // Deep links stay on whichever surface the reader is already on, and carry
  // `?back=` through so the return path to the order survives a related-link hop.
  const basePath = variant === "app" ? "/florist/help" : "/help";
  const hrefFor = (id: string) => {
    const params = new URLSearchParams({ a: id });
    if (variant === "app" && back) params.set("back", back.href);
    if (variant === "public") params.set("locale", locale);
    return `${basePath}?${params.toString()}#${id}`;
  };
  const question = (id: string) => tt(helpKey(id, "q"));
  // Both surfaces can be on the page at once only in theory, but the ids are
  // scoped anyway so a future embed can't collide with an article's own id.
  const tabId = (category: string) => `fc-cat-${category}`;

  const renderArticle = (article: HelpArticle) => {
    const labels = new Map<number, string>(
      (article.media?.kind === "image" ? (article.media.callouts ?? []) : []).map((c) => [
        c.n,
        tt(helpKey(article.id, `callout${c.n}`)),
      ])
    );
    return (
      // `name` makes the whole set exclusive: opening one answer closes any
      // other. Browsers without it (pre-2024) just keep several open, which is
      // the behaviour this page shipped with — a graceful loss, not a break.
      <details key={article.id} id={article.id} name="fc-help-answers" className="fc-help-item" open={article.id === openId}>
        <summary>
          <span>{question(article.id)}</span>
          <span className="fc-help-chev" aria-hidden="true">
            ›
          </span>
        </summary>
        <div className="fc-help-body">
          <p>{tt(helpKey(article.id, "body"), { supportEmail })}</p>
          {article.media && <HelpMedia media={article.media} alt={question(article.id)} labels={labels} />}
          {article.related && article.related.length > 0 && (
            <nav className="fc-help-rel" aria-label={tt("ui.help.relatedLead")}>
              <span className="fc-help-rel-l">{tt("ui.help.relatedLead")}</span>
              <ul>
                {article.related.map((id) => (
                  <li key={id}>
                    {/* A plain <a>, not next/link: a soft navigation re-renders
                        around the tabs' and accordion's uncontrolled DOM state
                        without re-applying it, which left the wrong tab showing
                        and the target answer hidden. HelpJump upgrades this to
                        an in-page jump; without it, the full load is correct. */}
                    <a href={hrefFor(id)} data-help-target={id} data-help-cat={findArticle(id)?.category}>
                      {question(id)}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </div>
      </details>
    );
  };

  return (
    <div className="fc-help" lang={locale}>
      <style>{CSS}</style>
      {/* The app renders inside a fixed 52/60px header; the public page has no
          chrome to clear. */}
      <HelpJump scrollOffset={variant === "app" ? 76 : 16} />
      <div className="fc-help-wrap">
        {/* Only ever present when the florist tapped "I have a question first"
            on a live offer. Saying nothing changed is the entire promise of
            that button — reading this page must not feel like a detour that
            costs them the order. */}
        {back && (
          <div className="fc-help-back">
            <Link href={back.href}>← {tt("ui.help.backToOrder")}</Link>
            <p>{tt("ui.help.backNote")}</p>
          </div>
        )}

        <header className="fc-help-hero">
          <h1>{tt("ui.help.title")}</h1>
        </header>

        {/* Radio group + `:has()` = tabs with no client JS. Each radio sits
            immediately before its own label so `:focus-visible + label` can
            show a keyboard focus ring on the badge, and arrow keys move
            between tabs for free because they are genuinely radios. */}
        <div className="fc-help-tabbed">
          <div className="fc-help-tabs" role="group" aria-label={tt("ui.help.title")}>
            {sections.map((section) => (
              <span key={section.category} className="fc-help-tabwrap">
                <input
                  type="radio"
                  name="fc-help-cat"
                  id={tabId(section.category)}
                  className="fc-help-radio"
                  defaultChecked={section.category === activeCategory}
                />
                <label htmlFor={tabId(section.category)} className="fc-help-tab">
                  {tt(`ui.help.cat.${section.category}`)}
                </label>
              </span>
            ))}
          </div>

          {sections.map((section) => (
            <section
              key={section.category}
              className={`fc-help-panel fc-help-panel-${section.category}`}
              aria-labelledby={`fc-help-${section.category}`}
            >
              {/* Kept for screen readers and for the no-`:has()` fallback, where
                  every panel is shown stacked and needs its own heading. Hidden
                  visually when the tabs work, since the badge already says it. */}
              <h2 id={`fc-help-${section.category}`} className="fc-help-h2">
                {tt(`ui.help.cat.${section.category}`)}
              </h2>
              <div className="fc-help-list">{section.articles.map(renderArticle)}</div>
            </section>
          ))}
        </div>

        {/* The public page is read by florists who may never have heard of us —
            it ends by pointing at the pitch. The in-app page does not: its
            reader has already joined. */}
        {variant === "public" && (
          <section className="fc-help-join">
            <h2>{tt("ui.help.joinTitle")}</h2>
            <p>{tt("ui.help.joinBody")}</p>
            <Link className="fc-help-cta" href={howItWorksHref}>
              {tt("ui.help.howItWorksLink")} →
            </Link>
          </section>
        )}
      </div>
    </div>
  );
}

// Scoped plain CSS, matching /florist/how-it-works: `<details>` needs
// pseudo-element and `[open]` selectors that the style prop can't express.
// Every value resolves through design-system.css tokens, so both themes and
// the shared palette come for free.
const PANEL_RULES = HELP_CATEGORIES.map(
  (c) => `  .fc-help-tabbed:has(#fc-cat-${c}:checked) .fc-help-panel-${c} { display: block; }`
).join("\n");

const CSS = `
.fc-help { padding: 0 20px 72px; }
.fc-help-wrap { max-width: 680px; margin: 0 auto; }

.fc-help-back {
  margin: 20px 0 0; padding: 14px 16px; border-radius: 12px;
  background: var(--tA-wash); border: 1px solid var(--line-strong);
}
.fc-help-back a { font-weight: 600; color: var(--accent-ink); text-decoration: none; font-size: .95rem; }
.fc-help-back p { margin: 4px 0 0; font-size: .85rem; color: var(--ink-soft); }

.fc-help-hero { padding: 40px 0 20px; }
.fc-help-hero h1 {
  margin: 0; font-size: clamp(1.7rem, 5vw, 2.3rem); line-height: 1.12;
  letter-spacing: -0.02em; color: var(--ink);
}

.fc-help-h2 {
  margin: 0 0 12px; font-size: .8rem; letter-spacing: .08em; text-transform: uppercase;
  color: var(--ink-faint); font-weight: 700;
}

/* --- category tabs: a radio group wearing badges --- */
.fc-help-tabs { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 22px; }
.fc-help-tabwrap { display: inline-flex; }
/* Off-screen rather than display:none — a hidden input can't be focused, and
   the whole keyboard story here depends on these still being real radios. */
.fc-help-radio {
  position: absolute; width: 1px; height: 1px; margin: 0;
  opacity: 0; pointer-events: none;
}
.fc-help-tab {
  display: inline-block; cursor: pointer; user-select: none;
  padding: 8px 15px; border-radius: 999px;
  border: 1px solid var(--line-strong); background: var(--surface);
  font: 600 .85rem/1.2 var(--sans); color: var(--ink-soft);
  transition: background .12s ease, color .12s ease, border-color .12s ease;
}
.fc-help-tab:hover { border-color: var(--accent); color: var(--accent-ink); }
/* German runs long ("Bestellungen & Blumen", "Wer wir sind & Hilfe") and spills
   to three rows on a 360px phone at the full size. */
@media (max-width: 430px) {
  .fc-help-tabs { gap: 6px; }
  .fc-help-tab { padding: 7px 12px; font-size: .78rem; }
}
.fc-help-radio:checked + .fc-help-tab {
  background: var(--accent); border-color: var(--accent); color: #fff;
}
.fc-help-radio:focus-visible + .fc-help-tab { outline: 2px solid var(--accent); outline-offset: 2px; }
/* --accent lightens in dark mode, where white on it lands near 2:1 — flip the
   selected label to the page's dark ink instead (same fix as fc-hiw-bar-a). */
@media (prefers-color-scheme: dark) {
  .ds:not([data-theme="light"]) .fc-help-radio:checked + .fc-help-tab { color: #0E1512; }
}
.ds[data-theme="dark"] .fc-help-radio:checked + .fc-help-tab { color: #0E1512; }

/* One panel at a time. Guarded by @supports so a browser without :has() shows
   every category stacked with its heading — exactly how this page shipped —
   rather than showing nothing at all. The tab row hides with it, since tabs
   that don't switch anything would be a lie. */
.fc-help-tabs { display: none; }
@supports selector(:has(*)) {
  .fc-help-tabs { display: flex; }
  .fc-help-tabbed .fc-help-panel { display: none; }
  .fc-help-tabbed .fc-help-panel > .fc-help-h2 {
    position: absolute; width: 1px; height: 1px; overflow: hidden;
    clip-path: inset(50%); white-space: nowrap;
  }
${PANEL_RULES}
}

.fc-help-list { border-top: 1px solid var(--line); }
.fc-help-item { border-bottom: 1px solid var(--line); }
.fc-help-item > summary {
  list-style: none; cursor: pointer; display: flex; gap: 14px; align-items: baseline;
  justify-content: space-between; padding: 15px 2px; font-size: 1rem; line-height: 1.45;
  font-weight: 600; color: var(--ink);
}
.fc-help-item > summary::-webkit-details-marker { display: none; }
.fc-help-item > summary:hover { color: var(--accent-ink); }
/* Keyboard focus must stay visible — the default outline is removed by the
   list-style reset on some engines. */
.fc-help-item > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }
.fc-help-chev { flex-shrink: 0; color: var(--ink-faint); transition: transform .15s ease; font-size: 1.2rem; line-height: 1; }
.fc-help-item[open] > summary .fc-help-chev { transform: rotate(90deg); }

.fc-help-body { padding: 0 2px 18px; }
.fc-help-body > p { margin: 0; font-size: .95rem; line-height: 1.65; color: var(--ink-soft); max-width: 40em; }

.fc-help-media { margin: 16px 0 0; }
.fc-help-shot { position: relative; display: block; }
.fc-help-shot img {
  width: 100%; max-width: 320px; display: block; border-radius: 14px;
  border: 1px solid var(--line-strong);
}
.fc-help-pin {
  position: absolute; transform: translate(-50%, -50%);
  min-width: 24px; height: 24px; padding: 0 4px; border-radius: 999px;
  background: var(--accent); color: #fff; font: 700 .78rem/24px var(--sans);
  text-align: center; box-shadow: 0 1px 6px rgba(0,0,0,.28);
}
.fc-help-keys { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 7px; }
.fc-help-keys li { display: flex; gap: 9px; align-items: baseline; font-size: .88rem; color: var(--ink-soft); }
.fc-help-keynum {
  flex-shrink: 0; min-width: 20px; height: 20px; border-radius: 999px;
  background: var(--tA-wash); color: var(--accent-ink); border: 1px solid var(--line-strong);
  font: 700 .72rem/19px var(--sans); text-align: center;
}

.fc-help-rel { margin: 16px 0 0; }
.fc-help-rel-l {
  display: block; font-size: .72rem; letter-spacing: .08em; text-transform: uppercase;
  color: var(--ink-faint); font-weight: 700; margin-bottom: 5px;
}
.fc-help-rel ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.fc-help-rel a { font-size: .88rem; color: var(--accent-ink); }

.fc-help-foot, .fc-help-join { margin-top: 40px; padding-top: 24px; border-top: 1px solid var(--line); }
.fc-help-foot h2, .fc-help-join h2 { margin: 0 0 8px; font-size: 1.05rem; letter-spacing: -.01em; color: var(--ink); }
.fc-help-foot p, .fc-help-join p { margin: 0; font-size: .92rem; line-height: 1.6; color: var(--ink-soft); max-width: 40em; }
.fc-help-cta {
  display: inline-block; margin-top: 14px; padding: 10px 18px; border-radius: 10px;
  background: var(--accent); color: #fff; font-weight: 600; font-size: .92rem; text-decoration: none;
}
@media (prefers-color-scheme: dark) { .ds:not([data-theme="light"]) .fc-help-cta { color: #0E1512; } }
.ds[data-theme="dark"] .fc-help-cta { color: #0E1512; }
`;

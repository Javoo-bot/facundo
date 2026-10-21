# Florist Q&A / help centre — design

**Date:** 2026-08-10
**Status:** agreed, ready to build

## Why

A florist deciding on an offer has questions we currently answer nowhere: how the
70/30 payment actually works, whether they may substitute a flower they're out of,
what to do when something goes wrong, who we even are. Today their only options are
accept, decline, or ignore. `/florist/how-it-works` exists but is a *recruiting
pitch* — four steps and four perks — not an operational reference.

Two audiences, one body of content:

- **Signed-in florists** mid-decision or mid-order, inside the PWA.
- **Florists we've emailed but who have never signed in** — the public page linked
  from the offer and recruiting emails.

## Decisions

| Question | Decision |
|---|---|
| What does the offer-page button do? | Pure navigation to the Q&A with a back link to the order. No CX thread, no change to the offer's state. |
| Where does copy live? | i18n catalog under `ui.help.*`, read through the existing runtime override layer. Article *structure* is code. |
| Localized screenshots? | One neutral screenshot per topic + numbered callouts rendered as localized HTML on top. Not six screenshots per topic. |
| Video? | The renderer and content type support it; no article declares one yet. |
| Public vs in-app | `/help` (public, `?locale=`) and `/florist/help` (in-app). One `<HelpCenter>` renderer, one content module, two thin shells. |
| Entry points | `?` button in the PWA header, a Help row on Account, the offer-page button, and a footer link in the offer + recruiting emails. |

## Architecture

```
lib/help/content.ts           pure data — categories, articles, media refs
lib/help/content.test.mjs     node --test sanity (ids unique, catalog keys exist)
components/help/HelpCenter.tsx   shared renderer (server component)
components/help/HelpMedia.tsx    screenshot + positioned localized callouts; <video> branch
app/help/page.tsx                public shell  · ?locale=xx · join CTA
app/florist/(app)/help/page.tsx  in-app shell  · session locale · ?back= link
```

### Content model

```ts
type HelpMedia =
  | { kind: "image"; src: string; callouts?: { n: number; x: number; y: number }[] }
  | { kind: "video"; src: string; poster: string; captions: Locale[] };

interface HelpArticle {
  id: string;            // stable; also the ?a= deep-link value and catalog key segment
  category: HelpCategoryId;
  media?: HelpMedia;
  related?: string[];    // other article ids
}
```

Copy keys per article: `ui.help.a.<id>.q`, `ui.help.a.<id>.body`, and
`ui.help.a.<id>.callout<n>` when the media declares callouts. Categories carry
`ui.help.cat.<id>`. Everything resolves through
`tWithOverrides(loadOverrides(client, locale), locale, key)` — the same path
`/florist/how-it-works` uses, so staff can correct any answer from **Email
templates** without a deploy.

Structure changes (adding, removing or reordering an article) need a deploy.
That is the accepted trade: it keeps one content system instead of two, and
article *churn* is expected to be near zero next to wording churn.

### Rendering

- Answers are grouped into **category tabs** (badges), leading with *Orders &
  flowers* — what a florist holding an order is actually asking about.
  `HELP_CATEGORIES` is the single source of that order, shared with the
  backoffice editor.
- Accordion is native `<details>`/`<summary>`, made exclusive with `name`, so
  opening one answer closes the rest. The tabs are a radio group plus `:has()`.
  **Both are zero client JS** — they work before hydration, with JS off, and
  print. `?a=<id>` opens one answer server-side *and* selects its tab, giving CX
  a shareable deep link (`/help?a=missing-flower`).
- Related links are plain `<a href>` — a real navigation the server renders
  correctly. `components/help/HelpJump.tsx` (the page's only client JS) upgrades
  that to an in-page move: select the tab, open the answer, scroll smoothly,
  rewrite the URL. Needed because the tabs and accordion are uncontrolled DOM
  state, which a soft navigation re-renders around without re-applying.
- A browser without `:has()` falls back, via `@supports`, to every category
  stacked with its heading — how the page originally shipped — rather than a
  blank panel. One without `<details name>` keeps several answers open. Both
  losses are graceful.
- Callout labels are positioned HTML (`%` coordinates over the image), so they
  are selectable, translatable and screen-reader readable, and they never go
  stale when the underlying screenshot is retaken.
- Images live in `public/help/` and are served as Worker static assets. If a
  video is ever added and outgrows the asset budget, it moves to R2 behind a
  public route — not built now, because nothing would use it.

### Article set

**Using the app** — being told about an order · accepting one · installing the
app · where to find the recipe · sending the delivery photo · working language ·
teammates.

**Getting paid** — the 70/30 split · the Facundo card · photo not approved ·
no invoices.

**Orders & flowers** — substituting a flower · wrong address or absent recipient ·
accepted but can't fulfil · declining an offer · delivery timing.

**About us & support** — contacting a human · who Facundo is · what it costs ·
stopping offers. "Contacting a human" is where the old "Still stuck?" footer
went: it was the same answer, twice, in two places.

The substitution answer states the policy explicitly. **Corrected 2026-08-15
(product owner):** a flower may be swapped for another — never a rose — if the
replacement is **similar in shape and colour**, or if the swap **doesn't
change the bouquet's overall character**; either way, substitutions are
capped at **up to 30% of the bouquet's composition**. The florist must still
tell us through *Report a problem* so the customer is informed. (Superseded
the original "similar colour, one change per bouquet" wording, which was
narrower than the actual policy; see
`docs/superpowers/specs/2026-08-15-florist-operations-assistant-scope-design.md`
for the correction and `dashboard/lib/i18n/messages/*.ts`'s `missing-flower`
article, all six locales, for the shipped copy.)

### Offer-page button

A third action under Accept / Decline in `FloristOrderDetail.tsx`:

```
[ Accept this order              ]
[ I have a question first        ]  → /florist/help?back=/florist/orders/<id>
[ Can't take this one            ]
```

`?back=` is validated with `isSafeDest` (same guard the magic-link redirect uses)
and rendered as *"← Back to order #1234 — you can pick up where you left off."*
The offer is untouched: no state change, no countdown pause, no CX notification.

### Email + lifecycle

- `helpUrl` joins `howItWorksUrl` in `lib/offerVars.ts` and the message registry,
  and gets a footer link line in the offer email and the recruiting email.
- `lib/lifecycle.ts` gains a branch on the `florist-accept` stage —
  *"florist would accept but has a question"* → handled by the Q&A link — per the
  repo rule that the lifecycle map moves with the order loop.

### Backoffice editor

`/faq` (admin-only, sidebar → SYSTEM → **Florist Q&A**) edits the answers article
by article: locale switcher, a card per article with Question/Answer, Save and
Revert per article, an "edited (n)" pill, the EN string shown beneath each field
on a non-English locale, and a `{supportEmail}` placeholder warning driven by
`varsManifest`. Screenshot-label fields appear automatically once an article
declares an image.

It is `/faq` and not `/help` because `/help` is the public page and the two would
collide; `faq` is registered in `hostRouting.STAFF_SEGMENTS` so it 404s on the
florist host, and a test pins that `help` never becomes one (offer emails already
link to it there).

Storage is unchanged — `message_overrides`, the same rows `/email-templates`
writes. The three-layer resolution (override → locale catalog → EN), the draft
buffer and the save/revert round-trips moved into `lib/useCopyOverrides.ts`, now
shared by both pages rather than duplicated. `helpCopyKeys()` in
`lib/help/content.ts` is the single list of what the page renders, and
`content.test.mjs` asserts the editor covers all of it and offers nothing extra.

Article *structure* stays code, as above. The page says so.

## Non-goals

No CX chat from the Q&A (contact answers point at the existing paths: *Report a
problem* on an accepted order, or the support address). No search box — four
categories of short answers don't need one. No per-locale screenshots. No CMS.

## Verification

Done:

- `node --test` across the suite (900 pass), `tsc --noEmit`, `npm run build` and
  `next lint` all clean.
- `/help` and `/help?locale=es&a=missing-flower` exercised in a real browser,
  signed out: renders, the deep link opens the right answer, related links work.
  The page reads only `message_overrides` and `settings` — no florist, order or
  customer data.
- `/faq` rendered in a real browser (via a throwaway unauthenticated route,
  deleted afterwards). Signed out, `/faq` shows the sign-in screen and leaks
  nothing. Its `message_overrides` query was run read-only against the real DB.

Not done, and why:

- **The two screenshots.** They need a signed-in florist session against a live
  offer (staff login + `POST /api/dev/mock-order`), which wasn't available. The
  articles are text-only until someone captures them; `HELP_PENDING_KEYS` plus
  `content.test.mjs` make sure the parked copy can't be forgotten.
- **`/florist/help` rendered with a real florist session**, and a save round-trip
  in `/faq` — same missing-credentials reason. Both run on code paths that ship
  today (the `(app)` layout gate; the `/email-templates` save/revert logic, now
  shared rather than copied).

## Incidental fixes carried in the same change

- `EmailTemplatesClient` built its override map from a literal
  `{ en, fr, es, it, de }` and had silently missed `pt` since that locale was
  added: any Portuguese override row threw on load, and switching to PT crashed
  the page. Fixed by building from `LOCALES` in the extracted hook.
- The "no em dashes in catalog copy" guard matched `: "…",` on a single line, so
  it skipped every value long enough to wrap — which is where they hide. Replaced
  with a string-literal walker (comments still exempt). It immediately surfaced
  **16 pre-existing violations** in shipped copy across all six locales, all
  fixed. Not cosmetic: U+2014 is outside GSM-7 and doubles SMS cost.
- Removed `ui.help.howItWorksLead`, a key nothing rendered.

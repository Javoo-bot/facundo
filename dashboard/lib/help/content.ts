// The florist Q&A — STRUCTURE only. Every word a florist reads lives in the
// i18n catalog under `ui.help.*` and is resolved through the same runtime
// override layer as the emails (staff console -> Email templates), so a wrong
// or badly translated answer is fixed without a deploy. See
// components/help/HelpCenter.tsx for the renderer and app/help/page.tsx +
// app/florist/(app)/help/page.tsx for the two shells.
//
// Adding, removing or reordering an article DOES need a deploy. That is the
// deliberate trade for keeping one content system instead of two: wording
// changes constantly, the article list barely does.
//
// Pure data + pure helpers, no I/O — unit-tested directly under `node --test`
// (content.test.mjs), same convention as lib/i18n and lib/emailTemplate.ts.

/** A numbered marker over a screenshot. `x`/`y` are percentages of the image
 * box, so the marker tracks the image at any width. Its label is a catalog
 * string (`ui.help.a.<article>.callout<n>`), NOT pixels — one neutral
 * screenshot therefore serves all six locales, and retaking the screenshot
 * never invalidates a translation. */
export interface HelpCallout {
  n: number;
  x: number;
  y: number;
}

export type HelpMedia =
  | { kind: "image"; src: string; callouts?: HelpCallout[] }
  // Nothing declares a video yet — the branch exists so that adding one is a
  // content change rather than a code change. `captions` lists the locales that
  // have a WebVTT track at `<src-without-extension>.<locale>.vtt`.
  | { kind: "video"; src: string; poster: string; captions: string[] };

// Order matters twice over: it is the tab order on the page (the FIRST entry is
// the tab that opens by default) and the section order in the backoffice
// editor. "Orders & flowers" leads because that is what a florist holding an
// order in their hand is asking about — substitutions, a bad address, handing
// it back. "About us" is last for the same reason: it matters most to someone
// who has never worked with us, and least to everyone else.
export const HELP_CATEGORIES = ["orders", "money", "app", "about"] as const;
export type HelpCategoryId = (typeof HELP_CATEGORIES)[number];

export interface HelpArticle {
  /** Stable id. Doubles as the `?a=` deep-link value (CX shares
   * `/help?a=missing-flower`) and as the catalog key segment, so renaming one
   * breaks existing links — don't. */
  id: string;
  category: HelpCategoryId;
  media?: HelpMedia;
  /** Other article ids to offer at the end of this answer. */
  related?: string[];
  /** Only shown to a signed-in florist. Used for answers that are pure app
   * mechanics and would be noise to someone who has never seen the app. */
  appOnly?: boolean;
  /** This answer states the 70/30 split, so it needs a second body for a
   * florist paid in FULL on accept (a tier with a 0% delivery leg — see
   * lib/payoutMath.ts::isSinglePayment). The variant lives at
   * `ui.help.a.<id>.bodyFull`; same question, same id, same related links, and
   * lib/help/loadHelp.ts swaps it in for those florists only.
   *
   * Declared here rather than inferred from the catalog so that the editable-
   * keys list, the translation-parity guard and the swap all read one fact. */
  fullPayoutBody?: boolean;
}

// Order within a category is the order on the page. The lead article of each
// category is the question we actually get asked most, not the most logical
// starting point.
export const HELP_ARTICLES: HelpArticle[] = [
  // ---- Using the app -------------------------------------------------------
  {
    id: "how-offers-arrive",
    category: "app",
    related: ["accept-an-order", "install-app"],
  },
  // NO `media` on this one or on `delivery-photo` yet, and that is the only
  // thing missing from this page. Both want a real screenshot of the florist
  // PWA, which can only be taken from a signed-in session against a live
  // offer — a staff login plus a mock order (POST /api/dev/mock-order). Rather
  // than ship a mocked-up drawing of a screen that doesn't look like that, the
  // articles are text-only until someone captures the two shots. To add them:
  //
  //   1. Drop the PNGs at dashboard/public/help/offer.png and
  //      .../delivery-photo.png (phone-width, light theme, no real customer
  //      data on screen — the callouts are overlaid, so no text is baked in).
  //   2. Restore the `media` blocks below, adjusting x/y (percentages of the
  //      image) to sit on the right controls.
  //
  // The copy is already written and translated into all six locales
  // (ui.help.a.accept-an-order.callout1..3, ui.help.a.delivery-photo.callout1..2),
  // and lib/help/content.test.mjs checks every declared callout against it.
  //
  //   media: {
  //     kind: "image",
  //     src: "/help/offer.png",
  //     callouts: [{ n: 1, x: 50, y: 26 }, { n: 2, x: 50, y: 52 }, { n: 3, x: 50, y: 88 }],
  //   },
  {
    id: "accept-an-order",
    category: "app",
    related: ["what-do-i-make", "decline-an-offer", "getting-paid"],
  },
  {
    id: "what-do-i-make",
    category: "app",
    related: ["missing-flower", "delivery-photo"],
  },
  // See the note above `accept-an-order`. Pending shot:
  //   media: {
  //     kind: "image",
  //     src: "/help/delivery-photo.png",
  //     callouts: [{ n: 1, x: 50, y: 30 }, { n: 2, x: 50, y: 82 }],
  //   },
  {
    id: "delivery-photo",
    category: "app",
    related: ["photo-not-approved", "getting-paid"],
    // Default body ends "and release the rest of your payment", which is not
    // true for a shop already paid in full. The variant keeps the instruction
    // and re-points the reason: proof of delivery, not a payment gate.
    fullPayoutBody: true,
  },
  { id: "install-app", category: "app", related: ["how-offers-arrive"] },
  { id: "working-language", category: "app" },
  { id: "teammates", category: "app", appOnly: true },

  // ---- Getting paid --------------------------------------------------------
  {
    id: "getting-paid",
    category: "money",
    related: ["the-card", "photo-not-approved"],
    fullPayoutBody: true,
  },
  { id: "the-card", category: "money", related: ["getting-paid"] },
  { id: "photo-not-approved", category: "money", related: ["delivery-photo"] },

  // ---- Orders & flowers ----------------------------------------------------
  {
    id: "missing-flower",
    category: "orders",
    related: ["what-do-i-make", "contact-us"],
  },
  { id: "wrong-address", category: "orders", related: ["contact-us"] },
  { id: "cant-fulfil", category: "orders", related: ["decline-an-offer"] },
  { id: "decline-an-offer", category: "orders", related: ["cant-fulfil"] },
  { id: "delivery-timing", category: "orders", related: ["what-do-i-make"] },

  // ---- About us & support --------------------------------------------------
  { id: "contact-us", category: "about", related: ["wrong-address", "missing-flower"] },
  { id: "who-we-are", category: "about", related: ["what-it-costs"] },
  { id: "what-it-costs", category: "about", related: ["getting-paid"] },
  { id: "stop-offers", category: "about", related: ["contact-us"] },
];

/** The page's own furniture — everything a florist reads that isn't an answer,
 * in the order it appears. Lives here rather than in the editor component so
 * that `content.test.mjs` can prove every `ui.help.*` string in the catalog is
 * reachable from the backoffice editor: a heading added to HelpCenter but not
 * listed here would silently become the one line staff can't fix without a
 * deploy. `short` picks a single-line input over a textarea. */
export const HELP_CHROME_FIELDS: { key: string; label: string; short?: boolean }[] = [
  { key: "ui.help.title", label: "Page title", short: true },
  { key: "ui.help.relatedLead", label: "“Related” label", short: true },
  { key: "ui.help.backToOrder", label: "Back-to-order link (shown when a florist arrives from an offer)", short: true },
  { key: "ui.help.backNote", label: "Back-to-order reassurance line" },
  { key: "ui.help.joinTitle", label: "Join heading (public page only)", short: true },
  { key: "ui.help.joinBody", label: "Join body (public page only)" },
  { key: "ui.help.howItWorksLink", label: "Join button (public page only)", short: true },
];

/** Copy that is written and translated but not rendered yet, because the
 * screenshot it labels doesn't exist (see the note above `accept-an-order`).
 * Declared rather than merely commented out so `content.test.mjs` can tell
 * "parked, deliberately" apart from "a string staff can't edit" — and so that
 * restoring the `media` blocks fails the suite until this list is emptied. */
export const HELP_PENDING_KEYS: string[] = [
  "ui.help.a.accept-an-order.callout1",
  "ui.help.a.accept-an-order.callout2",
  "ui.help.a.accept-an-order.callout3",
  "ui.help.a.delivery-photo.callout1",
  "ui.help.a.delivery-photo.callout2",
];

/** Every catalog key this page renders, article copy and chrome alike. The
 * backoffice editor (app/(staff)/faq) must cover all of them. */
export function helpCopyKeys(): string[] {
  const keys = HELP_CHROME_FIELDS.map((f) => f.key);
  for (const c of HELP_CATEGORIES) keys.push(`ui.help.cat.${c}`);
  for (const a of HELP_ARTICLES) {
    keys.push(helpKey(a.id, "q"), helpKey(a.id, "body"));
    if (a.fullPayoutBody) keys.push(helpKey(a.id, "bodyFull"));
    if (a.media?.kind === "image") {
      for (const c of a.media.callouts ?? []) keys.push(helpKey(a.id, `callout${c.n}`));
    }
  }
  return keys;
}

/** Articles for one surface, grouped in category order. `variant: "public"`
 * drops `appOnly` answers — someone who has never signed in doesn't need to
 * read about inviting a teammate. */
export function helpSections(variant: "public" | "app"): { category: HelpCategoryId; articles: HelpArticle[] }[] {
  return HELP_CATEGORIES.map((category) => ({
    category,
    articles: HELP_ARTICLES.filter((a) => a.category === category && (variant === "app" || !a.appOnly)),
  })).filter((section) => section.articles.length > 0);
}

/** The article a `?a=` deep link points at, or null. Unknown ids are ignored
 * rather than 404'd: an old link from an email should still land on a working
 * page, just without a section pre-opened. */
export function findArticle(id: string | null | undefined): HelpArticle | null {
  if (!id) return null;
  return HELP_ARTICLES.find((a) => a.id === id) ?? null;
}

/** Catalog key for one of an article's strings. Single definition so the
 * renderer, the tests and the override editor can't disagree on the shape. */
export function helpKey(articleId: string, part: "q" | "body" | "bodyFull" | `callout${number}`): string {
  return `ui.help.a.${articleId}.${part}`;
}

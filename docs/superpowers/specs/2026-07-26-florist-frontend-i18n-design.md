# Florist frontend localization

## Goal

Extend the existing florist-email localization work ([[florist-localization]]) to the
florist-facing app UI, and close the gap that's kept the whole effort inert: nothing has
ever written `florists.locale`, so every florist resolves to English regardless of intent.
This pass:

1. Adds a self-service language picker so a florist can actually set their locale.
2. Builds the minimal plumbing to deliver that locale into the florist app's client
   components.
3. Localizes the authenticated florist app (home, orders, messages, history, balance,
   account, install) into English, French, Spanish, Italian, German — **with real
   translations**, not the "EN now, other locales later" scaffolding pattern the email
   catalog used.
4. Fills in the FR/ES/IT/DE email catalogs too (currently empty stubs), since a florist
   who sets a non-English locale should see it reflected in offer/issue emails as well as
   the app — same catalog, same effort, no reason to split it into a second pass.
5. Fixes the two known `TODO(locale)` spots (`FloristMessages.tsx`, `IssueThread.tsx`)
   that hardcode `issueLabel("en", ...)`.

This is additive to existing machinery (`lib/i18n`'s `t`/`tWithOursides`/`flattenKeys`,
`resolveFloristLocale`), not a redesign of it.

## Explicit non-goals for this pass

- **Pre-auth pages** (`/florist/login`, `/florist/join`, `/florist/invite/[token]`) stay
  English. They run before any `florists` row/locale is known; a browser-language-detection
  or manual-switcher story for them is a separate, later concern.
- **Customer-facing client emails** (assigned/on_the_way/delivered) stay English — an
  existing, separately-decided deferral (`clientComms.ts` hardcodes locale `"en"`), unrelated
  to this work.
- **No auto-derive of locale from florist country.** `resolveFloristLocale`'s existing TODO
  about defaulting from country stays open; this pass is self-service-only.
- **No CX/staff-facing surface changes.** `cxAttention.ts`'s `issueLabel("en", ...)` call is
  staff-facing and correctly stays English.
- **Translations are authored directly by Claude**, not run through a professional or
  native-speaker QA pass. Flagging this as a known limitation, not a silent gap: copy should
  read as fluent, idiomatic FR/ES/IT/DE, but hasn't been reviewed by a human speaker of those
  languages.

## Architecture

### Catalog: one new namespace, real translations, no engine changes

`dashboard/lib/i18n/messages/{en,fr,es,it,de}.ts` gain a new top-level `ui` branch
alongside the existing `email` and `issueLabel` branches, keyed by screen/component
(`ui.nav.orders`, `ui.account.changePassword.cta`, `ui.orderDetail....`, etc.). The FR/ES/
IT/DE files currently are one-line empty stubs (`export const fr: MessageTree = {}`) —
this pass replaces them with real, fully-populated trees for `ui.*` **and** backfills the
existing `email.*` / `issueLabel.*` keys they were never given.

None of `lib/i18n/index.ts` changes. `t()`, `tWithOverrides()`, `resolveLocale()`,
`flattenKeys()` are already generic over `MessageTree` shape and already fall back
per-key to EN — that fallback stays the safety net for any string this pass misses.

### Delivering locale to client components: `LocaleProvider`

New `dashboard/components/florist/LocaleProvider.tsx` — a plain React context, no internal
state:

```tsx
const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export function LocaleProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useT() {
  const locale = useContext(LocaleContext);
  return { locale, t: (key: string, vars?: Record<string, string | number>) => t(locale, key, vars) };
}
```

Deliberately holding no internal state matters: `app/florist/(app)/layout.tsx` already
does a server-side fetch to resolve `map.florist_id`; it will also select `locale` and
resolve it via the existing `resolveFloristLocale`, then wrap `<FloristShell>` in
`<LocaleProvider locale={locale}>`. Because the provider just mirrors its prop, a
`router.refresh()` after a locale change re-runs the server layout, produces a new
`locale` prop, and the whole client tree re-renders in the new language — no effect,
no client-side re-fetch required.

Every client component that has hardcoded copy switches to `const { t } = useT()` and
`t("ui.....")` in place of the literal. Server components (the `page.tsx` files under
`app/florist/(app)/`) that render mostly-static copy can call `resolveFloristLocale` +
`t()` directly if it's simpler than threading a prop — case-by-case, whichever reads
cleaner at that call site.

### Self-service picker

`FloristAccount.tsx` gets a `LanguageControl`, placed next to the existing `ThemeControl`
card and following the same segmented-control visual pattern (5 options instead of 3 —
may render as a compact dropdown instead of a segmented row if 5 buttons don't fit
comfortably; implementer's call, matching the design system). On change it posts to a new
route:

`POST /api/florist/locale` — mirrors `app/api/florist/invite/route.ts`'s shape exactly:
`currentFlorist()` for auth (401 if absent), validate `locale` is one of `LOCALES` (400
otherwise), `createServiceClient().from("florists").update({ locale }).eq("id",
me.floristId)`, `jsonError` on DB failure (500). On success, the client calls
`router.refresh()` (same as `TeamSection`'s invite/revoke/remove flows today).

### Fixing the two `TODO(locale)` spots

`FloristMessages.tsx:54-55` and `IssueThread.tsx:51-52` currently call
`issueLabel("en", type)`. Both switch to `const { locale } = useT()` and
`issueLabel(locale, type)`.

## Data flow

```
florists.locale (DB, self-service-written)
  → app/florist/(app)/layout.tsx (server: resolveFloristLocale)
  → <LocaleProvider locale={...}>
  → useT() in any client component
  → t()/tWithOverrides() catalog lookup (EN fallback per-key, unchanged)

Locale change:
  LanguageControl → POST /api/florist/locale → florists.locale updated
  → router.refresh() → layout re-fetches → LocaleProvider prop updates → re-render

Emails (mechanism unchanged, now actually exercised):
  resolveFloristLocale(florist) at send time (reachoutSend.ts, issueComms.ts)
  already reads florists.locale — today always NULL → always EN.
  Once a florist sets a language via this pass, offer/issue emails follow it.
```

## Error handling & fallbacks (mostly inherited, unchanged)

- Unset/unrecognized `florists.locale` still resolves to EN via `resolveLocale` — no new
  fallback logic needed.
- A `ui.*` key present in EN but not yet translated in FR/ES/IT/DE still falls back to EN
  per-key via `t()` — same safety net as the email catalog already relies on. In practice
  this pass aims for full FR/ES/IT/DE coverage of every `ui.*` key it introduces, so this
  fallback should rarely fire, but it's there if a string is missed.
- `POST /api/florist/locale`: 401 not signed in, 400 invalid/missing locale, 500 DB error —
  same shape as every other florist self-service route.

## Testing

- Extend `dashboard/lib/i18n/i18n.test.mjs` (pure, `node --test`-style, no framework) with
  assertions for a representative sample of new `ui.*` keys across all five locales, plus
  a case confirming an intentionally-unset key still falls back to EN.
- Manual, in a real browser: sign in as a florist, set language to each of FR/ES/IT/DE/EN
  in Account settings, confirm nav labels + at least one full page (e.g. Account, Orders)
  render in that language after refresh; confirm an order-issue label and a triggered
  offer/issue email reflect the chosen locale.

## Cross-cutting invariants preserved

- Catalog lookup never throws; a bad/typo'd key renders the key itself (existing
  behavior), keeping a bad call site visible rather than crashing a render.
- `MessageTree`'s "deliberately loose" typing (no exact key enumeration) is preserved —
  FR/ES/IT/DE can differ in exact leaf coverage from EN without type errors.
- `florists` RLS is untouched; the new API route uses the service-role client behind
  `currentFlorist()` auth, matching every other florist self-service mutation
  (`invite`, `team/remove`, `invite/revoke`).

## Follow-ups explicitly deferred (not in this pass)

- Pre-auth page localization (login/join/invite) and its locale-detection strategy.
- Native-speaker/professional review of the FR/ES/IT/DE copy this pass introduces.
- Auto-deriving `locale` from florist country data when unset.

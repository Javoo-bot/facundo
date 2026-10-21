# Settings page reorganisation — tabs

**Date:** 2026-08-05
**Scope:** pure reorganisation. No setting is added, removed, or given new
semantics; the `POST /api/settings` payload is byte-identical before and after.

## Problem

`dashboard/components/SettingsClient.tsx` is 721 lines in a single component —
all state, all handlers, all markup — rendered into a `max-w-lg` column. It is
one long scroll on a wide staff console.

The grouping is wrong, not merely long:

- **Email copy** (link to `/email-templates`) and **Email deliverability** (the
  test-send probe) sit *inside* the **External services** card, which is
  otherwise about Shopify write-back.
- **Test phone** is stranded near the bottom, far from Test mode / Test email at
  the top, though it belongs to the same concept and the SMS toggles reference it.
- **Automation mode** and **Test-shop matching** are bare `<div>`s below the
  Notifications block, though they are among the most consequential settings.
- **Statistics chat** is a one-field card tacked onto the end.
- Danger switches (test mode off, payments kill switch, Shopify write-back, live
  SMS) are scattered across four cards.

Three save semantics are also interleaved with no visual distinction: batch (the
Save button), immediate (allow-list add / remove / role change), and one-shot
actions (send test email, enable push).

## Design

### Seven tabs

| Tab | Contents |
|---|---|
| **General** | Test mode · Test email · Test phone · CX/ops inbox · Florist support email |
| **Matching** | Automation mode · Test-shop matching · Active order tags |
| **Offers** | The five offer windows · Late-accept buffer |
| **Payments** | Pause kill switch · Hold 30% delivery leg · Florist payout share |
| **Notifications** | Eight email toggles · two SMS toggles · CX alert push · Send test email · Email-templates link |
| **Integrations** | Shopify write-back · Statistics chat model |
| **Access** | Authorized emails |

Test phone rejoins Test mode and Test email in General. The test-send probe and
the templates link move out of External services into Notifications, where they
belong. Shopify write-back and the stats chat model — the two settings that talk
to a third party — become Integrations, inheriting the old card's intent.

Access is its own tab because it is the one section whose edits apply
immediately; separating it stops it from looking like it is covered by the Save
button.

### Layout

- The **test-mode banner stays pinned above the tab bar**: it reports global
  state, not a General-tab detail.
- The tab bar reuses the existing `.ds .segmented` tablist style
  (`app/design-system.css`), already used by `components/florist/FloristInbox.tsx`.
  `StaffShell` wraps staff routes in `.ds`, so it applies here.
- The container widens from `max-w-lg` to `max-w-3xl` to fit a tab row, and
  panels use a two-column grid at `sm` and up where the fields are short.
- **Active tab lives in the URL** (`?tab=notifications`) via `useSearchParams` +
  `router.replace(…, { scroll: false })`, so a tab is linkable and survives the
  `router.refresh()` that follows an allow-list edit. An unknown or absent
  `tab` falls back to `general`.
- The **Save bar is a persistent footer** below the panel rather than a button at
  the bottom of one tab, with a line noting it saves every tab. It is hidden on
  Access, whose changes are already immediate.

### Code structure

`SettingsClient.tsx` remains the single stateful owner — the save call, the
allow-list handlers, the push opt-in, the toast host — and renders the tab bar,
the active panel, and the save bar. Panels are presentational:

```
components/settings/
  types.ts               — SettingsForm, SetField, initialForm()
  fields.tsx             — Toggle, Field, Hint, PanelCard primitives
  SettingsTabs.tsx       — the tablist
  GeneralPanel.tsx
  MatchingPanel.tsx
  OffersPanel.tsx
  PaymentsPanel.tsx
  NotificationsPanel.tsx
  IntegrationsPanel.tsx
  AccessPanel.tsx
```

The 29 individual `useState` calls for saved fields collapse into one `form`
object with a typed `set(key, value)`, so a panel takes `{ form, set }` plus its
extras instead of up to 28 individual props. State stays hoisted in
`SettingsClient`, so switching tabs never loses an edit and one Save still writes
the whole payload. `save()` builds the same object literal as today, reading
`form.x` instead of a local — the payload is verified identical in the browser
network tab.

`activeOrderTagsText` stays a string on the form and is split/trimmed on save,
exactly as now. Non-settings state (saving, toasts, allow-list, push) stays as
individual `useState`.

### Fixed in passing

- The comment above `sms_recruiting_enabled` claims "No UI control (see the Phase
  2 comment below)", but a control exists at line 540. Stale — corrected.
- Four `(initial as { … } | null)?.x` casts are stale: `AppSettings` already
  declares `default_payout_percent`, `shopify_writeback_enabled`,
  `workflow_mode`, and `test_shop_matching`. They become plain property reads.
- Two cards gain a red tint they did not have before, so that *every* dangerous
  state is styled the same way rather than only some of them — the scattering
  the Problem section above complains about. Test-shop matching set to `only`
  tints the Matching card; either SMS toggle on tints the SMS card. Payments-
  paused and Shopify write-back already did this. No value, default, or payload
  field changes — the per-label red text is preserved exactly as it was.

### Not touched

`lib/lifecycle.ts` references `app_settings.*` columns but never
`SettingsClient.tsx` as a `code` ref, and no order-loop behaviour changes here,
so it needs no update (noted per CLAUDE.md's standing rule).

## Verification

1. `npm run build` — types and a clean production build.
2. Browser (chrome-devtools-mcp): visit all seven tabs; confirm the `POST
   /api/settings` request body is byte-identical to the pre-change one; confirm
   allow-list add / role change / remove still round-trip and keep you on Access;
   confirm `?tab=` deep-links and that an unknown value falls back to General.

# Message editor — design

**Date:** 2026-08-05
**Status:** approved, implementing

A live editor for every message Facundo sends: pick a message, see it rendered
as the recipient will, click a block to edit it, watch the preview update as you
type, then publish.

Replaces the current `/email-templates` screen, whose preview opens in a new tab,
covers only the offer email, and reflects *saved* overrides — so it can never
show you an edit you haven't already shipped.

## Why this is more than a UI

Only the offer email has a pure, renderable content builder
(`lib/offerEmailContent.ts`). Every other message builds its HTML *inside* a send
function that also does database I/O, so there is nothing a preview can call.
That is the real work, and it is worth doing on its own merits: it extends the
no-drift property the offer email already has ("the preview can never drift from
what actually gets sent") to everything we send.

## Decisions

| Decision | Choice |
|---|---|
| Editing model | Click a block in the preview → focuses that field in a side panel. Not contenteditable inside rendered HTML. |
| Coverage | Every message: 12 emails, 2 SMS, push. |
| Save model | Draft → publish. `message_overrides` stays the live table; drafts live separately. |
| Translations | Editing EN auto-drafts the other five via OpenRouter, into the same draft flow, behind hard guards. |
| Scope of the editor | Messages only. ~450 `ui.*` keys are florist-PWA strings with no email to preview; they stay on a flat key list. |

## Architecture

### 1. Tagging editable blocks without touching any builder

The preview must know which catalog key produced which piece of rendered HTML.
Threading keys through every render call would mean editing every builder.

Instead: `previewOverrides(base, locale)` returns a **Proxy** over the overrides
map that answers every key with its resolved value wrapped in control-character
sentinels — `keyvalue`. Because `tWithOverrides` already
prefers `overrides[key]` and interpolates it, every builder emits tagged output
with **zero changes**, and `{placeholder}` interpolation still happens normally.

After rendering, `tagPreviewHtml()` converts sentinels in text position to
`<span data-fc-key="…">`, and leaves sentinels inside HTML attributes as bare
values (a catalog string used in an `href` must not become a span).
`stripSentinels()` cleans the subject and plain-text parts.

**Safety:** sentinels exist only when preview mode is explicitly requested, so a
real send cannot carry one. A test asserts that real send output contains
neither a sentinel nor `data-fc-key`.

### 2. Pure builders + registry

Extract `buildXContent(locale, overrides, vars) → { subject, html, bodyText }`
(no I/O) from `issueComms` (replied + resolved), `floristMagicEmail`,
`cxAlerts`, `clientComms` and the test-email route. Each send function then
calls its builder, so send and preview share one code path.

`lib/messages/registry.ts` lists every message: `id`, `label`, `audience`,
`channel`, the catalog keys it uses, sample vars, and a `render` function. Pure,
no I/O — unit-testable and the single source of truth for what the editor shows.

### 3. Draft / publish

New table `message_override_drafts (locale, key, value, updated_at, updated_by)`,
PK `(locale, key)`. `message_overrides` is untouched — **the send path does not
change at all**.

- Preview layers request-body edits over published overrides, so it is live as
  you type with nothing saved.
- Publish upserts drafts into `message_overrides` and deletes them.
- Discard deletes drafts.

### 4. Editor UI

Left: message list. Centre: rendered message in a sandboxed iframe (`srcdoc`).
Right: field panel for the focused key. A small injected script posts the
clicked `data-fc-key` to the parent, which focuses that field.

### 5. Auto-drafted translations

Editing an EN value drafts the other five through OpenRouter
(`lib/recruitingPersonalise.ts`'s integration). Every candidate must pass, or no
draft is created and the reason is shown:

- **Placeholders:** every `{var}` in the source must survive (`missingVars`).
- **SMS:** must stay GSM-7 and within the 3-segment budget (`isGsm7`,
  `smsSegments`) — an accented translation silently doubles the bill.
- **No em dashes** (house rule, and U+2014 is outside GSM-7).

## Testing

- Pure builders: subject/html/text assertions per message.
- Sentinel → span conversion, including the in-attribute case.
- Guard: real send output contains no sentinel and no `data-fc-key`.
- Publish/discard as pure functions over a fake client.
- Translation guards: placeholder loss, non-GSM-7, over-budget, em dash.

## Phases

Each is shippable alone.

1. Pure builders + registry + preview API. No UI change. Every message becomes
   previewable and no send path can drift.
2. Draft/publish storage + the split-view editor.
3. Auto-drafted translations.

## Out of scope

Rich-text/WYSIWYG formatting (these are template strings, not documents),
per-florist message customisation, and scheduling. The `ui.*` catalog keeps its
flat key list.

---

# Addendum: blocks, rich text, variables (requested 2026-08-05)

Three asks that together change the data model, so they are recorded here
before any of them is built.

## What changes

Today a message is a **fixed builder sequence** over **flat, plain-text**
catalog strings. Editing changes a string; it cannot add, remove or reorder
anything, and everything is `escapeHtml`'d on the way out.

All three asks need the body to become **data**:

1. **Add/remove segments** — the body becomes an ordered list of blocks.
2. **Inline rich text** — a block's content becomes a restricted HTML subset,
   not plain text.
3. **Insert variables** — the editor needs to know which `{vars}` are in scope
   for the message being edited.

## Design

**Blocks as an opt-in override.** A new key per message, `<message>.blocks`,
holding a JSON array: `[{ "type": "paragraph", "html": "..." }, ...]`. The
builder renders from it when present and falls back to today's fixed sequence
when absent. Additive: every existing send is byte-identical until someone
edits a message in the new way.

**Rich text must be sanitised, not trusted.** This is the one part that is a
security question rather than a feature: staff-authored HTML would be injected
into email we send to third parties. An allowlist — `b/strong`, `i/em`, `u`,
`a[href]` (http/https/mailto only), `br` — applied on the way IN (on save) and
again on the way OUT (at render), with everything else stripped. The
plain-text alternative is derived by stripping tags, so it can never carry
markup. No `style`, no `script`, no `on*` attributes, no raw URLs in `href`
that aren't scheme-checked.

**Variables come from the registry.** Each `MessageDef` gains a `variables`
list: name, an example value, and one line of what it is (`{city}` — "the
delivery city, from the order"). The editor offers only that message's own
variables, and the existing `missingVars` guard already catches an edit that
drops one the send site requires.

## Order to build

1. Sanitiser + variable catalog (pure, testable, no UI) — needed by both of
   the others, and the security-critical piece.
2. Block model in the builder + `<message>.blocks` override, behind the
   fallback.
3. Editor UI: contenteditable inside the preview iframe, a small toolbar
   (bold / italic / underline / link), block add/remove/reorder, and a
   variable picker.

## Not started

None of the above is implemented. The editor as merged edits flat strings.

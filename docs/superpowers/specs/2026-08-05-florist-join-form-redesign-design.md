# Florist join-form redesign

**Date:** 2026-08-05
**Surface:** `dashboard/app/florist/accept/[token]` + `components/florist/FloristAcceptForm.tsx`
**Status:** approved, implementing

The public "join our network" form is the first thing a cold-recruited florist ever
sees of the product. Today it is four bare inputs, a seven-row grid of empty time
boxes, and a small button — correct, but it reads like a data-entry screen, not a
welcome. This redesign makes it warm, cuts the number of decisions to almost none,
and captures the one field the order loop actually depends on and currently guesses
at: a mobile number we can text.

Not to be confused with `app/florist/join` — that is teammate-invite redemption and
is untouched.

## What changes

1. A time-of-day greeting and rewritten welcome copy.
2. Address becomes a Google-Places-verified autocomplete that also fills lat/lng.
3. Opening hours: a weekday block with per-day override, pre-filled rather than blank.
4. A new mobile-number field, required, validated to E.164, preferred for SMS.
5. A "tell us about your shop" textarea into a new `shop_story` column.
6. A full-width green submit button.

## 1. Greeting and welcome copy

### Which clock

The greeting is server-rendered from the **shop's own timezone**, derived from the
stored coordinates by `lib/floristTime.ts::floristTimeZone` (tz-lookup, offline, no
API call). Every florist reached by the recruiting email came from a Maps ingest, so
coordinates are present in the overwhelming majority of cases, and rendering on the
server means no hydration mismatch and no flash of the wrong greeting.

When coordinates are missing, `floristTimeZone` returns null — the established
"degrade rather than guess" contract of that module. The page then renders a neutral
greeting and a small client effect replaces it from the browser clock after mount.
The correction is a text swap on one line; it never moves layout.

### Buckets

New pure module `lib/floristGreeting.ts`:

| Local hour | Key |
|---|---|
| 05:00–11:59 | `morning` |
| 12:00–17:59 | `afternoon` |
| 18:00–21:59 | `evening` |
| 22:00–04:59 | `night` |

`night` is a separate bucket rather than folded into `evening` because English
"Good night" is a farewell — that bucket resolves to a neutral "Hello" instead.
Other locales pick whatever is idiomatic for someone arriving at 01:00.

The function takes the timezone and a `nowMs` (injectable, per the repo's
no-`Date.now()`-inside-the-module convention) and returns the key, or null when the
timezone is null or unknown to `Intl`.

### Named greeting

When `florists.owner_name` is set, the greeting names them: "Good evening, Maria".
Otherwise it stands alone. The shop name is deliberately *not* used as a fallback —
"Good evening, Flors Girona" reads like a mail-merge failure.

### Copy (English; five other locales follow)

Replaces `ui.accept.title` and `ui.accept.subtitle`.

```
Good evening, Maria

We're so glad you're here.

Facundo sends flower orders from customers all over the world to local
florists like you. You make the bouquet — we handle the customer, and we
pay you before you start.

Below is what we already know about your shop. Check it over, tell us when
you're open, and you're in. It takes about a minute.
```

## 2. Address: Google Places verified autocomplete

### Key handling

`GOOGLE_MAPS_API_KEY` is **server-only** — never `NEXT_PUBLIC_`, never sent to the
browser. The account-wide Maps Platform key, with the Places API enabled on it,
rather than a Places-specific one: that is what the project already provisions.
Restrict it by API in the GCP console, **not** by HTTP referrer — these calls
originate from our server, so there is no referrer to check.

### Proxy routes

Two new route handlers, both `runtime = "nodejs"`, both public in the same sense the
accept route is public:

- `POST /api/places/autocomplete` — `{ token, input, sessionToken }` → `{ suggestions: [{ placeId, primary, secondary }] }`
- `POST /api/places/details` — `{ token, placeId, sessionToken }` → `{ address, lat, lng }`

**Both are gated on the join token.** Each request looks the token up in `florists`
and refuses unless it resolves to a florist who has not joined and whose token has
not expired — the same credential model as `/api/florist/accept`. Without that gate
an open proxy to a billable API sits on the public internet. Input is capped at 200
characters and requests shorter than 3 characters short-circuit to an empty list
without calling Google.

Upstream is Places API (New): `POST https://places.googleapis.com/v1/places:autocomplete`
and `GET https://places.googleapis.com/v1/places/{placeId}` with a `X-Goog-FieldMask`
limited to `formattedAddress,location` so we are not billed for fields we discard.

Failures degrade to an empty suggestion list, never an error banner. A florist must
always be able to type an address by hand.

### Client component

`components/florist/AddressAutocomplete.tsx`:

- 250 ms debounce on input.
- A Google **session token** (`crypto.randomUUID()`) minted on first keystroke of an
  editing session and retired after the details call — this is how Places sessions
  are billed, and skipping it multiplies the cost per address.
- ARIA combobox/listbox with `aria-activedescendant`; ↑/↓ to move, Enter to pick,
  Escape to dismiss.
- Picking a suggestion sets the text, stores `lat`/`lng`, and shows a green
  "Verified with Google Maps ✓" line beneath the field.
- Typing after a pick clears the verification and the coordinates. We never keep
  coordinates that no longer correspond to the text on screen.
- Free text submits fine. A soft hint ("pick from the list so we can find you on
  the map") appears when unverified, but nothing blocks.

### What we write

`address`, and `lat`/`lng` **only when a suggestion was picked**. Two deliberate
omissions:

- **`place_id` is never written.** It is the Apify dedup key under
  `unique (city_id, place_id)`; overwriting it with a Google Places ID risks
  colliding with another row and breaks ingest idempotency.
- **`lat`/`lng` are omitted from the update, not nulled,** when unverified —
  the same "absent from the update ≠ null it out" convention `buildAcceptUpdate`
  already uses for `business_hours`. A florist typing their address by hand must not
  wipe the coordinates the ingest already found.

## 3. Opening hours

### Shape

```
  Open Mon–Fri     [09:00] – [19:00]
  Saturday    (●━) [09:00] – [19:00]
  Sunday      (━○) Closed

  ▸ Set days individually
```

One weekday row for the common case, Saturday and Sunday broken out because they are
where florists actually differ, and a disclosure that expands to the full seven-row
per-day grid for anyone who needs it. The stored shape is unchanged — the existing
per-day `BusinessHours` map — so `lib/floristAccept.ts`'s server validator needs no
changes at all.

### Defaults

Mon–Sat `09:00–19:00`, Sunday closed. Applied whenever we have no usable stored
hours, so the florist's most likely action is "read it, agree, move on".

### Prefill actually working

New pure module `lib/businessHours.ts`.

Today `fromBusinessHours` only understands per-day keys and silently drops anything
else. Real staff-entered data uses **grouped keys** — `{"mon_fri":"09:00-20:00"}`,
see `supabase/seed/2026-07-13-florist-demo.sql` and the `dayLabel` note in
`components/florist/floristOps.ts`. So for exactly the florists whose hours we
already know, the grid renders blank. The new module expands grouped keys
(`mon_fri`, `mon_sat`, `mon_sun`, `sat_sun`, and the general `<day>_<day>` range)
into per-day rows before they reach the UI.

It also exposes `weekdaysAgree(rows)`. When prefilled weekday hours disagree, the
per-day grid opens expanded rather than hiding the difference behind a summary row
that would be a lie.

### Control

The per-day "Closed" checkbox becomes an on/off switch — a new `.ds .switch` token
in `design-system.css` (not a one-off), which dims the row and disables its time
inputs when off. Times are `<input type="time">` as today; the platform control is
better on mobile than anything we would build.

## 4. Mobile number for order alerts

### Storage

Migration adds `florists.phone_mobile text`.
`lib/phone.ts::resolveFloristSmsPhone` becomes `phone_mobile → phone_web → phone_maps`.

Today the accept form writes whatever is typed in "Phone" into `phone_web`, which is
the same column SMS texts — so the form already doubles as SMS capture, silently and
without validation. Splitting the field makes the intent explicit on both sides: the
florist knows which number gets the alerts, and staff reading the row can tell a
confirmed mobile from a scraped shop line.

### Validation

**Required.** Server-side it must parse to E.164 via `libphonenumber-js` using the
florist's city country as the default region (`countryToRegion`, already in
`lib/phone.ts`). A number we can never text is worse than a blocked submit — it
looks like a working channel and silently isn't. Stored in E.164, normalised, so
`resolveFloristSmsPhone` is a passthrough for it.

The client mirrors the required check for a fast error; the server is authoritative.

### Copy

```
Mobile number for order alerts

We'll message you by SMS or WhatsApp every time an order comes up in your
area. That's it — no marketing, ever.
```

**Known gap, accepted:** there is no WhatsApp integration. Order messages go out over
Telnyx SMS only (`lib/sms.ts`). A florist who reads this and watches WhatsApp will
miss offers until WhatsApp ships. This wording was chosen deliberately with that
tradeoff on the table.

## 5. Shop story

Migration adds `florists.shop_story text`. Distinct from `shop_highlight`, which
stays exactly as it is — an LLM-researched detail used to personalise outreach
drafts. Two provenances, two columns, per the repo's rule that enrichment fields stay
honest about where they came from.

Textarea, 5 rows, 600-character cap with a counter that appears past 400. Trimmed
server-side; empty submits as null.

```
Tell us what makes your shop yours

Your style, what you're known for, how long you've been on that street,
the flowers you love working with. Our customers see this.
```

Rendered on the staff florist card beside the researched highlight.

## 6. Submit button

New `.ds .btn-lg` and `.ds .btn-block` in `design-system.css`: full width, 52 px tall,
`1rem`/600, `justify-content: center`. Green comes from the existing `--accent`
(`#1F7A55` light, `#52BD8A` dark) — no new colour token. Not sticky; that is a
separate change if we want it.

## 7. Order-lifecycle map

`lib/lifecycle.ts` carries a branch for "candidate florist has no parseable phone —
both `phone_web` and `phone_maps` missing or unnormalisable". Capturing a validated
E.164 mobile at join time is a genuine partial handling for it (it closes the gap for
every florist who self-registers, not for cold prospects), so that branch's
`handling` text is updated in the same change.

## 8. Testing

`node --test`, the existing lightweight convention. New files registered in
`dashboard/package.json`'s `test` script.

- **`lib/businessHours.test.mjs`** (new) — grouped-key expansion (`mon_fri`,
  `sat_sun`, arbitrary ranges), unknown keys ignored, `closed` preserved, defaults
  when input is null/empty, `weekdaysAgree` true/false cases.
- **`lib/floristGreeting.test.mjs`** (new) — each bucket boundary (04:59/05:00,
  11:59/12:00, 17:59/18:00, 21:59/22:00), null timezone, timezone unknown to `Intl`,
  and a real cross-timezone case (same instant, different bucket in Madrid vs Tokyo).
- **`lib/floristAccept.test.mjs`** (extend) — mobile required, mobile rejected when
  unparseable, mobile normalised to E.164, `shop_story` trimmed / over-length
  rejected / empty → null, lat/lng range and finiteness, `buildAcceptUpdate` omits
  lat/lng when unverified and omits `business_hours` when null.
- **`lib/phone.test.mjs`** (extend) — `phone_mobile` wins over `phone_web`; falls
  through when `phone_mobile` is unparseable.
- **Places proxy** — token gate rejects an unknown/expired/already-joined token;
  short input short-circuits without an upstream call.

Manual verification in a real browser (chrome-devtools-mcp), per CLAUDE.md: load a
live join token, confirm the greeting matches the shop's timezone, pick an address
and see coordinates land, toggle Sunday, submit, and confirm the row in Supabase.

## Non-goals

- No sticky mobile submit bar.
- No WhatsApp send path (copy promises it; delivery does not exist yet).
- No editing `shop_story` or the mobile from the florist account page — this change
  is the join form only.
- No map preview of the picked address.

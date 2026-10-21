# Our own URL shortener

**Date:** 2026-08-05
**Status:** approved, ready for implementation

## Why

Not "cleaner links" — money. Measured on a real offer SMS:

| | chars |
|---|---|
| magic link (`/florist/m/<uuid>`) | 77 |
| unsubscribe link (`/florist/unsubscribe/<uuid>?locale=es&channel=sms`) | 109 |
| **the two URLs** | **186** |

Measured against the CURRENT offer copy (the 2026-08-05 "70/30 split" rewrite),
every locale bills as **3 segments** today: en 372, es 385, fr 402, de 384,
it 395 characters. Replacing both links with 10-char short links brings that to
**2 segments**: en 258, es 271, fr 288, de 270, it 281.

**One segment is not reachable and is not the goal.** The copy alone is ~216
characters before any URL, so no link shortening can reach the 160-character
single-segment budget. The win is 3 → 2 segments — roughly **a third off every
offer SMS** — not a halving.

An earlier draft of this spec claimed 2 → 1 based on the PREVIOUS, shorter offer
copy. That measurement was stale; these numbers are from the current code.

Two links, both credential-bearing, both unreadable to a human — the ideal case
for shortening.

## Decisions

| decision | value | why |
|---|---|---|
| host | `bo.fc.example.net` | No DNS work needed; already routes to this Worker. |
| mount point | **root** — `bo.fc.example.net/<code>` | Two characters cheaper than a `/s/` prefix, which is headroom against the segment budget. |
| code length | **10** base62 chars | ~59 bits. Worst locale `fr` at 288 of the 306-char 2-segment budget — 18 to spare. |
| scope | **SMS only** | Where the money is. Email keeps full URLs so recipients can hover-preview a real destination. |
| tracking | hit count + first/last timestamp | Distinguishes "never opened" from "opened, ignored". No IP, UA, or per-click rows. |

### Segment budget (measured, all five locales)

`https://bo.fc.example.net/` + 10 chars = 36-char URLs, ×2 = 72 characters of
link. GSM-7 multipart allows 153 characters per segment, so the 2-segment budget
is 306. Worst case is French at **288 — 18 characters to spare.**

The offer copy has already been rewritten twice, so that headroom is the point
of root-mounting rather than using a `/s/` prefix: the prefix version leaves only
4 characters, which a modest copy edit would erase. A test pins the budget
either way (see Testing) — if a future edit pushes any locale past 306 the test
fails rather than the bill rising quietly. The failure mode is a return to
today's 3 segments, not something worse than the status quo.

## Architecture

### `short_links`

| column | notes |
|---|---|
| `code` | PK, 10-char base62. The credential. |
| `target_url` | absolute URL to redirect to |
| `kind` | `magic` / `unsubscribe` — what it points at |
| `florist_id`, `assignment_id` | nullable, for attribution |
| `created_at` | |
| `hit_count`, `first_hit_at`, `last_hit_at` | |

**No `expires_at`.** The target owns its own lifetime: a magic token still
expires after 30 days and lands on the existing "link expired → sign in"
fallback. A short link outliving its target is harmless; one expiring early
would break a working link.

### Code generation — `lib/shortLink.ts`

- `crypto.randomBytes`, **never `Math.random`** — this value is a login credential.
- Rejection sampling, not modulo: `256 % 62 != 0`, so naive modulo biases the
  first 8 characters of the alphabet.
- Retry on unique-violation (bounded), so a collision is a retry, not a 500.
- **Reject any code equal to a staff route segment.** Root-mounting means a code
  sits at the same level as every staff page, and `operations` and `statistics`
  are *exactly* 10 base62 characters. Next resolves static segments before
  dynamic ones, so the staff pages are safe — but the converse bites: a generated
  code of `statistics` would be shadowed by that page and the link permanently
  dead. Checked against the live `STAFF_SEGMENTS` set, so a staff route added
  later is covered automatically. ~2/62¹⁰ per attempt; the guard costs one set
  lookup.

### Redirect — `app/[code]/route.ts`

Root-mounted, so a link is `bo.fc.example.net/<code>`. Staff routes still win
(static beats dynamic in Next), and the generation-time denylist above covers the
converse. Shape is validated here too rather than trusted from the router: the
code must match `^[0-9A-Za-z]{10}$`, and anything else calls `notFound()` before
a database round trip.

Behaviour:

- `302` (never `301`) with `Cache-Control: no-store`. A cached permanent redirect
  would pin a credential into shared proxy caches.
- Unknown code → the same `notFound()` as a malformed one. No timing or body
  difference between "no such code" and "not a code".
- Hit counting is **awaited**, not fire-and-forget. A floating promise does not
  survive on Workers: the isolate is torn down when the response returns, which
  cancels it. Found in production — a perfect 302 with `hit_count` stuck at 0,
  while the same code counted correctly under `next dev` because Node keeps the
  process alive. `ctx.waitUntil` did not rescue it either. One extra round trip
  on a redirect is the price of telemetry that is actually true; any failure is
  reported on an `X-Hit-Count-Error` header rather than swallowed, because a
  counter that silently does nothing is worse than one that says why.

### Host gating

**No `wrangler.jsonc` or middleware change is required.** Confirmed against the
branch that actually serves production: `v0.2`'s `wrangler.jsonc` carries
`{ "pattern": "bo.fc.example.net/*", "zone_name": "example.org" }`, so every path
on that host already routes to this Worker. (`main`'s `wrangler.jsonc` is the
*staging* worker and lists only `facundo-staging.example.org` — the production
hostnames live on `v0.2`, so short links resolve once this reaches `v0.2`, same
as any other change.)

`decideHostRoute`'s BACKOFFICE_HOST branch blocks only `/florist/**`, and a
10-char code is not that, so it passes through untouched.

### Call sites

Only the two URLs handed to `buildOfferSmsContent`, in `lib/reachoutSend.ts` and
`lib/reachoutRenotify.ts`.

Email is untouched, which preserves an existing guarantee: `resolveOfferVars`
mints **one** magic token per send and both channels use it. SMS now carries a
shortened *presentation* of that same URL, so the two channels still cannot
drift onto different tokens.

## Rate limiting — an explicit gap

10 characters is ~59 bits (62¹⁰ ≈ 8.4×10¹⁷). At a sustained 1,000 guesses/sec,
sweeping any meaningful fraction takes far longer than the 30-day token lifetime,
and with only thousands of live codes the chance a single guess hits a valid one
is ~10⁻¹⁵. Entropy is not the weak point.

Sustained hammering is still worth blocking, and real rate limiting in a
stateless Worker needs KV or a Durable Object — infrastructure this POC does not
have and which this change will not smuggle in.

**Required manual setup:** a Cloudflare rate-limiting rule on
`bo.fc.example.net`. This is dashboard configuration, not code, and is
deliberately recorded here as a gap rather than implied to be handled.

## Testing

Pure, alias-free `node --test`, per the repo convention:

- **base62 generation** — alphabet correctness, exact length, and no modulo bias
  (a chi-square-ish distribution check over many samples).
- **staff-segment collision guard** — asserts `operations` and `statistics` are
  still the 10-char staff segments, that the generator rejects them, and that
  every staff segment still routes to the console. Fails loudly when someone adds
  a colliding staff route, which is exactly when it matters.
- **route-shape guard** — `^[0-9A-Za-z]{10}$` accepts a real code and rejects
  9- and 11-character strings, empty input, and anything with a `/` or `.`.
- **segment budget** — the offer SMS stays at **two** segments in all five
  locales with a 10-char short link. This is the regression guard for the thin
  French margin, and the reason the whole feature pays for itself.

## Verification

Per `CLAUDE.md`, no phase is claimed working without being run:

- `tsc`, lint, `next build`, full `node --test` suite.
- A real short link minted against the database, fetched over HTTPS, asserted to
  `302` to the right target and to increment `hit_count`.
- A real offer SMS rendered end to end and asserted at two segments (down from three).

## Order-lifecycle map

`dashboard/lib/lifecycle.ts` is updated in the same change: the `reachout` stage's
SMS handling gains a note that offer SMS links are shortened, and why (segment
cost), so the cost model is visible next to the code that spends it.

## Follow-up: move off the staff host

Worth doing eventually, and deliberately recorded rather than left implicit.
`bo.fc.example.net` is the **staff console**, and these links go to **florists**:

1. **Optics** — a florist receives a text pointing at a domain they don't
   recognise and that is not for them.
2. **The real risk** — if the backoffice is ever restricted by IP or VPN (a
   normal hardening step), every florist short link ever sent breaks silently.
   Nothing in this design would warn you; the links would simply stop working.

This was accepted knowingly: root-mounting on `bo` gives 18 characters of
headroom against the segment budget, versus 4 for `florist.fc.example.net/s/`,
and the copy has already been rewritten twice.

The base URL comes from `BACKOFFICE_BASE`, so moving to a dedicated short domain
(`f.fc.example.net`, or a short apex) is one value change, and **already-sent
links keep resolving** — the code is the key and existing rows keep theirs. A
dedicated domain would also restore the headroom lost to a path prefix, making
the root-mount collision guard unnecessary.

## Out of scope

- Shortening links in email (florist or client).
- Per-click analytics: IP, user-agent, referrer, per-click rows.
- A staff UI for browsing or manually creating short links.
- Custom/vanity codes.

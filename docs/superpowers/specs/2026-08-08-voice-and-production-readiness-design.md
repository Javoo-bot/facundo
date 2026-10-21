# Voice agent + production readiness — MVP design

**Status:** proposed, not built. Written 2026-08-08.

## Context

The florist communications program is built and verified: a multi-touch recruiting
funnel, cold offers, reactivation for existing partners, an inbound AI CX persona,
and the numbers behind all of it. Everything ships dark behind settings flags.

Two things remain: the deferred **voice layer** (Telnyx + ElevenLabs), and the work
to take what exists from "verified in a worktree" to "running in production".

A disclosure position has now been set: **all agents disclose they are AI — in
writing when asked, by voice voluntarily.** That settles the `x-persona-is-not-real`
branch that has been open since the persona was introduced.

---

## 1. The disclosure decision needs one revision

**EU AI Act Article 50 transparency obligations became applicable on 2 August 2026
— six days ago.** Every market this funnel targets (ES, FR, IT, DE, PT) is in scope.

The obligation: providers of AI systems that *interact directly with natural
persons* — explicitly including chatbots, AI assistants and AI agents — must ensure
people are informed they are interacting with an AI system, **unless that is obvious
from the context**. Penalties run to €15M or 3% of worldwide turnover.

"Disclose only when asked" does not satisfy "must ensure that users are informed".

### What this does and does not cover

The distinction matters, and it means most of the program is unaffected:

| Surface | AI system interacting with a person? | Disclosure needed |
|---|---|---|
| Funnel touches `t1`–`r2`, `co1/co2`, `ra1`–`rd2` | **No.** Deterministic catalog copy, translated by hand. This is a mail merge, not an AI interaction. | No |
| Persona *signature* on those touches | No — the copy is not AI-generated | No |
| **AI CX replies to inbound** (`lib/cxAgent.ts`) | **Yes.** A model reads their message and writes back. | **Yes** |
| **Voice agent** | **Yes** | **Yes** — and already the plan |

So the change is narrow: it applies to AI-*written* replies, not to the funnel.

### Why the "obvious from context" exemption is unavailable to us

An AI reply here is signed by an invented human with a name, a role title and a
personal reply-to address. That is not merely "not obvious" — it actively points
the reader the other way. The persona is precisely what removes the exemption.

### Recommendation

**A one-line disclosure on the first AI-written reply in each thread.** Not every
message — once per conversation, on the turn where a model first answers. Something
plain, in the catalog, translated like everything else:

> *Replies to this address are drafted by an automated assistant. Say the word and
> a colleague will take over.*

Cost: one line, on the message where the florist has already engaged enough to
reply. It also makes the existing `wants_human` path coherent — they can act on it.

**If you'd rather keep "only when asked":** that is your call to make and I will
build it, but it should be a decision taken with the above in front of you rather
than by default, and I'd want it recorded in `lib/lifecycle.ts` as an accepted risk
rather than left looking like an oversight.

### Written disclosure, on request — required either way

Right now, "are you a real person?" maps to intent `wants_human`, which escalates
and sends nothing. The florist gets silence, then a human — which is evasive.

**Change:** a new intent `asked_if_ai` that is *answerable*, not escalated:

- `lib/cxAgent.ts` — add the intent; the prompt's rule inverts from "do not claim
  to be a person, escalate" to "say plainly that you are an automated assistant,
  and offer a colleague".
- `lib/cxAgentGuard.ts` — `asked_if_ai` is **not** in `ESCALATE_INTENTS`, but its
  reply must match an approved disclosure string (a new guard check, so the model
  cannot improvise its way around the question).
- Catalog: `email.disclosure.whenAsked` + `email.disclosure.proactive`, six locales.

Tests: asked-if-AI answers rather than escalating; the answer is the approved
string; every other escalation category is unchanged.

---

## 2. Voice MVP

Verified provider contract (tested against the live API for the SIP side; the
number/agent provisioning is documented, not yet exercised):

- ElevenLabs Agents connects to Telnyx over **SIP trunking** — a Telnyx SIP
  connection of type **FQDN** pointed at `sip.rtc.elevenlabs.io`.
- **One trunk carries both directions.** Inbound: a DID routes into the trunk and
  the agent answers. Outbound: the agent places calls over the same trunk.

Schema already exists and is applied: `phone_numbers`, `voice_calls`
(`2026-08-08-voice-numbers.sql`), and `outreach_personas.phone_e164`.

### 2.1 Number inventory — `/settings` → Numbers

- `lib/telnyxNumbers.ts` — search / order / release against the Telnyx Number
  Search and Order APIs. Thin client; every call logged to `external_ops` like
  every other provider call in this codebase.
- `lib/numberRouting.ts` (**pure, tested**) — `resolveNumberForCity(cityId, country, numbers)`.
  One mapping read by both directions, so a florist is never called from one
  "local" number and asked to call back on another.
- Admin UI: search by country/area, buy, assign to a city + persona, release.
  Shows monthly cost per number, because this is the first part of the program
  with a standing bill.

**Procurement is the long pole, not the code.** Telnyx requires a local in-country
address to activate a local DID — a Spanish number needs a Spanish address, and the
same applies per market. That is a real lead time and a real legal-entity question
per country; it needs starting before the code is ready, not after.

### 2.2 Inbound — a florist calls the number back

1. Telnyx DID → SIP connection → ElevenLabs agent answers.
2. **The agent opens with the disclosure, unprompted**, then offers a human.
3. It may assert only the `APPROVED_FACTS` set already used by the CX agent, and
   the same catalog-rendered pitch. Same discipline, same source of truth.
4. Hard hand-off on the same categories the written guard escalates: money beyond
   70/30, contracts, complaints, or any request for a person.
5. `voice_calls` records the call with `disclosure_played` — recorded as a fact,
   not assumed from configuration.

### 2.3 Outbound — a late funnel touch

A `channels: ["voice"]` step in `lib/sequences/definitions.ts`, gated on its own
settings flag, placing a call from the DID matching the florist's city.

**Constraints that belong in the scheduler, not in prose:**

- **Local calling hours.** Cold-calling hours are restricted in several of these
  markets. The step must resolve the florist's timezone (`lib/floristTime.ts`
  already does this for offer deadlines) and refuse outside a configured window.
- **One call, ever, per prospect** for the MVP. A funnel that phones twice is a
  different product and a different complaint profile.
- Only to prospects who **engaged** — a cold call to someone who never opened an
  email is the highest-risk, lowest-yield message in the whole program.

### 2.4 Recording and transcripts — needs a decision before build

`voice_calls` has `transcript` and `recording_url` columns. **Recording a call
generally requires notifying both parties in ES/FR/IT/DE/PT**, and the rules differ
per country.

Three options, in order of my preference for an MVP:

1. **No recording, no transcript.** Store outcome + duration only. Loses the
   ability to audit what the agent said — which, for an agent talking unattended
   to strangers, is a real loss.
2. **Transcript only, disclosed in the opening** alongside the AI disclosure.
   Retains auditability; the opening line grows by a clause.
3. **Audio recording.** Most useful, most exposed, needs per-country legal review.

**I recommend (2)** and would not build (3) without counsel. This is a legal
question, not an engineering one — I can implement whichever you choose, but I
should not be the one choosing it.

### 2.5 Cost controls

Voice is the first part of this program with a per-use bill that can run away:

- Per-call duration cap (agent ends politely at the limit).
- Daily call cap, mirroring `sequence_daily_send_cap`.
- Concurrency cap on the trunk.
- Every call's cost recorded so `/statistics` can show cost per conversion, the
  only number that says whether voice is worth keeping.

---

## 3. Production readiness for what already exists

Ordered by what blocks a first real cohort.

### 3.1 Credentials and config — you're handling these

| What | Where | Note |
|---|---|---|
| `RESEND_INBOUND_WEBHOOK_SECRET` | Resend dashboard | Worktree value is a throwaway |
| Resend Inbound MX | DNS, reply subdomain | Nothing inbound works without it |
| `TELNYX_PUBLIC_KEY` | Telnyx portal | Worktree value is a throwaway |
| Persona reply-to inboxes | Real, monitored | `reply_to` is NOT NULL precisely so a signature can't sit over a dead address |
| Personas for fr/es/it/de/pt | Settings → Personas | Only `en` exists; those markets currently fall back to English |
| `OPENROUTER_API_KEY` on the worker | `scripts/set-worker-secrets.sh` | Renamed from `ANTHROPIC_API_KEY` in the OpenRouter migration |

### 3.2 Deploy-order hazard

The worker cron already POSTs to `/api/sequences/tick`. **Deploy the dashboard
before the worker**, or the worker will hit a 404 every minute. Harmless but noisy.

`sequence_enabled`, `cold_offer_enabled` and `cx_agent_enabled` all default false,
so deploying does not start anything.

### 3.3 Recommended rollout

1. **Sequences on, one city.** Watch `/sequences` and `/statistics` for a week.
   The angles are untested against real florists — every number on that page today
   is my own verification traffic at n=1.
2. **CX agent in draft-only.** Read a week of real drafts against real replies
   before letting it send unattended. The cost is a few CX clicks; the cost of
   skipping it is a false promise in writing, in a language nobody on the team reads.
3. **Cold offers, per city**, after a few have gone through CX by hand.
4. **Voice, last**, and only once 1–3 have real numbers.

### 3.4 Gaps I would close before scale, not before launch

- **No alerting on the tick.** If `/api/sequences/tick` starts failing, nothing
  pages anyone — the funnel silently stops. `lib/cxAlerts.ts` already has the
  pattern; this needs an entry.
- **`sentToday` counts with a `like 'recruit.%'` scan** on `communications`. Fine
  at current volume, wants an index at scale.
- **No unsubscribe link on reactivation emails.** They go to partners who get
  order mail anyway, so the existing per-channel opt-out covers them — but a
  marketing-flavoured email with no visible opt-out is a complaint risk.
- **Bounce handling stops the run but doesn't mark the address.** A hard-bounced
  florist keeps their address on file and will be picked up by the next sweep.

### 3.5 Still open in `lib/lifecycle.ts`

`x-persona-is-not-real` closes with this decision. Remaining opens are pre-existing
and outside this program: `deliver-recycled-photo`, `x-fraud`,
`x-forwarded-magic-link`, `x-magic-link-session-fixation`, `parse-malformed`,
`match-stale-florist`, `x-customer-refund`, `x-manual-payout-blind-spot`.

---

## 4. Build order

| # | Work | Depends on |
|---|---|---|
| 1 | Written disclosure: `asked_if_ai` intent, guard, catalog × 6 | — |
| 2 | Recording/transcript decision | You + counsel |
| 3 | `lib/numberRouting.ts` + inventory schema use (pure, testable now) | — |
| 4 | Telnyx number client + `/settings` → Numbers | Telnyx creds, in-country addresses |
| 5 | Inbound voice: trunk, agent, disclosure, hand-off | 3, 4, ElevenLabs agent |
| 6 | `voice_calls` recording + cost tracking | 2 |
| 7 | Outbound voice step: hours, one-call cap, engaged-only | 5 |
| 8 | Voice numbers on `/statistics` | 6 |

Steps 1 and 3 are buildable and testable today with no credentials. Everything from
4 onward needs provisioning, which you're handling.

---

## 5. What I cannot verify, and will say so

I can build and unit-test every seam above. I **cannot** place a real call, and I
will not report the voice layer as working on the strength of a green build. When
the trunk and agent exist, verification means: one real inbound call answered with
the disclosure, one real outbound call placed from the right city's number, both
with a `voice_calls` row and a hand-off exercised.

Until then the honest status is "built, unverified against the provider".

## Sources

- [EU AI Act Article 50 — transparency obligations, applicable 2 August 2026](https://artificialintelligenceact.eu/transparency-rules-article-50/)
- [Cooley — Transparency obligations take effect 2 August 2026](https://www.cooley.com/news/insight/2026/2026-08-03-eu-ai-act-transparency-obligations-take-effect-2-august-2026)
- [Telnyx — international DID regulatory requirements](https://developers.telnyx.com/docs/numbers/phone-numbers/regulatory-requirements/index)
- [ElevenLabs — Telnyx SIP trunking](https://elevenlabs.io/docs/eleven-agents/phone-numbers/telephony/telnyx)

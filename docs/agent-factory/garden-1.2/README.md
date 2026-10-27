# Garden 1.2: managers and the engineer

Garden 1.2 is the daily agent-monitoring view the owner opens every morning. It
watches the agent factory (`agents/factory/`) while it works the garden, the
daily simulation of invented orders (`agents/garden/`). It has several parts:
this folder, `part-2/` (trouble paths) and `part-4/` (the control room). **Part 1 (this folder)** shows how the managers talk
to the engineer: which rules they own, how they brief fixes, and where their
cards are stuck, including problems nobody reported.

Designed in conversation on 2026-10-26. It builds on topics 1, 2, 6 and 7 in
`../topics/`. Topic 5 (the judge) is kept separate on purpose.

| File | What it is |
|---|---|
| `rule-map.html` | The page: rule map plus Rule pulse. Open it in a browser. |
| `rule-map.template.html` | The page source, with placeholders for the data. |
| `general-rules.json` | The 13 general rules and which situations sit under each. |
| `build-rule-map.mjs` | Rebuilds `rule-map.html` from `dashboard/lib/lifecycle.ts`. |
| `part-2/` | **Part 2, Trouble paths**: what the managers' agents do once something goes wrong. |

Rebuild after any change to `lifecycle.ts` or `general-rules.json`:

```bash
node docs/agent-factory/garden-1.2/build-rule-map.mjs
```

The script fails if a situation sits under no general rule, under two, or
under one that no longer exists. It needs no database: it reads only files in
this repo, so it runs as-is on a fresh clone.

The pages in `part-2/` and `part-4/` are snapshots. Their build scripts read
the garden's own database, which is not part of this repo, so the built HTML
is committed with its data already in it. Identifiers in that data (order
numbers, email subjects, PR links) were replaced with placeholders for
publication; the counts are the real ones from 13 to 27 October 2026.

## 1. One source of truth

- The rules are the branches in `dashboard/lib/lifecycle.ts`: 113 situations
  (88 under 16 steps, plus 25 cross-cutting). No separate rulebook, no stored
  copy, no vector database.
- 113 is too many to watch. They are grouped under **13 general rules**
  (`general-rules.json`). Cards open on a general rule, not on each situation,
  so a new situation shows up as one more dot under an existing rule.
- Each general rule gets an owner field in `lifecycle.ts` when this is built.
  New situations an agent adds carry `addedBy`, `addedOn` and `fromNear`.

## 2. How an alert reaches a rule

1. **Exact match:** the alert's key is a situation id. Free.
2. **Near match:** no exact match. Haiku reads the order's story and the
   general rules and names the nearest one, `near` or `far`. A near match
   counts toward that rule's card; it never opens a card of its own. Capped
   at $0.50 a day; past the cap, alerts wait until the next day.
3. **No rule:** `far`, or the cap is spent. Listed on the page, never dropped.

Near matches that keep landing on one rule become a new situation: the owning
manager adds the branch in a PR, after replaying the last 30 days of alerts to
show what it would have caught. Same pattern as Sentry's issue grouping
(fingerprint first, AI fallback, err on keeping cases apart).

## 3. A card's life

- **Opens** when its general rule gets x alerts in y days.
- **Closes** when the rule stays quiet for y days after the fix is merged.
- **Comes back:** a new alert on a closed rule reopens the same card.
- PRs that need a person are handled by the owner; the page only shows them.

## 4. Chain of command

| Step | Who |
|---|---|
| 1. Brief | The manager writes what "fixed" means for its rule. |
| 2. Code | Mike, the one code-fixing agent, writes the fix as a draft PR. |
| 3. Check | The manager checks the PR against its own brief. Mike never marks his own work. |
| 4. Last word | The rule: the card closes only after y quiet days. |

Why: a worker that only gets a summary misses the decisions upstream
(Cognition, "Don't build multi-agents"); the lead keeps the judgment and
checks the result (Anthropic's multi-agent research system). Coding stays
with one engineer, because splitting tightly linked work across agents
breaks it.

## 5. The cast (names from Suits)

Managers are **promoted roles**: a new factory role file that reads the
existing agents' files as specialist knowledge. The production agents
themselves do not change.

| Who | Role | Promoted from | Reads | General rules | Situations |
|---|---|---|---|---|---|
| Jessica | Human in the loop (the owner) | — | — | 1 | 14 |
| Harvey | Supply manager | Scout | Bloom, Sherlock, Cupid, Quill | 4 | 39 |
| Donna | Order-loop manager | Concierge | Babel | 7 | 53 |
| Louis | Proof manager | Hawkeye | — | 1 | 7 |
| Mike | The engineer | — | — | — | — |

Which general rules each manager owns:

- **Harvey:** `area-has-florists`, `only-ready-shops`, `offer-reaches-shop`,
  `recruiting-honest-once`.
- **Donna:** `order-in-clean`, `order-on-map`, `offer-gets-answer`,
  `accepted-gets-delivered`, `florist-questions-answered`, `shopify-agrees`,
  `someone-watching`.
- **Louis:** `photo-proves-delivery`.
- **Jessica:** `pay-exactly-owed`.

**Jessica's desk**, kept small on purpose:

1. Money: she briefs and checks every payout fix herself.
2. Customer complaints: she turns the real ones into cards for the right
   manager. Complaints don't reach the factory today; this is a new input.
3. Draft PRs: she reviews them for now. This shrinks as the system speeds up.

Two cautions from the review:

- Shopify writes can email customers: turning off Shopify's notifications
  doesn't stop the separate email tool. PRs that write to Shopify stay
  "Needs a person".
- Forwarded and planted sign-in links are security. Donna owns them, but a
  fix there still reaches the owner before merge.

Donna is the busiest manager. If her briefs get vague, split her into "order
in and placed" and "accepted to delivered".

### Before: eight managers (not on the page)

The first chain-of-command draft gave every existing agent the general rules
it already touched, and filled the gaps with a new agent and the owner. It was
dropped because six narrow managers each saw only their corner, and the
order-loop manager carried most of the load alone.

| Manager | General rules | Situations |
|---|---|---|
| Order-loop manager (new agent) | 4: orders in, map, offers answered, delivery | 33 |
| You (the owner) | 3: money, Shopify, watching and sign-in | 27 |
| Sherlock | 1: offer reaches the shop | 13 |
| Scout | 1: area has florists | 9 |
| Cupid | 1: recruiting messages | 9 |
| Bloom | 1: only ready shops | 8 |
| Hawkeye | 1: photo proves delivery | 7 |
| Concierge | 1: florist questions answered | 7 |

The steps that led from there to the current cast:

1. Promote three agents to area managers instead of building a new one.
2. Give Shopify and "someone watching" to Donna. They are deterministic, with
   the two cautions above.
3. Keep Jessica to money, complaints and draft PRs.

## 6. Rule pulse: what the page answers

Only numbers, no verdicts. Why a manager's numbers look the way they do is the
judge's job (topic 5, separate conversation).

**Not reported, but in the numbers.** Facts past a threshold, red first:
- a rule's near matches went up after a situation was added,
- 2 or more closed cards came back,
- cards waiting past the usual time at a step,
- a card sent back to Mike 2 or more times.

**1. What's new in the rules?** Per manager, per general rule:
- situations added,
- near matches per 100 orders over 4 weeks (a dashed line marks when a
  situation was added),
- the change since then,
- fix held,
- came back.

**2. Where is each card right now?** One row per manager. The columns are the
steps, in three bands:

- **Agent time:** waiting for brief, with Mike, sent back.
- **Your time:** waiting for your merge.
- **The rule:** quiet-day countdown, closed this month. Each cell shows the count and the oldest card in days.
Amber means past the usual wait, red means past twice the usual wait. The
row also shows trips back to Mike per card.

### Rules for these numbers

- **Agent time and human time never mix.** "Waiting for your merge" is
  Jessica's queue, so it sits under its own "Your time" column, and late
  merges are listed under Jessica's name, not the manager's. Jessica has no
  row in the card table. No score for a manager or Mike may include her
  time.
- **Nobody grades themselves.** The manager's own "passed check" is not a
  score. Only "fix held" and "came back" are, because no manager decides them.
- **Rates, not counts.** Near matches per 100 orders, so a quiet week doesn't
  flatter anyone.
- **Each manager against their own past**, never against each other: Donna
  covers 53 messy situations, Louis 7 narrow ones.
- **Too early is shown as too early.** No rates until a manager has 10 closed
  cards.
- **Growth test:** after a situation is added, near matches should drop. If
  they keep rising, the general rule is framed wrong and needs rewriting, not
  another patch.
- The code that computes these numbers is protected: no manager and not Mike
  may change it without a person.

Every number on the page today is an example. None of it is wired to live
data yet.

| Number | Comes from |
|---|---|
| New situations | Branches with `addedBy`, by merge date |
| Near matches | Sweep alerts placed near a rule, divided by working-set orders |
| Fix held / came back | Card closes and reopens, as a share of closed cards |
| Steps and ages | Card state plus `factory_runs` timestamps |
| Trips back to Mike | Runs per card after the first |

## 7. Page design

The page follows the **corporate-trust** and **design-taste** skills:

- **Surfaces and type:** white surfaces, system fonts, 1px rules `#E1E7EF`,
  8px corners, no shadows, no gradients.
- **One accent, deep blue `#1F4FE0`:** used only for the active view, the
  selected node, and agent ownership. Green, amber and red mean status only.
- **Manager colours:** muted, and only to tell managers apart (Harvey
  `#2D6A73`, Donna `#8A5A1F`, Louis `#7B3F8C`, Jessica `#0F1722`).
- **Tables are the main component:** numbers right-aligned, text
  left-aligned, row hover highlight.
- **Text sizes:** nothing under 12px. Situation names on the map appear only
  once zooming makes them 12px or more.
- **Dense layout:** the header shares a row with the totals, the legend sits
  in the map footer, and the pulse is in compact tables.
- **Light only:** the same palette as the repo's Smart design brand.

## 8. Still open

- The numbers x and y: alerts to open a card, quiet days to close it.
- Wiring the pulse to live data: card states, `factory_runs`, sweep alerts.
- The complaint input for Jessica.
- Adding owner and `addedBy` fields to `lifecycle.ts`.
- The judge (topic 5), in its own conversation.
- The rest of the owner's note in topic 6 ("With this review it...").
- Later parts of the daily monitoring view.

## 9. Part 2: Trouble paths

Moved to `part-2/`: what the managers' agents do once something goes wrong,
and why. See `part-2/README.md`.

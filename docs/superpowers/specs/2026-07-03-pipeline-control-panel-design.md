# Pipeline control panel + Engagement CRM

Date: 2026-07-03. Turns the dashboard from a geography-organized florist browser into a
**pipeline control panel** over the whole partner-acquisition process, and builds out the
second stage (**Engagement**) as a real CRM. Ships on a parallel **`v0.2`** branch/environment
(`facundo-v0.2.example.org`) alongside the existing `staging` — `staging` is untouched.

Supersedes and absorbs `crm_design.md` (the parked florist-card design). Where they differ,
this doc wins — notably: one `lifecycle_stage` field replaces the finer `pipeline_stage`.

## 1. The process

A florist moves through four macro-phases:

**Discovery** (found → targeted → reach-out sent) → **Engagement** (they replied; back-and-forth
to win them) → **Onboarding** (agreed; getting set up) → **Production** (live partner).

Only Discovery exists today (scattered across the city page: find → select → send). This work
frames all four as the top-level object, wires Discovery to what exists, **builds Engagement**,
and leaves Onboarding/Production as honest placeholders.

## 2. Data model — one `lifecycle_stage` axis

A single new column on `florists`:

- `lifecycle_stage text not null default 'found'`, check-constrained to
  `found · targeted · contacted · engaged · onboarding · production · lost`.

This is the whole journey in one ordered field (plus `lost` as an off-funnel side state). It
**replaces** `crm_design.md`'s `pipeline_stage (new/contacted/interested/won/lost)` — simpler,
and it matches the four macro-phases directly.

Two new tables (mirroring `crm_design.md`):

- `florist_notes` — `id uuid pk, florist_id uuid fk → florists, author text, body text,
  created_at timestamptz default now()`.
- `florist_meetings` — `id uuid pk, florist_id uuid fk → florists, title text,
  meeting_at timestamptz, outcome text, next_follow_up_at timestamptz, created_by text,
  created_at timestamptz default now()`.

Existing emails already live in `outreach` — no change there.

**RLS:** new **select** policies on `florist_notes` + `florist_meetings`, allow-listed via the
existing `is_email_allowed()`. No insert/update policy — writes only via service-role routes
(the exclude/outreach pattern). `lifecycle_stage` rides the florists table's existing RLS.

**Backfill migration (idempotent):** set `lifecycle_stage = 'contacted'` for any florist that
already has a row in `outreach` (a sent reach-out), else leave the `'found'` default. Run once;
safe to re-run.

## 3. Stage transitions

| To stage | Trigger | Mechanism |
|---|---|---|
| `found` | ingest | column default on upsert |
| `targeted` | "Mark as target" in the city florist table | `POST /api/florists/stage` |
| `contacted` | reach-out email sent | **auto**, inside `/api/outreach/send` |
| `engaged` / `onboarding` / `production` / `lost` | manual "Move to →" on the card | `POST /api/florists/stage` |

**Auto-bump rule (the only automation):** when `/api/outreach/send` records a sent email, it sets
`lifecycle_stage` to `contacted` **only if the florist is currently `found` or `targeted`** — it
never downgrades someone already at `engaged`+. No inbound-reply detection exists (needs webhooks,
out of scope), so every advance past `contacted` is a deliberate human click.

`lost` is reachable from any stage and is reversible (move back to any stage). Stage changes carry
no history log (current stage only) — see non-goals.

## 4. Home becomes the command center (`/`)

The landing page (currently `OverviewClient`) becomes a pipeline command center:

- **Four stage tiles** across the top — Discovery / Engagement / Onboarding / Production — each with
  a live cross-city count (florists whose `lifecycle_stage` falls in that phase; Discovery =
  found+targeted+contacted). Clicking a tile selects it and loads its view below. Discovery is the
  default selection.
- **Discovery view** — today's overview, essentially relocated: the global stat tiles + cities
  table (`CitiesTable`, map, scoring). Reuses the existing components with minimal change.
- **Engagement view** — a **cross-city list** of `engaged` florists (name → `/florist/[id]`), with
  the follow-up-due indicator surfaced (florists whose latest `next_follow_up_at` is upcoming/overdue).
- **Onboarding / Production views** — **placeholder panels**: the small real list of florists
  currently in that stage (name → card) + a muted "workflow coming soon" note. Real destinations,
  no dead links.
- **Lost** — not a headline tile; reachable as a filter/secondary link on the florist lists.

Counts and lists aggregate client-side across all cities (a few hundred rows — fine at POC scale,
consistent with today's `lib/stats.ts`).

## 5. Florist card — `/florist/[id]`

A roomy, linkable profile — the center of Engagement. The florist **name in any table links here**
(the score drawer stays for the ranking workflow). Server component fetches florist + city +
`outreach` + `florist_notes` + `florist_meetings`, renders:

- **Header** — name, current-stage **badge**, a **"Move to ▾"** stage control (dropdown of valid
  next stages + Lost), contact info (email/phone/site/rating/ecommerce), "← back to {city}", and an
  amber **follow-up-due chip** when a meeting's `next_follow_up_at` is upcoming/overdue.
- **Main column** — the **merged activity timeline**: `outreach` emails (✉) + notes (🗒) + meetings
  (📅) mapped to a common `{type, at, …}` shape, sorted newest-first, per-type rendering.
- **Right rail** — **add-note** (body → `POST /api/florists/note`), **log-meeting** (title / date /
  outcome / next-follow-up → `POST /api/florists/meeting`), and a **Compose email** button that opens
  the existing `OutreachSendPanel` scoped to this single florist (keeps test-mode + edit-before-send).

- **Empty states** — no activity yet → a gentle "No activity — send a reach-out or add a note."

## 6. API / routes

New page: `app/florist/[id]/page.tsx` (server component, `isAllowed`-gated like `/`).

New service-role write routes (all Node runtime, `isAllowed`-gated, `createServiceClient` — the
exclude/outreach pattern; never trust a client-supplied stage without validating it against the
allowed set):

- `POST /api/florists/stage`   `{ floristId, stage }` → validate `stage` ∈ the check-constraint set,
  update `lifecycle_stage`. Used by both "Mark as target" and the card's "Move to →".
- `POST /api/florists/note`    `{ floristId, body }` → insert note (author = caller email).
- `POST /api/florists/meeting` `{ floristId, title, meetingAt, outcome?, nextFollowUpAt? }` → insert.

Changed route: `app/api/outreach/send/route.ts` — after recording a sent email, apply the
`found|targeted → contacted` auto-bump (single conditional update; failure to bump must not fail the
send — log and continue).

## 7. Components

- **New:** `PipelineHome` (tiles + selected-view switch) replacing the shell role of `OverviewClient`;
  `StageTile`; `EngagementList` (+ reused florist row); the `/florist/[id]` page with
  `ActivityTimeline`, `AddNote`, `MeetingLog`, `StageControl` subcomponents; `StagePlaceholder`
  (Onboarding/Production).
- **Reused:** `OutreachSendPanel` (single-florist compose), `CitiesTable` + map + scoring (Discovery
  view, largely unchanged), `StatTile`, `FloristTable` (gains a stage badge + name→card link + a
  "Mark as target" action; a stage filter is optional-nice, not required for v1).

## 8. Deployment — parallel `v0.2` environment

The whole feature lands on branch **`v0.2`** and deploys **in parallel** to
`facundo-v0.2.example.org`, leaving `staging` (`facundo.example.org`) untouched.

- **Separate Worker.** On `v0.2`, `dashboard/wrangler.jsonc` uses `name: "facundo-dashboard-v2"`,
  the `WORKER_SELF_REFERENCE` service updated to match, and
  `routes: [{ pattern: "facundo-v0.2.example.org", custom_domain: true }]`. `example.org` is a
  Cloudflare zone, so `custom_domain: true` provisions DNS + cert on deploy. `INGEST_ENABLED=false`
  as today.
- **Separate CI.** A new `.github/workflows/deploy-v2.yml`, identical to `deploy-staging.yml` but
  triggered on push to `v0.2` and deploying the v2 Worker. Reuses the same GitHub secrets
  (`CLOUDFLARE_*`, `NEXT_PUBLIC_SUPABASE_*`).
- **Shared Supabase.** Same project as staging (same tables, same allow-list, same auth). The new
  schema migrations (§2) are additive and apply to the one shared database — so once merged they
  affect staging's data model too, but no staging UI change ships until `v0.2` is promoted.
- **User steps (once):** add `https://facundo-v0.2.example.org/**` to Supabase → Auth → Redirect
  URLs. Google OAuth client is unchanged (it points at the Supabase project callback). Set the
  Cloudflare DNS only if `custom_domain` auto-provisioning needs confirmation.

**Migration-vs-staging note:** because the DB is shared, apply the additive migrations before/at
first `v0.2` deploy; they don't break staging (new column has a default; new tables are unread by
staging code). Destructive changes are out of scope.

## 9. Non-goals (carried from `crm_design.md` + this scope)

No inbound email/reply capture (needs webhooks). No stage-change history log (current stage only).
No calendar integration (manual meeting log only). No kanban drag-and-drop (stage is a dropdown).
No @-mentions / multi-user assignment. **Onboarding & Production build no workflow** — placeholder
panels only. No separate Supabase project for v0.2 (shared, by design). No changes to the ingest
pipeline. No stage filter on the city table required for v1 (optional).

## 10. Verification

- **DB/RLS:** migrations apply; a signed-out / non-allow-listed request reads zero notes/meetings;
  service-role routes reject a non-allow-listed caller (403) and an invalid stage value (400).
- **Transitions:** ingest → found; "Mark as target" → targeted; send reach-out → contacted (and a
  florist already `engaged` is *not* downgraded); manual moves work; backfill sets contacted for
  florists with prior emails.
- **Card:** timeline merges emails+notes+meetings in the right order; add-note and log-meeting persist
  and appear; follow-up chip shows when due; compose opens the outreach panel in test mode.
- **Home:** tiles show correct cross-city counts; Discovery view matches today's overview; Engagement
  lists engaged florists; Onboarding/Production render placeholders, not errors.
- **Deploy:** `v0.2` builds and serves at `facundo-v0.2.example.org`; `staging` at
  `facundo.example.org` is unchanged; auth works on the new origin.
- Exercise in a real browser (chrome-devtools-mcp) before calling it done.

## 11. Build split

- **backend-engineer** → `supabase/schema.sql` (+ migration/backfill): `lifecycle_stage` column,
  `florist_notes` + `florist_meetings` tables & RLS; the three write routes; the outreach-send
  auto-bump.
- **frontend-engineer** → `PipelineHome` + tiles + view switch; `/florist/[id]` card + subcomponents;
  `EngagementList`; `StagePlaceholder`; `FloristTable` stage badge / name→card link / "Mark as target".
- **devops-engineer** → `wrangler.jsonc` v2 values + `deploy-v2.yml` + custom domain.

Parallelizable after the plan; end with a `code-reviewer` pass (plan alignment + the security bits:
stage-value validation, `isAllowed` gates, no service-role leak, timeline RLS).

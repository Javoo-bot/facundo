-- AI delivery-photo verification (dual-provider: Claude + Gemini).
--
-- Until now the delivered-photo upload marked the order delivered and released
-- (or, in manual/semi mode, held) the 30% leg against ANY image — no check of
-- what the photo actually shows. This records a structured verification: each
-- enabled provider looks at the proof photo vs the ordered line items and votes;
-- a combined verdict (pass | review | fail) then drives the payout hold.
--
-- One row per verification attempt for an assignment's delivered photo. The
-- verdict is advisory to the hold decision in lib/payout.ts — the held-30% +
-- CX approve/reject queue stays the ultimate gate; the verdict just decides
-- whether auto mode may release, and surfaces "why" to CX.

create table if not exists photo_verifications (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references orders(id) on delete cascade,
  assignment_id  uuid not null references order_assignments(id) on delete cascade,
  photo_key      text not null,                         -- R2 key of the delivered photo verified
  verdict        text not null check (verdict in ('pass', 'review', 'fail')),
  confidence     numeric,                               -- combined 0..1
  providers      jsonb not null default '[]'::jsonb,    -- [{provider, ok, matched, confidence, itemsFound, itemsMissing, notes, error?}]
  items_expected jsonb,                                 -- snapshot of the line items compared against
  reasoning      text,                                  -- human-readable summary of the combined verdict
  created_at     timestamptz not null default now()
);
create index if not exists photo_verifications_order_idx on photo_verifications (order_id);
create index if not exists photo_verifications_assignment_idx on photo_verifications (assignment_id);

-- Toggle each provider on/off without a deploy (money-gating knob; both on = consensus).
alter table app_settings add column if not exists photo_verify_claude boolean not null default true;
alter table app_settings add column if not exists photo_verify_gemini boolean not null default true;

-- Staff read via the allow list; writes are service-role only (no write policy).
alter table photo_verifications enable row level security;
drop policy if exists "allowlisted read photo_verifications" on photo_verifications;
create policy "allowlisted read photo_verifications" on photo_verifications
  for select to authenticated using (public.is_email_allowed());

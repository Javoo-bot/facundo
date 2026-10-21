-- Magic links for florist-facing messages: one click from an offer email / SMS
-- / issue notification signs the florist in AND lands them on the specific
-- order the message was about (dashboard/app/florist/m/[token]).
--
-- Service-role only, deliberately: RLS is enabled with NO policies, so the
-- anon+JWT client can never read a token row. Only the redeem route (which
-- goes through lib/supabaseAdmin.ts) touches this table. Same posture as the
-- other system tables.
create table if not exists florist_magic_tokens (
  token         text primary key,
  florist_id    uuid not null references florists(id) on delete cascade,
  dest          text not null,
  purpose       text not null,
  assignment_id uuid references order_assignments(id) on delete set null,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  use_count     integer not null default 0,
  revoked_at    timestamptz
);

create index if not exists florist_magic_tokens_florist_idx on florist_magic_tokens(florist_id);
create index if not exists florist_magic_tokens_assignment_idx on florist_magic_tokens(assignment_id);
-- Supports the housekeeping sweep of long-dead rows.
create index if not exists florist_magic_tokens_expires_idx on florist_magic_tokens(expires_at);

alter table florist_magic_tokens enable row level security;

comment on table florist_magic_tokens is
  'One-per-send sign-in tokens for florist-facing email/SMS links. Reusable within a 30-day window (lib/floristMagicLink.ts::MAGIC_TOKEN_TTL_DAYS) — deliberately NOT single-use, because corporate link scanners (Outlook Safe Links) and Gmail''s prefetcher follow URLs before the human clicks and would burn a single-use token on a valid email.';
comment on column florist_magic_tokens.dest is
  'Relative destination path (e.g. /florist/orders/<assignment_id>). Stored on the row rather than passed in the URL so the emailed link carries no redirect parameter to tamper with; the redeem route re-validates it via isSafeDest before redirecting.';
comment on column florist_magic_tokens.purpose is
  'offer | issue | onboarding — which message minted it. Diagnostic only; the redeem route does not branch on it.';
comment on column florist_magic_tokens.assignment_id is
  'Set for offer/issue tokens so a single order''s links can be revoked together. ON DELETE SET NULL: losing the assignment must not silently delete an audit row.';
comment on column florist_magic_tokens.revoked_at is
  'Manual kill switch for one send, without locking the florist out of every other link they hold.';
comment on column florist_magic_tokens.use_count is
  'Bumped on each successful redeem. A count far above 1 is the signal that a link was forwarded or shared.';

-- Atomic usage stamp. A read-modify-write from the route would lose counts
-- whenever a link scanner and the florist hit the same token concurrently —
-- exactly the case this column exists to measure.
create or replace function bump_magic_token_use(p_token text)
returns void
language sql
security definer
set search_path = public
as $$
  update florist_magic_tokens
     set use_count = use_count + 1,
         last_used_at = now()
   where token = p_token;
$$;

-- The redeem route calls this through the service-role client, which already
-- bypasses RLS; no grant to anon/authenticated, so it stays unreachable from
-- the browser.
revoke all on function bump_magic_token_use(text) from public, anon, authenticated;


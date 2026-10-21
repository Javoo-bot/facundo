-- Short links for outbound SMS.
-- See docs/superpowers/specs/2026-08-05-url-shortener-design.md.
--
-- WHY: measured on the current offer copy, the two URLs in an offer SMS (a
-- 77-char magic link + a 109-char unsubscribe link) push every locale to THREE
-- billed segments (en 372 chars, fr 402). Replacing both with a 43-char short
-- link brings that to two — roughly a third off every offer SMS.
create table if not exists short_links (
  code          text primary key,
  target_url    text not null,
  kind          text not null,
  florist_id    uuid references florists(id) on delete set null,
  assignment_id uuid,
  created_at    timestamptz not null default now(),
  hit_count     integer not null default 0,
  first_hit_at  timestamptz,
  last_hit_at   timestamptz
);

comment on table short_links is
  'Code -> URL for links embedded in outbound SMS. The code IS a credential (it fronts a magic-link login), so it is generated from crypto randomness at 10 base62 chars (~59 bits) — see dashboard/lib/shortLink.ts. No expires_at on purpose: the TARGET owns its lifetime (a magic token still expires in 30 days and falls back to sign-in), and a short link expiring before its target would break a working link.';

comment on column short_links.hit_count is
  'Redeem count. Deliberately the only click data kept — no IP, user-agent or per-click rows — so this needs no retention policy. Distinguishes "florist never opened it" from "opened and ignored".';

alter table short_links enable row level security;
-- No policy, deliberately: service-role only, same shape as `communications`.
-- Both writers (the SMS builders) and the reader (the redirect handler) run
-- server-side with the service key; no florist or staff session ever needs to
-- read this table directly.

-- Attribution lookups ("which links did we send this florist?") — the primary
-- key already covers the redirect path's lookup by code.
create index if not exists short_links_florist_idx on short_links (florist_id, created_at desc);

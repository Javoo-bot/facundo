-- Florist networks, and the three ways a stored email can fail to be the SHOP's
-- own address.
--
-- WHY: reach-out resolves its recipient straight from `florists.email`, which
-- ingest scrapes from `website_url`. For a large minority of shops that URL is
-- not the shop's own site — it's their profile page on a network, franchise or
-- trade-association site — so enrichment stored the NETWORK's head-office
-- address as the shop's contact. Measured on 2026-08-06: 207 of the 984
-- email-having florists (21%) sat on an address shared with another florist.
-- One order for Issy-les-Moulineaux sent four separate offers to
-- contact@reseau-demo.fr, each naming a different Paris shop; none of the four
-- shops that could actually deliver ever saw it.
--
-- Three distinct failures, deliberately modelled separately because the
-- BUSINESS response to each differs:
--
--   1. network_id       — the address belongs to a real, identifiable network
--                         (Reseau Demo, Franchise Fleurs Demo, Jardinerie Demo). NOT a data error:
--                         the shop is real and reachable, and the network itself
--                         is a partnership lead worth one conversation that
--                         inherits all its member shops. Hence a first-class
--                         entity rather than a flag.
--   2. email_shared_count — the address is held by several shops but we can't
--                         attribute it to a known network. Suspicious, not
--                         diagnosed; the shared-address sweep sets it.
--   3. email_bounced_at  — the provider told us the address is dead.
--
-- All three suppress the EMAIL leg of an offer only. The offer still goes out
-- by SMS and push (dashboard/lib/offerChannels.ts::emailSkipReason), which is
-- the right call: in every case observed, the Maps-sourced phone number was the
-- shop's own and correct — it is specifically the scraped email that is wrong.

create table if not exists florist_networks (
  id            uuid primary key default gen_random_uuid(),
  -- Display name, e.g. 'Reseau Demo', 'Franchise Fleurs Demo'.
  name          text not null,
  -- Registrable domain that identifies the network's site, e.g. 'reseau-demo.fr'.
  -- The dedup key: ingest and the backfill both look a network up by this.
  -- Stored lowercase without a leading 'www.'.
  domain        text not null unique,
  -- What kind of thing this is, because the handling differs:
  --   'network'   — a florist network with a shared brand and member shops
  --                 (Reseau Demo). Member shops are independent businesses.
  --   'franchise' — one brand, franchised outlets (Franchise Fleurs Demo).
  --   'chain'     — one company, own outlets (Jardinerie Demo).
  --   'directory' — a listing/trade-association site that is nobody's shop
  --                 (artisansfleuristes-demo.com). An email scraped here is
  --                 simply WRONG — it belongs to some other member entirely.
  kind          text not null check (kind in ('network', 'franchise', 'chain', 'directory')),
  -- The head-office address we keep scraping, when we know it. Recorded so the
  -- detection sweep can recognise it, and so a future partnership conversation
  -- has somewhere to start. Never used as an offer recipient.
  contact_email text,
  notes         text,
  created_at    timestamptz not null default now()
);

comment on table florist_networks is
  'Florist networks, franchises, chains and directories whose site hosts member shops. A florist linked to one has a website_url that is not its own site, so its scraped email is the network''s, not the shop''s.';

-- Nullable and ON DELETE SET NULL: unlinking a network must never remove the
-- florist. The shop is real either way — only our belief about its email changes.
alter table florists add column if not exists network_id uuid references florist_networks(id) on delete set null;

comment on column florists.network_id is
  'The network/franchise/chain/directory whose site this florist''s website_url points at. Non-null means `email` is the network''s address, not the shop''s: the offer email leg is skipped and the offer hedges to SMS + push.';

-- How many florist rows share this exact (lowercased, trimmed) address. 0/1 =
-- the address is this shop's alone. Denormalised rather than computed per send
-- because the offer path must not run an aggregate to decide a recipient, and
-- because staff need to sort and filter on it in the dashboard.
alter table florists add column if not exists email_shared_count integer not null default 1;

comment on column florists.email_shared_count is
  'Number of florist rows holding this exact email. >1 means the address cannot identify this shop; the offer email leg is skipped. Maintained by the shared-address sweep (ingest/networks.py::sweep_shared_emails).';

-- Set from the Resend webhook on a hard bounce (app/api/webhooks/resend).
-- Timestamp rather than boolean so staff can see WHEN it died, and so a
-- corrected address can simply clear it.
alter table florists add column if not exists email_bounced_at timestamptz;

comment on column florists.email_bounced_at is
  'When this florist''s address hard-bounced, per the Resend webhook. Non-null skips the offer email leg (SMS + push still fire). Cleared when the address is corrected.';

create index if not exists florists_network_idx on florists (network_id) where network_id is not null;
-- Partial: the vast majority of rows are 1, and every query on this wants the rest.
create index if not exists florists_email_shared_idx on florists (email_shared_count) where email_shared_count > 1;
-- Backs the shared-address sweep's group-by and the ingest-time lookup.
create index if not exists florists_email_lower_idx on florists (lower(email)) where email is not null;

alter table florist_networks enable row level security;

-- Read for allow-listed staff, matching every other reference table. Writes are
-- service-role only (ingest + the backfill), which bypasses RLS — so no write
-- policy, same pattern as email_events.
create policy "allowlisted read florist_networks" on florist_networks
  for select to authenticated using (public.is_email_allowed());

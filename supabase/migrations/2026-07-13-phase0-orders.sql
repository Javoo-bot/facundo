-- Phase 0: order loop data model. Additive; follows the RLS pattern of every prior table
-- (staff read via is_email_allowed(); writes are service-role-only — no write policy here).

-- 1. Florist operational + sourcing columns (spec §A, module-contracts Seam A) ---------------
alter table florists add column if not exists source            text check (source in ('existing','known','new')) default 'new';
alter table florists add column if not exists source_notes      text;
alter table florists add column if not exists exclusion_reason  text;
alter table florists add column if not exists delivery_radius_km double precision;
alter table florists add column if not exists business_hours     jsonb;
alter table florists add column if not exists capacity_per_day   integer;
alter table florists add column if not exists payout_terms       text;
alter table florists add column if not exists whatsapp           text;
alter table florists add column if not exists preferred_channel  text check (preferred_channel in ('email','whatsapp','app'));
alter table florists add column if not exists trust_tier         text check (trust_tier in ('Z','Y','X','K'));
alter table florists add column if not exists onboarded_at       timestamptz;
alter table florists add column if not exists airwallex_payout_ref text;

-- 2. Trust tiers — payment behaviour per tier (spec §F/§H). Manual assignment for now. --------
create table if not exists trust_tiers (
  code               text primary key check (code in ('Z','Y','X','K')),
  label              text not null,
  split_on_accept    integer not null,       -- % released on accept
  split_on_delivery  integer not null,       -- % released on delivered photo
  photo_required     boolean not null,
  hold_payout        boolean not null default false,  -- K: hold pending review
  exposure_cap_eur   numeric,
  updated_at         timestamptz not null default now()
);
insert into trust_tiers (code, label, split_on_accept, split_on_delivery, photo_required, hold_payout, exposure_cap_eur) values
  ('Z','Trusted',   70, 30, false, false, null),
  ('Y','Known',     50, 50, true,  false, 500),
  ('X','New',        0,100, true,  false, 200),
  ('K','Flagged',    0,100, true,  true,  0)
on conflict (code) do nothing;

-- 3. Orders (spec §B). Idempotent on shopify_order_id. Rich fields kept in columns; the full
--    Shopify payload is retained in `raw` so nothing is silently dropped. ---------------------
create table if not exists orders (
  id                 uuid primary key default gen_random_uuid(),
  shopify_order_id   text unique,
  order_name         text,
  shopify_created_at timestamptz,
  currency           text,
  total              numeric,
  financial_status   text,          -- 'paid' | 'pending' (gates when we pay the florist)
  fulfillment_status text,
  locale             text,
  city_id            uuid references cities(id),
  buyer_name         text,
  buyer_email        text,
  buyer_phone        text,
  recipient_name     text,
  recipient_phone    text,
  delivery_address   jsonb,         -- { line1, line2, city, postal, region, country }
  delivery_area      text,          -- coarse area shown pre-accept (e.g. "Girona · Eixample")
  delivery_lat       double precision,
  delivery_lng       double precision,
  delivery_at        timestamptz,   -- requested delivery window start
  delivery_window    text,          -- human window, e.g. "10:00–14:00"
  occasion           text,
  greeting           text,
  substitution_policy text,
  status             text not null default 'received',
  notes              text,
  raw                jsonb,
  created_at         timestamptz not null default now()
);
create index if not exists orders_status_idx on orders(status);
create index if not exists orders_city_idx on orders(city_id);

create table if not exists order_line_items (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references orders(id) on delete cascade,
  title          text,
  variant        text,
  sku            text,
  catalog_id     text,
  quantity       integer not null default 1,
  unit_price     numeric,
  line_total     numeric,
  product_type   text,             -- bouquet | wine | vase | chocolate | card
  bouquet_spec   text,
  image_url      text,
  personalization text
);
create index if not exists order_line_items_order_idx on order_line_items(order_id);

-- 4. Assignments = the reach-out/offer state machine per candidate florist (spec §D/§F). ------
create table if not exists order_assignments (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references orders(id) on delete cascade,
  florist_id      uuid not null references florists(id) on delete cascade,
  rank            integer,                       -- candidate rank in the wave
  florist_source  text,                          -- existing|known|new at offer time
  status          text not null default 'candidate'
                    check (status in ('candidate','queued','sent','opened','declined','expired','accepted','reassigned','delivered')),
  offer_kind      text check (offer_kind in ('exclusive','race')),
  offer_expires_at timestamptz,
  sla_deadline_at timestamptz,
  decline_reason  text,
  decline_detail  text,
  draft_subject   text,
  draft_body      text,
  payout_price    numeric,
  assigned_at     timestamptz not null default now(),
  sent_at         timestamptz,
  opened_at       timestamptz,
  accepted_at     timestamptz,
  delivered_at    timestamptz
);
create index if not exists order_assignments_order_idx on order_assignments(order_id);
create index if not exists order_assignments_florist_idx on order_assignments(florist_id);

-- 5. Delivery proof + payout legs + audit timeline -------------------------------------------
create table if not exists delivery_events (
  id            uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references order_assignments(id) on delete cascade,
  type          text not null,        -- ready_photo | delivered_photo | problem
  photo_key     text,                 -- R2 object key (Plan 4/5)
  note          text,
  created_at    timestamptz not null default now()
);

create table if not exists payouts (
  id            uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references order_assignments(id) on delete cascade,
  leg           text not null check (leg in ('accept','delivery')),
  amount        numeric,
  currency      text,
  rail          text check (rail in ('card','sepa')),
  status        text not null default 'pending'
                  check (status in ('pending','issued','paid','failed','clawed_back')),
  provider_ref  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists order_events (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references orders(id) on delete cascade,
  type       text not null,
  payload    jsonb,
  actor      text,
  created_at timestamptz not null default now()
);
create index if not exists order_events_order_idx on order_events(order_id, created_at);

-- 6. RLS: staff read only; writes are service-role-only (no write policy). --------------------
do $$
declare t text;
begin
  foreach t in array array['trust_tiers','orders','order_line_items','order_assignments','delivery_events','payouts','order_events']
  loop
    execute format('alter table %I enable row level security;', t);
    execute format($p$create policy "allowlisted read %1$s" on %1$I for select to authenticated using (public.is_email_allowed());$p$, t);
  end loop;
end $$;

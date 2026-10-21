-- Makes the Resend webhook's insert idempotent (see
-- app/api/webhooks/resend/route.ts).
--
-- The route inserted unconditionally with no uniqueness key, so an ordinary
-- provider retry — Svix retries on any non-2xx, and the route was also
-- returning 200 after a failed insert — created a second email_events row for
-- the same delivery/open/click. Every one of those duplicates inflates the
-- funnel on /statistics (get_email_stats counts events, not distinct emails),
-- which is exactly the number an ops lead would act on.
--
-- The Svix message id (the `svix-id` header) is the provider's own per-message
-- identifier and is stable across retries of the same event, so it is the right
-- key. It is also already required for signature verification, which means the
-- route cannot reach the insert without one — hence NOT NULL. Safe to add
-- without a default: this table is new in the same unshipped feature and holds
-- 0 rows (verified against the live database before applying).
--
-- A plain (non-partial) unique index, deliberately: PostgREST's
-- `on_conflict=provider_event_id` needs to infer an arbiter index, and it has no
-- way to spell a partial index's WHERE clause.

alter table email_events add column if not exists provider_event_id text not null;

create unique index if not exists email_events_provider_event_id_key
  on email_events(provider_event_id);

comment on column email_events.provider_event_id is
  'Svix message id (svix-id header) of the webhook delivery that produced this row. Unique: the webhook inserts on conflict do nothing so provider retries are idempotent.';

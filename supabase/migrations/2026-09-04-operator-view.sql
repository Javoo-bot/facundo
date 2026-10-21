-- A shorter sidebar for the people who run orders.
--
-- The staff sidebar has grown to ~25 entries across four sections, and most of
-- them answer a question an operator never asks: how a funnel is worded, which
-- shops are mid-recruiting, what the ingest jobs did. Someone whose whole job
-- is "work the queue" reads all of it anyway, every time, looking for the two
-- links they need.
--
-- WHY a setting rather than a role change: the roles already exist and mean
-- something (`ops` can do these things, and occasionally does). This hides
-- them by default without removing anyone's access — turn it off and the full
-- sidebar comes back for everyone. Admins are never affected, so nobody can
-- switch this on and lose the way to switch it off.
--
-- Read by dashboard/components/shell/StaffShell.tsx via the layout; the list
-- of what it hides is OPERATOR_HIDDEN there, deliberately in code, because it
-- is a judgement about what a job needs rather than a per-tenant preference.
alter table app_settings
  add column if not exists operator_view boolean not null default false;

comment on column app_settings.operator_view is
  'true = non-admin staff get the short sidebar (see OPERATOR_HIDDEN in components/shell/StaffShell.tsx). Hides links only; every route keeps its own role gate, so this is a decluttering setting and NOT an access control.';

-- Sprint 4 (feedback loop): per-florist track-record view, all-time. Feeds two
-- consumers: the florist detail page (staff-facing stats row) and the matcher's
-- cold-start-guarded performance term (ingest-worker reads it via the service
-- role, which bypasses RLS entirely — see security_invoker note below).
--
-- Deliberately ALL-TIME, not windowed: `sample_size` (accepted+declined) is used
-- downstream for Bayesian smoothing in ingest-worker/src/match.ts, which needs the
-- full history to know how much to trust the observed rate. The separate
-- "tier-review recommendation" hint (decline_count/issue_count in roughly the
-- last 10 assignments) is intentionally NOT computed here — it's derived
-- client-side in dashboard/components/florist/floristOps.ts from the
-- already-loaded `assignments` (ordered newest-first) + a small delivery_events
-- query scoped to those assignment ids. That was simpler than a row_number()
-- lateral windowing here for a value that's UI-only and never read by the
-- matcher, and keeps this view's shape stable for the matcher's needs.
--
-- security_invoker = true (PG15+): without this, a view runs with the view
-- OWNER's privileges against the underlying tables — which in Supabase is
-- typically a superuser-ish role that bypasses RLS, meaning ANY authenticated
-- user (not just allow-listed staff) could read this view regardless of the
-- "allowlisted read florists/order_assignments/orders/delivery_events" policies.
-- security_invoker makes the view evaluate RLS as the querying role instead, so
-- the existing is_email_allowed() policies on the underlying tables are what
-- actually gate access — same allow-list model as everywhere else, no new
-- exception carved out for this view.
create or replace view florist_stats
with (security_invoker = true) as
select
  fl.id as florist_id,
  case
    when coalesce(agg.accepted, 0) + coalesce(agg.declined, 0) = 0 then null
    else round(coalesce(agg.accepted, 0)::numeric / (coalesce(agg.accepted, 0) + coalesce(agg.declined, 0)), 4)
  end as acceptance_rate,
  case
    when coalesce(agg.delivered, 0) = 0 then null
    else round(coalesce(agg.on_time, 0)::numeric / agg.delivered, 4)
  end as on_time_rate,
  coalesce(agg.declined, 0) as decline_count,
  coalesce(issues.issue_count, 0) as issue_count,
  coalesce(agg.accepted, 0) + coalesce(agg.declined, 0) as sample_size
from florists fl
left join (
  select
    oa.florist_id,
    count(*) filter (where oa.status in ('accepted', 'delivered')) as accepted,
    count(*) filter (where oa.status = 'declined') as declined,
    count(*) filter (where oa.status = 'delivered') as delivered,
    -- "on time" requires both timestamps present; a null on either side is
    -- excluded from the numerator (not counted as on-time, not as late) since
    -- there's nothing honest to say about it — the null-safe denominator
    -- above (`agg.delivered`) still counts it, so this can only ever push the
    -- rate down, never fabricate a good or bad outcome.
    count(*) filter (
      where oa.status = 'delivered'
        and oa.delivered_at is not null
        and o.delivery_at is not null
        and oa.delivered_at <= o.delivery_at
    ) as on_time
  from order_assignments oa
  left join orders o on o.id = oa.order_id
  group by oa.florist_id
) agg on agg.florist_id = fl.id
left join (
  select oa.florist_id, count(*) as issue_count
  from delivery_events de
  join order_assignments oa on oa.id = de.assignment_id
  where de.type = 'problem'
  group by oa.florist_id
) issues on issues.florist_id = fl.id;

grant select on florist_stats to authenticated;

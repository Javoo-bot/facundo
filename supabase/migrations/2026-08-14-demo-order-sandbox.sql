-- Demo order sandbox: lets staff generate a distinct, clearly-marked order row
-- (optionally cloned from a real one) to walk through Production/order-loop
-- scenarios (happy path, no-nearby-shop escalation, offer timeout, accepted
-- awaiting photo, paid, photo-needs-review) against demo shops instead of real
-- florists. See dashboard/lib/testing/demoSandbox.ts.
--
-- `is_demo` is a plain data marker, not a safety gate on its own — the real
-- safety properties are: (1) demo shops are always florists.is_test_shop=true,
-- which the matching hard filter already keeps out of every REAL customer
-- order (app_settings.test_shop_matching defaults to 'exclude'); the sandbox
-- additionally never reads or writes that global setting, it always passes
-- testShopMatching='only' as a per-call argument scoped to its own query; and
-- (2) lib/payout.ts forces the ledger rail (no real Airwallex card) for any
-- assignment whose florist is_test_shop, regardless of app_settings.payments_live.
-- `is_demo` exists so a demo order can be found, displayed with a clear label,
-- and cleaned up without a fragile shopify_order_id string-prefix scan.
alter table orders add column if not exists is_demo boolean not null default false;

-- Traceability only, when the demo order was cloned from a real one. Never used
-- to route automation, and set null (not cascaded) if the source order is later
-- deleted, so a demo row never disappears because a real one did.
alter table orders add column if not exists demo_source_order_id uuid references orders(id) on delete set null;

comment on column orders.is_demo is
  'Staff-created sandbox order (dashboard/lib/testing/demoSandbox.ts) — never a real Shopify order. Always matched only to florists.is_test_shop=true shops, and always paid on the ledger rail (see lib/payout.ts). Excluded from the working set by default (no worklist_at/tag) so real automation never touches it unless staff explicitly run the scenario tooling.';
comment on column orders.demo_source_order_id is
  'When a demo order was cloned from a real one, the source orders.id — traceability only, not read by any automation.';

create index if not exists orders_is_demo_idx on orders (is_demo) where is_demo;

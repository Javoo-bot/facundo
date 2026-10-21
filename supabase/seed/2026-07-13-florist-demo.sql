-- Adds florist staff+florist@fc.example.com (Girona, Z-tier, onboarded) + 6 orders assigned to it.
-- Idempotent. Depends on the mock-florists seed (Girona city). Safe to re-run.
do $$
declare
  v_city uuid; clat double precision; clng double precision; vf uuid;
  o1 uuid := '00000000-0000-4000-c000-000000000201';
  o2 uuid := '00000000-0000-4000-c000-000000000202';
  o3 uuid := '00000000-0000-4000-c000-000000000203';
  o4 uuid := '00000000-0000-4000-c000-000000000204';
  o5 uuid := '00000000-0000-4000-c000-000000000205';
  o6 uuid := '00000000-0000-4000-c000-000000000206';
  a4 uuid; a5 uuid;
begin
  select id, center_lat, center_lng into v_city, clat, clng from cities where country='ES' and city='Girona';
  if v_city is null then raise exception 'Girona city not found — run the mock-florists seed first.'; end if;

  -- The florist (onboarded, Z-tier, real login email).
  insert into florists (city_id, place_id, name, address, lat, lng, rating, review_count,
    distance_km_from_center, phone_maps, website_url, has_website, is_ecommerce, email, phone_web,
    owner_name, shop_highlight, lifecycle_stage, source, delivery_radius_km, capacity_per_day,
    business_hours, payout_terms, preferred_channel, trust_tier, onboarded_at)
  values (v_city, 'FLQ-DEMO-01', 'Flors Demo', 'Carrer del Carme 10, Girona',
    clat + 0.002, clng - 0.003, 4.9, 210, 0.4, '+34 972 000 200',
    'https://flors-demo.example.com', true, true, 'staff+florist@fc.example.com', '+34 972 000 200',
    'Demo Owner', 'Premium same-day delivery', 'production', 'existing', 12, 10,
    '{"mon_fri":"09:00-20:00","sat":"09:00-15:00"}'::jsonb, '70/30 on accept', 'app', '1', now() - interval '30 days')
  on conflict (city_id, place_id) do update
    set email = excluded.email, trust_tier = excluded.trust_tier, lifecycle_stage = 'production'
  returning id into vf;

  -- #2101 · Subtle Freshness · Reserved (exclusive, sent)
  insert into orders (id, shopify_order_id, order_name, shopify_created_at, currency, total, financial_status, city_id, recipient_name, delivery_area, delivery_at, delivery_window, occasion, greeting, status)
  values (o1, 'YGV-2101', '#2101', now()-interval '1 hour', 'EUR', 99.90, 'paid', v_city, 'Laia P.', 'Girona · Barri Vell · 0.5 km', now()+interval '5 hours', '16:00–18:00', 'birthday', 'Per molts anys!', 'reaching_out') on conflict (id) do nothing;
  insert into order_line_items (order_id, title, quantity, unit_price, line_total, product_type, bouquet_spec)
  select o1, 'Subtle Freshness', 1, 99.90, 99.90, 'bouquet', 'Pink lilies + roses, ~45 cm' where not exists (select 1 from order_line_items where order_id=o1);
  insert into order_assignments (order_id, florist_id, rank, florist_source, status, offer_kind, sla_deadline_at, payout_price, sent_at)
  select o1, vf, 1, 'existing', 'sent', 'exclusive', now()+interval '2 hours', 70, now()-interval '20 minutes' where not exists (select 1 from order_assignments where order_id=o1 and florist_id=vf);

  -- #2102 · Pure Heart · First-to-accept (race, sent)
  insert into orders (id, shopify_order_id, order_name, shopify_created_at, currency, total, financial_status, city_id, recipient_name, delivery_area, delivery_at, delivery_window, occasion, status)
  values (o2, 'YGV-2102', '#2102', now()-interval '40 minutes', 'EUR', 61.46, 'paid', v_city, 'Marc T.', 'Girona · Eixample · 1.1 km', now()+interval '1 day'+interval '10 hours', '10:00–14:00', 'thank you', 'reaching_out') on conflict (id) do nothing;
  insert into order_line_items (order_id, title, quantity, unit_price, line_total, product_type, bouquet_spec)
  select o2, 'Pure Heart', 1, 61.46, 61.46, 'bouquet', 'Spray roses + gerberas, ~40 cm' where not exists (select 1 from order_line_items where order_id=o2);
  insert into order_assignments (order_id, florist_id, rank, florist_source, status, offer_kind, sla_deadline_at, payout_price, sent_at)
  select o2, vf, 1, 'existing', 'sent', 'race', now()+interval '3 hours', 42, now()-interval '10 minutes' where not exists (select 1 from order_assignments where order_id=o2 and florist_id=vf);

  -- #2103 · Colorful Cocktail · opened (exclusive)
  insert into orders (id, shopify_order_id, order_name, shopify_created_at, currency, total, financial_status, city_id, recipient_name, delivery_area, delivery_at, delivery_window, occasion, status)
  values (o3, 'YGV-2103', '#2103', now()-interval '2 hours', 'EUR', 69.86, 'paid', v_city, 'Núria B.', 'Girona · Santa Eugènia · 2.2 km', now()+interval '3 hours', '13:00–15:00', 'congratulations', 'reaching_out') on conflict (id) do nothing;
  insert into order_line_items (order_id, title, quantity, unit_price, line_total, product_type, bouquet_spec)
  select o3, 'Colorful Cocktail', 1, 69.86, 69.86, 'bouquet', 'Multi-tone gerberas, ~35 cm' where not exists (select 1 from order_line_items where order_id=o3);
  insert into order_assignments (order_id, florist_id, rank, florist_source, status, offer_kind, sla_deadline_at, payout_price, sent_at, opened_at)
  select o3, vf, 1, 'existing', 'opened', 'exclusive', now()+interval '90 minutes', 48, now()-interval '35 minutes', now()-interval '20 minutes' where not exists (select 1 from order_assignments where order_id=o3 and florist_id=vf);

  -- #2104 · Classic Love · Accepted / in production (+ 70% payout ledger)
  insert into orders (id, shopify_order_id, order_name, shopify_created_at, currency, total, financial_status, city_id, recipient_name, recipient_phone, delivery_address, delivery_area, delivery_at, occasion, greeting, status)
  values (o4, 'YGV-2104', '#2104', now()-interval '4 hours', 'EUR', 54.90, 'paid', v_city, 'Emma R.', '+34 600 900 100', '{"line1":"Plaça Independència 5","city":"Girona","zip":"17001","country_code":"ES"}'::jsonb, 'Girona · Centre · 0.7 km', now()+interval '2 hours', 'anniversary', 'Feliç aniversari!', 'in_production') on conflict (id) do nothing;
  insert into order_line_items (order_id, title, quantity, unit_price, line_total, product_type, bouquet_spec)
  select o4, 'Classic Love', 1, 54.90, 54.90, 'bouquet', '12 classic red roses, ~40 cm' where not exists (select 1 from order_line_items where order_id=o4);
  insert into order_assignments (order_id, florist_id, rank, florist_source, status, payout_price, sent_at, accepted_at)
  select o4, vf, 1, 'existing', 'accepted', 38, now()-interval '4 hours', now()-interval '3 hours' where not exists (select 1 from order_assignments where order_id=o4 and florist_id=vf);
  select id into a4 from order_assignments where order_id=o4 and florist_id=vf;
  insert into payouts (assignment_id, leg, amount, currency, rail, status)
  select a4, 'accept', 26.60, 'EUR', 'sepa', 'issued' where not exists (select 1 from payouts where assignment_id=a4 and leg='accept');

  -- #2105 · Peach Flavour · Accepted / in production (+ 70% payout ledger)
  insert into orders (id, shopify_order_id, order_name, shopify_created_at, currency, total, financial_status, city_id, recipient_name, recipient_phone, delivery_address, delivery_area, delivery_at, occasion, status)
  values (o5, 'YGV-2105', '#2105', now()-interval '1 day', 'EUR', 87.90, 'paid', v_city, 'Pau G.', '+34 600 900 200', '{"line1":"Carrer Nord 22","city":"Girona","zip":"17004","country_code":"ES"}'::jsonb, 'Girona · Pont Major · 1.6 km', now()+interval '6 hours', 'birthday', 'in_production') on conflict (id) do nothing;
  insert into order_line_items (order_id, title, quantity, unit_price, line_total, product_type, bouquet_spec)
  select o5, 'Peach Flavour', 1, 87.90, 87.90, 'bouquet', 'Alstroemerias, chrysanthemums, gerberas, lilies & roses, ~45 cm' where not exists (select 1 from order_line_items where order_id=o5);
  insert into order_assignments (order_id, florist_id, rank, florist_source, status, payout_price, sent_at, accepted_at)
  select o5, vf, 1, 'existing', 'accepted', 60, now()-interval '1 day', now()-interval '20 hours' where not exists (select 1 from order_assignments where order_id=o5 and florist_id=vf);
  select id into a5 from order_assignments where order_id=o5 and florist_id=vf;
  insert into payouts (assignment_id, leg, amount, currency, rail, status)
  select a5, 'accept', 42.00, 'EUR', 'sepa', 'issued' where not exists (select 1 from payouts where assignment_id=a5 and leg='accept');

  -- #2106 · Women's Glow (+ wine + chocolate) · queued (new)
  insert into orders (id, shopify_order_id, order_name, shopify_created_at, currency, total, financial_status, city_id, recipient_name, delivery_area, delivery_at, delivery_window, occasion, status)
  values (o6, 'YGV-2106', '#2106', now()-interval '15 minutes', 'EUR', 83.90, 'paid', v_city, 'Gia M.', 'Girona · Montilivi · 2.9 km', now()+interval '2 days', '16:00–20:00', 'get well', 'matched') on conflict (id) do nothing;
  insert into order_line_items (order_id, title, quantity, unit_price, line_total, product_type, bouquet_spec) values
    (o6, 'Women''s Glow', 1, 55.90, 55.90, 'bouquet', 'Red anthurium arrangement'),
    (o6, 'Red wine', 1, 18.00, 18.00, 'wine', null),
    (o6, 'Chocolates', 1, 10.00, 10.00, 'chocolate', null)
  on conflict do nothing;
  -- #2106 is seeded as DECLINED (order still 'matched' / open) so the florist
  -- History view + "changed your mind? accept" re-accept flow has a demo case.
  insert into order_assignments (order_id, florist_id, rank, florist_source, status, decline_reason, offer_kind, sla_deadline_at, payout_price)
  select o6, vf, 1, 'existing', 'declined', 'Price too low', 'exclusive', now()+interval '1 day'+interval '20 hours', 58 where not exists (select 1 from order_assignments where order_id=o6 and florist_id=vf);
end $$;

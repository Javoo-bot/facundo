do $$
declare
  v_city uuid; f1 uuid; f2 uuid; f3 uuid;
  o1 uuid := '00000000-0000-4000-b000-000000000101';
  o2 uuid := '00000000-0000-4000-b000-000000000102';
  o3 uuid := '00000000-0000-4000-b000-000000000103';
  o4 uuid := '00000000-0000-4000-b000-000000000104';
  o5 uuid := '00000000-0000-4000-b000-000000000105';
begin
  select id into v_city from cities where country='ES' and city='Girona';
  select id into f1 from florists where place_id='MOCK-GI-01';   -- existing, Z
  select id into f2 from florists where place_id='MOCK-GI-02';   -- existing, Z
  select id into f3 from florists where place_id='MOCK-GI-05';   -- known, Y

  -- #1043 · Subtle Freshness · reaching out (3 candidates: opened / declined / queued)
  insert into orders (id, shopify_order_id, order_name, shopify_created_at, currency, total, financial_status,
    locale, city_id, buyer_name, buyer_email, buyer_phone, recipient_name, recipient_phone,
    delivery_address, delivery_area, delivery_lat, delivery_lng, delivery_at, delivery_window, occasion, greeting, status, raw)
  values (o1, '5219483001', '#1043', now() - interval '2 hours', 'EUR', 99.90, 'paid', 'ca', v_city,
    'Anna R.', 'anna@example.com', '+34 600 111 222', 'Marta S.', '+34 600 333 444',
    '{"address1":"Carrer Nou 12","city":"Girona","zip":"17001","province":"Girona","country":"Spain","country_code":"ES"}'::jsonb,
    'Girona · Barri Vell · 0.6 km', 41.9861, 2.8250, now() + interval '1 day' + interval '10 hours', '10:00–14:00',
    'birthday', 'Feliç aniversari! 🎉', 'reaching_out',
    $json${"id":5219483001,"name":"#1043","financial_status":"paid","currency":"EUR","total_price":"99.90","customer":{"first_name":"Anna","last_name":"R.","email":"anna@example.com"},"shipping_address":{"name":"Marta S.","address1":"Carrer Nou 12","city":"Girona","zip":"17001","country_code":"ES","latitude":41.9861,"longitude":2.8250},"line_items":[{"title":"Subtle Freshness","sku":"FC-SUBTLE-STD","quantity":1,"price":"99.90"}],"note_attributes":[{"name":"delivery_date","value":"2026-07-14"}]}$json$::jsonb)
  on conflict (id) do nothing;
  insert into order_line_items (order_id, title, sku, quantity, unit_price, line_total, product_type, bouquet_spec, image_url)
  select o1, 'Subtle Freshness', 'FC-SUBTLE-STD', 1, 99.90, 99.90, 'bouquet', 'Pink lilies + roses, seasonal greens, ~45 cm', 'https://www.fc.example.com/'
  where not exists (select 1 from order_line_items where order_id=o1);
  insert into order_assignments (order_id, florist_id, rank, florist_source, status, offer_kind, sla_deadline_at, payout_price, draft_subject, draft_body)
  select o1, f1, 1, 'existing', 'opened', 'exclusive', now() + interval '3 hours', 70, 'New Facundo order — Girona, tomorrow', 'Hola! Tenim una comanda per demà a Girona (Subtle Freshness). La podeu fer? Pagament en acceptar…'
  where f1 is not null and not exists (select 1 from order_assignments where order_id=o1 and florist_id=f1);
  insert into order_assignments (order_id, florist_id, rank, florist_source, status, decline_reason, decline_detail)
  select o1, f3, 2, 'known', 'declined', 'price_too_low', '+€10'
  where f3 is not null and not exists (select 1 from order_assignments where order_id=o1 and florist_id=f3);
  insert into order_assignments (order_id, florist_id, rank, florist_source, status)
  select o1, f2, 3, 'existing', 'queued'
  where f2 is not null and not exists (select 1 from order_assignments where order_id=o1 and florist_id=f2);
  insert into order_events (order_id, type, actor)
  select o1, t, 'system' from unnest(array['received','matched','reaching_out']) as t
  where not exists (select 1 from order_events where order_id=o1);

  -- #1042 · Pure Heart · in production (accepted by f1)
  insert into orders (id, shopify_order_id, order_name, shopify_created_at, currency, total, financial_status,
    city_id, recipient_name, delivery_area, delivery_at, occasion, status, raw)
  values (o2, '5219483002', '#1042', now() - interval '5 hours', 'EUR', 61.46, 'paid', v_city,
    'María G.', 'Girona · Eixample · 1.1 km', now() + interval '4 hours', 'anniversary', 'in_production',
    $json${"id":5219483002,"name":"#1042","financial_status":"paid","line_items":[{"title":"Pure Heart","quantity":1,"price":"61.46"}]}$json$::jsonb)
  on conflict (id) do nothing;
  insert into order_line_items (order_id, title, sku, quantity, unit_price, line_total, product_type, bouquet_spec)
  select o2, 'Pure Heart', 'FC-PUREHEART-STD', 1, 61.46, 61.46, 'bouquet', 'Spray roses + gerberas, ~40 cm'
  where not exists (select 1 from order_line_items where order_id=o2);
  insert into order_assignments (order_id, florist_id, rank, florist_source, status, payout_price, accepted_at)
  select o2, f1, 1, 'existing', 'accepted', 43, now() - interval '3 hours'
  where f1 is not null and not exists (select 1 from order_assignments where order_id=o2 and florist_id=f1);

  -- #1044 · Colorful Cocktail · delivered (by f2)
  insert into orders (id, shopify_order_id, order_name, shopify_created_at, currency, total, financial_status,
    city_id, recipient_name, delivery_area, delivery_at, occasion, status, raw)
  values (o3, '5219483003', '#1044', now() - interval '1 day', 'EUR', 69.86, 'paid', v_city,
    'Luc M.', 'Girona · Santa Eugènia · 2.3 km', now() - interval '2 hours', 'congratulations', 'delivered',
    $json${"id":5219483003,"name":"#1044","financial_status":"paid","line_items":[{"title":"Colorful Cocktail","quantity":1,"price":"69.86"}]}$json$::jsonb)
  on conflict (id) do nothing;
  insert into order_line_items (order_id, title, sku, quantity, unit_price, line_total, product_type, bouquet_spec)
  select o3, 'Colorful Cocktail', 'FC-COCKTAIL-STD', 1, 69.86, 69.86, 'bouquet', 'Multi-tone gerberas, ~35 cm'
  where not exists (select 1 from order_line_items where order_id=o3);
  insert into order_assignments (order_id, florist_id, rank, florist_source, status, payout_price, accepted_at, delivered_at)
  select o3, f2, 1, 'existing', 'delivered', 49, now() - interval '20 hours', now() - interval '2 hours'
  where f2 is not null and not exists (select 1 from order_assignments where order_id=o3 and florist_id=f2);

  -- #1046 · Women's Glow (bouquet + wine + chocolates) · escalated (wrong address)
  insert into orders (id, shopify_order_id, order_name, shopify_created_at, currency, total, financial_status,
    city_id, recipient_name, delivery_area, delivery_at, status, notes, raw)
  values (o4, '5219483004', '#1046', now() - interval '3 hours', 'EUR', 83.90, 'paid', v_city,
    null, 'Girona · address unresolved', now() + interval '6 hours', 'escalated', 'Wrong/incomplete address — recipient phone unreachable',
    $json${"id":5219483004,"name":"#1046","financial_status":"paid","line_items":[{"title":"Women's Glow","quantity":1,"price":"83.90"}]}$json$::jsonb)
  on conflict (id) do nothing;
  insert into order_line_items (order_id, title, sku, quantity, unit_price, line_total, product_type, bouquet_spec) values
    (o4, 'Women''s Glow', 'FC-WGLOW-STD', 1, 55.90, 55.90, 'bouquet', 'Red anthurium arrangement'),
    (o4, 'Red wine', 'FC-WINE-RED', 1, 18.00, 18.00, 'wine', null),
    (o4, 'Chocolates', 'FC-CHOC-BOX', 1, 10.00, 10.00, 'chocolate', null)
  on conflict do nothing;

  -- #1051 · Peach Flavour · received (just landed, not yet matched)
  insert into orders (id, shopify_order_id, order_name, shopify_created_at, currency, total, financial_status,
    city_id, recipient_name, delivery_area, delivery_at, occasion, status, raw)
  values (o5, '5219483005', '#1051', now() - interval '10 minutes', 'EUR', 87.90, 'paid', v_city,
    'Gia P.', 'Girona · Pont Major · 1.8 km', now() + interval '2 days', 'birthday', 'received',
    $json${"id":5219483005,"name":"#1051","financial_status":"paid","line_items":[{"title":"Peach Flavour","quantity":1,"price":"87.90"}]}$json$::jsonb)
  on conflict (id) do nothing;
  insert into order_line_items (order_id, title, sku, quantity, unit_price, line_total, product_type, bouquet_spec)
  select o5, 'Peach Flavour', 'FC-PEACH-STD', 1, 87.90, 87.90, 'bouquet', 'Alstroemerias, chrysanthemums, gerberas, lilies & roses, ~45 cm'
  where not exists (select 1 from order_line_items where order_id=o5);
end $$;

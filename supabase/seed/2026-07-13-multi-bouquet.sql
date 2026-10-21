-- A two-bouquet order for the demo florist (staff+florist@fc.example.com,
-- place_id FLQ-DEMO-01), so the florist PWA can show multiple bouquets — each
-- with its own photo + description — in one order. Idempotent on the order id.
do $$
declare
  v_city uuid; vf uuid;
  o7 uuid := '00000000-0000-4000-b000-000000000107';
begin
  select id into v_city from cities where country='ES' and city='Girona';
  select id into vf from florists where place_id='FLQ-DEMO-01';
  if vf is null then raise notice 'demo florist not found — run the florist-demo seed first'; return; end if;

  insert into orders (id, shopify_order_id, order_name, shopify_created_at, currency, total, financial_status,
    city_id, recipient_name, delivery_area, delivery_at, delivery_window, occasion, greeting, status, raw)
  values (o7, '5219483007', '#2107', now() - interval '15 minutes', 'EUR', 124.76, 'paid', v_city,
    'Elena V.', 'Girona · Eixample · 1.3 km', now() + interval '1 day' + interval '9 hours', '09:00–13:00',
    'anniversary', 'Amb tot el meu amor ❤️', 'reaching_out',
    $json${"id":5219483007,"name":"#2107","financial_status":"paid","currency":"EUR","total_price":"124.76","line_items":[{"title":"Classic Love","quantity":1,"price":"54.90"},{"title":"Colorful Cocktail","quantity":1,"price":"69.86"}]}$json$::jsonb)
  on conflict (id) do nothing;

  insert into order_line_items (order_id, title, sku, quantity, unit_price, line_total, product_type, bouquet_spec, image_url)
  select o7, 'Classic Love', 'FC-CLOVE-STD', 1, 54.90, 54.90, 'bouquet',
    '12 red roses, eucalyptus greenery, ~40 cm',
    'https://www.fc.example.com/cdn/shop/files/67164d8a62441043743586.jpg?v=1771431073'
  where not exists (select 1 from order_line_items where order_id=o7 and title='Classic Love');

  insert into order_line_items (order_id, title, sku, quantity, unit_price, line_total, product_type, bouquet_spec, image_url)
  select o7, 'Colorful Cocktail', 'FC-COCKTAIL-STD', 1, 69.86, 69.86, 'bouquet',
    'Mixed-colour gerberas, statice, assorted greenery, ~35 cm',
    'https://www.fc.example.com/cdn/shop/files/66194d8f57de3321167940.jpg?v=1761282127'
  where not exists (select 1 from order_line_items where order_id=o7 and title='Colorful Cocktail');

  insert into order_assignments (order_id, florist_id, rank, florist_source, status, offer_kind, sla_deadline_at, payout_price, sent_at)
  select o7, vf, 1, 'existing', 'sent', 'exclusive', now() + interval '3 hours', 88, now() - interval '5 minutes'
  where not exists (select 1 from order_assignments where order_id=o7 and florist_id=vf);

  insert into order_events (order_id, type, actor)
  select o7, t, 'system' from unnest(array['received','matched','reaching_out']) as t
  where not exists (select 1 from order_events where order_id=o7);
end $$;

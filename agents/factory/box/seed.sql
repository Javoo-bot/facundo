-- The factory agent's own garden: a handful of invented rows so the dashboard
-- has something to show. Nothing here comes from staging or production; every
-- name is made up and every address is @example.com. Idempotent.
--
-- Loaded by agents/factory/box/local-garden.sh after schema.sql and the
-- migrations, on a throwaway local Supabase that dies with the runner.

-- TEST MODE on, sinks pointed nowhere real: nothing can leave this box anyway
-- (no sender keys), but a page that reads these must not show a real address.
insert into app_settings (id, test_mode, payments_live, test_email)
values (1, true, false, 'factory-sink@example.com')
on conflict (id) do update set test_mode = true, payments_live = false, test_email = excluded.test_email;

insert into cities (country, city, center_lat, center_lng, radius_km, region)
values ('ES', 'Girona', 41.9794, 2.8214, 8, 'Girona')
on conflict (country, city, region) do nothing;

do $$
declare
  v_city uuid;
  names text[] := array['Factory Flors Una', 'Factory Flors Dos', 'Factory Flors Tres', 'Factory Flors Quatre'];
  i int;
begin
  select id into v_city from cities where country = 'ES' and city = 'Girona' and region = 'Girona';

  for i in 1..4 loop
    insert into florists (city_id, place_id, name, address, lat, lng, rating, review_count,
      distance_km_from_center, has_website, email, phone_maps, owner_name,
      lifecycle_stage, is_test_shop, onboarded_at)
    values (v_city, 'FACTORY-' || lpad(i::text, 2, '0'), names[i], 'Carrer Inventat ' || i || ', Girona',
      41.9794 + i * 0.003, 2.8214 + i * 0.004, 4.2 + i * 0.1, 10 * i,
      round((i * 0.4)::numeric, 2), false, 'shop' || i || '@example.com', '+34 600 000 00' || i, 'Owner ' || i,
      case when i < 4 then 'production' else 'found' end, true,
      case when i < 4 then now() - (i || ' days')::interval end)
    on conflict (city_id, place_id) do nothing;
  end loop;

  insert into orders (id, shopify_order_id, order_name, shopify_created_at, currency, total, financial_status,
    city_id, buyer_name, buyer_email, recipient_name, delivery_area, delivery_lat, delivery_lng,
    delivery_at, occasion, status, raw)
  select ('00000000-0000-4000-f000-00000000000' || n)::uuid, 'FACTORY-' || n, '#F00' || n,
    now() - (n || ' hours')::interval, 'EUR', 50 + n * 10, 'paid',
    v_city, 'Buyer ' || n, 'buyer' || n || '@example.com', 'Recipient ' || n, 'Girona',
    41.98 + n * 0.002, 2.82 + n * 0.002, now() + (n || ' hours')::interval, 'birthday', s,
    jsonb_build_object('name', '#F00' || n, 'line_items', jsonb_build_array(jsonb_build_object('title', 'Invented Bouquet', 'quantity', 1)))
  from unnest(array['received', 'reaching_out', 'in_production', 'delivered']) with ordinality as t(s, n)
  on conflict (id) do nothing;
end $$;

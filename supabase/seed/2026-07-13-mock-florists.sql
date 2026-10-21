-- Mock florist network — real scraped-table FORMAT, fabricated DATA. Idempotent. Safe to re-run.
do $$
declare
  v_city uuid; clat double precision; clng double precision; i int;
  names   text[] := array['Flors Aurora','Roses & Co','Petals Girona','Jardí Blau','La Rosaleda','Verd Natura','Fleur Girona','Casa Botànica','El Taller Floral','Nard & Co','Primavera Flors','Bloom Studio'];
  streets text[] := array['Carrer Nou 12','Rambla 4','Av. Jaume I 88','Plaça del Vi 3','Carrer Ballesteries 21','Pont de Pedra 7','Carrer Santa Clara 40','Gran Via 15','Carrer Nord 9','Passeig 33','Carrer Ciutadans 18','Av. Sant Francesc 2'];
  owners  text[] := array['Aurora M.','Marc R.','Núria P.','Jordi S.','Laia V.','Pau G.','Emma T.','Oriol B.','Clara D.','Roger F.','Anna L.','Marta C.'];
  srcs    text[] := array['existing','existing','existing','existing','known','known','known','known','new','new','new','new'];
  tiers   text[] := array['1','1','2','2','2','3','3','3',null,null,null,null];
begin
  insert into cities (country, city, center_lat, center_lng, radius_km, region)
    values ('ES','Girona',41.9794,2.8214,8,'Girona') on conflict (country, city, region) do nothing;
  select id, center_lat, center_lng into v_city, clat, clng from cities where country='ES' and city='Girona';

  for i in 1..12 loop
    insert into florists (city_id, place_id, name, address, lat, lng, rating, review_count,
      distance_km_from_center, phone_maps, website_url, has_website, is_ecommerce, email, phone_web,
      owner_name, shop_highlight, lifecycle_stage, source, delivery_radius_km, capacity_per_day,
      business_hours, payout_terms, preferred_channel, trust_tier, onboarded_at)
    values (v_city, 'MOCK-GI-'||lpad(i::text,2,'0'), names[i], streets[i]||', Girona',
      clat + (i-6)*0.0035, clng + (i-6)*0.0042,
      round((3.9 + (i % 5) * 0.2)::numeric, 1), 20 + i * 13,
      round((abs(i-6) * 0.3)::numeric, 2), '+34 972 '||(100000 + i*777)::text,
      'https://mock-florist-'||i||'.example.com', true, (i % 3 <> 0),
      'shop'||i||'@example.com', '+34 972 '||(100000 + i*777)::text, owners[i],
      case when i % 2 = 0 then 'Wedding & event specialist' else 'Same-day local delivery' end,
      case when srcs[i] = 'new' then 'found' else 'production' end,
      srcs[i], 10, 6 + (i % 4),
      '{"mon_fri":"09:00-20:00","sat":"09:00-14:00"}'::jsonb, '70/30 on accept', 'app', tiers[i],
      case when srcs[i] = 'new' then null else now() - (i||' days')::interval end)
    on conflict (city_id, place_id) do nothing;
  end loop;

  -- Anna's exclusion list (bulk-exclude example): one 'new' lead is denylisted and stays out.
  update florists set excluded_at = now(), exclusion_reason = 'Anna: prior quality issue'
    where city_id = v_city and place_id = 'MOCK-GI-12' and excluded_at is null;
end $$;

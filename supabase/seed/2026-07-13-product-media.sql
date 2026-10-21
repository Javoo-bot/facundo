-- Real Facundo product media for the mock order line items.
-- Keyed by product title so it corrects rows created by BOTH
-- 2026-07-13-mock-orders.sql and 2026-07-13-florist-demo.sql, and is
-- idempotent (safe to re-run). Image URLs are live fc.example.com Shopify CDN
-- assets, verified hotlinkable cross-origin (access-control-allow-origin: *).
-- NOTE: Shopify CDN filenames are content-hashed; if Facundo re-uploads a
-- photo the ?v= timestamp/hash changes. Treat these as good-for-now snapshots.

update order_line_items set
  image_url = 'https://www.fc.example.com/cdn/shop/files/67e6c68286c62012209794.jpg?v=1771431082',
  bouquet_spec = 'Pink roses, Asiatic lilies, assorted greenery, ~45 cm'
where title = 'Subtle Freshness';

update order_line_items set
  image_url = 'https://www.fc.example.com/cdn/shop/files/66194e35b1de3893342061_74de11c2-47e4-4b8d-aab3-43d03792a735.jpg?v=1761282166',
  bouquet_spec = 'Red spray roses, pastel spray roses, white gerberas, ~40 cm'
where title = 'Pure Heart';

update order_line_items set
  image_url = 'https://www.fc.example.com/cdn/shop/files/66194d8f57de3321167940.jpg?v=1761282127',
  bouquet_spec = 'Mixed-colour gerberas, statice, assorted greenery, ~35 cm'
where title = 'Colorful Cocktail';

update order_line_items set
  image_url = 'https://www.fc.example.com/cdn/shop/files/6728aa78065b4771521482.jpg?v=1762782705',
  bouquet_spec = 'Red anthurium arrangement'
where title = 'Women''s Glow';

update order_line_items set
  image_url = 'https://www.fc.example.com/cdn/shop/files/660d5f9f6e950756627957.jpg?v=1761282049',
  bouquet_spec = 'Orange roses, lilies, gerberas, chrysanthemums, alstroemerias, ~45 cm'
where title = 'Peach Flavour';

update order_line_items set
  image_url = 'https://www.fc.example.com/cdn/shop/files/67164d8a62441043743586.jpg?v=1771431073',
  bouquet_spec = '12 red roses, eucalyptus greenery, ~40 cm'
where title = 'Classic Love';

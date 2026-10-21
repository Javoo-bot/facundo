-- Florist language and phone country, read from the shop's OWN address.
--
-- A DATA migration: it changes existing florist rows, no schema. Data fixes go
-- through migrations in this repo, never scripts, so staging and production
-- are corrected by exactly the same statements and the repo can reproduce the
-- result. Apply to STAGING first.
--
-- ---------------------------------------------------------------------------
-- WHY
--
-- Until 2026-09-16 a florist inherited the country of the CITY it was ingested
-- under. City radii are 20 km and cross borders (46 of Founex (CH)'s 174 shops
-- are in France; Basel holds shops in three countries), and the language map
-- had no Latin American country, no AT, and no AD/MA/TN. So on order #2000034 a
-- French florist got an English offer, and thousands of shops were in the same
-- state. The app now resolves both from the address at send and ingest time
-- (dashboard/lib/shopCountry.ts, dashboard/lib/floristLocale.ts,
-- ingest-worker/src/shopCountry.ts). This migration corrects the rows that were
-- stored before that. Full write-up:
-- docs/superpowers/specs/2026-09-16-florist-locale-and-reply-failures-design.md
--
-- ---------------------------------------------------------------------------
-- HOW IT STAYS IDENTICAL TO THE APP
--
-- The country-name table below is not hand-written from memory. Every
-- digit-free segment found in the last three comma-separated parts of a
-- production address (1,395 distinct values, 2026-09-16) was reviewed, and each
-- name kept here was run through the app's own parser
-- (shopCountry.ts::countryFromAddress / localeFromAddress) and resolves to the
-- same country and language. Only countries that imply a SUPPORTED language
-- are listed: a name that is not here resolves to nothing, which leaves the row
-- untouched. It fails closed. Names are matched lowercase and exact, because
-- the `unaccent` extension is not installed; an unlisted spelling is simply
-- skipped, and the app still resolves it at send time.
--
-- Deliberately excluded, to match the app exactly:
--   * "تونس" followed by an invisible U+200E direction mark. The app's parser
--     does not resolve that variant, so the migration does not either.
--   * Tunisian addresses joined with the Arabic comma "،". The app splits on
--     "," only, so neither resolves them.
--
-- ---------------------------------------------------------------------------
-- MEASURED AGAINST PRODUCTION, READ-ONLY, 2026-09-16 (before applying)
--
--   Part 1 sets a language on 2,366 florists:
--     CH->de 817  DO->es 349  CH->fr 241  AR->es 216  AT->de 200  CO->es 172
--     MA->fr 132  PE->es  91  FR->fr  57  TN->fr  40  DE->de  18  UY->es  17
--     AD->es  15  ES->es   1
--   2 Swiss rows stay null: their address has no postcode ("Zürich,
--   Switzerland"), the same answer the app gives.
--
--   Part 2 repairs 10 phone numbers.
--
-- Safe to re-run: part 1 only fills null locales, and part 2's conditions stop
-- matching once a number is repaired.

-- ---------------------------------------------------------------------------
-- 1. LANGUAGE — null-only fill. A florist's own choice is never overwritten.
--
-- Switzerland cannot be decided by its country code, so it is split by
-- postcode, as the app does: 1000-2999 French (Geneva, Vaud, Neuchâtel, Jura),
-- 6500-6999 Italian (Ticino), anything else German. The FIRST 4-digit number of
-- 1000 or more in the address decides, which skips a lower house number that
-- comes before it. Measured: 243 French, 818 German, 0 Italian.
-- ---------------------------------------------------------------------------
with
names(name, alpha2) as (values
  ('france', 'FR'), ('frankreich', 'FR'),
  ('allemagne', 'DE'), ('deutschland', 'DE'),
  ('españa', 'ES'), ('spain', 'ES'),
  ('portugal', 'PT'), ('brasil', 'BR'),
  ('argentina', 'AR'), ('colombia', 'CO'), ('perú', 'PE'), ('uruguay', 'UY'),
  ('república dominicana', 'DO'),
  ('österreich', 'AT'),
  ('schweiz', 'CH'), ('switzerland', 'CH'),
  ('maroc', 'MA'), ('تونس', 'TN'),
  ('andorra', 'AD')
),
-- Mirrors REGION_TO_LOCALE in dashboard/lib/i18n/locales.ts for the countries
-- above. CH is absent on purpose: it is decided by postcode below.
region_locale(alpha2, locale) as (values
  ('FR', 'fr'), ('DE', 'de'), ('ES', 'es'), ('PT', 'pt'), ('BR', 'pt'),
  ('AR', 'es'), ('CO', 'es'), ('PE', 'es'), ('UY', 'es'), ('DO', 'es'),
  ('AT', 'de'), ('MA', 'fr'), ('TN', 'fr'), ('AD', 'es')
),
-- Non-empty address segments, numbered from the END (the app drops empty
-- segments before looking at the last three, so this does too).
segments as (
  select f.id, f.address, trim(s.part) as seg,
         row_number() over (partition by f.id order by s.ord desc) as from_end
  from florists f
  cross join lateral unnest(string_to_array(f.address, ',')) with ordinality as s(part, ord)
  where f.locale is null
    and f.deleted_at is null
    and f.address is not null
    and trim(s.part) <> ''
),
-- The country is usually the last segment but not always (Google sometimes
-- puts the postcode after it), so the last three are scanned and the one
-- nearest the end wins.
shop_country as (
  select distinct on (sg.id) sg.id, sg.address, n.alpha2
  from segments sg
  join names n on n.name = lower(sg.seg)
  where sg.from_end <= 3
  order by sg.id, sg.from_end
),
derived as (
  select sc.id,
         case when sc.alpha2 = 'CH' then (
           select case when m.pc between 1000 and 2999 then 'fr'
                       when m.pc between 6500 and 6999 then 'it'
                       else 'de' end
           from (
             select (x.arr)[1]::int as pc, x.ord
             from regexp_matches(sc.address, '\m(\d{4})\M', 'g') with ordinality as x(arr, ord)
           ) m
           where m.pc >= 1000
           order by m.ord
           limit 1
         )
         else rl.locale end as locale
  from shop_country sc
  left join region_locale rl on rl.alpha2 = sc.alpha2
)
update florists f
set locale = d.locale
from derived d
where f.id = d.id
  and f.locale is null
  and d.locale is not null;

-- ---------------------------------------------------------------------------
-- 2. PHONE — repair phone_web numbers stored with the wrong country code.
--
-- The Cloudflare Worker parsed a shop's LOCAL number against its city's
-- country. libphonenumber-js accepts the French landline "04 50 00 11 22" as a
-- valid Swiss number and stored "+41 45 000 11 22"; Telnyx then rejected the
-- SMS. The original text is gone, so a number is repaired ONLY when that is
-- provably right: it is replaced with the shop's own phone_maps (Google's
-- number, which arrives already international and was never corrupted) and
-- ONLY when all of these hold:
--   * the address names a country, and phone_maps carries that country's code;
--   * phone_web carries a DIFFERENT country code (1-3 digits, not starting 0);
--   * after its country code, phone_web has exactly the same digits as
--     phone_maps. Same line, wrong country prefix.
--
-- That matched 10 rows in production: 8 French and 2 German shops inside Swiss
-- city radii.
--
-- NOT REPAIRED, on purpose. These need a person:
--   * 3 rows whose phone_web has the wrong country code but is a DIFFERENT line
--     from the one Google lists. One of them is the order #2000034 florist,
--     whose own site lists its Annemasse sibling branch's number. Rewriting
--     them would guess which line is right. Find them with:
--       select id, name, address, phone_web, phone_maps from florists
--       where phone_web like '+41%' and deleted_at is null
--         and (address ilike '%, Frankreich' or address ilike '%, France'
--              or address ilike '%, Deutschland');
--   * 1 row whose phone_web is malformed ("+0" followed by a French local
--     number). Its digits match Google's number, but it is not wrong-country
--     corruption and the app's phone parser rejects it, so it is left for a
--     person rather than folded in here.
-- ---------------------------------------------------------------------------
with
names(name, alpha2) as (values
  ('france', 'FR'), ('frankreich', 'FR'),
  ('allemagne', 'DE'), ('deutschland', 'DE'),
  ('españa', 'ES'), ('spain', 'ES'),
  ('portugal', 'PT'), ('brasil', 'BR'),
  ('argentina', 'AR'), ('colombia', 'CO'), ('perú', 'PE'), ('uruguay', 'UY'),
  ('república dominicana', 'DO'),
  ('österreich', 'AT'),
  ('schweiz', 'CH'), ('switzerland', 'CH'),
  ('maroc', 'MA'), ('تونس', 'TN'),
  ('andorra', 'AD')
),
calling_code(alpha2, cc) as (values
  ('FR', '33'), ('DE', '49'), ('ES', '34'), ('PT', '351'), ('BR', '55'),
  ('AR', '54'), ('CO', '57'), ('PE', '51'), ('UY', '598'), ('DO', '1'),
  ('AT', '43'), ('CH', '41'), ('MA', '212'), ('TN', '216'), ('AD', '376')
),
segments as (
  select f.id, trim(s.part) as seg,
         row_number() over (partition by f.id order by s.ord desc) as from_end
  from florists f
  cross join lateral unnest(string_to_array(f.address, ',')) with ordinality as s(part, ord)
  where f.deleted_at is null
    and f.address is not null
    and f.phone_web like '+%'
    and f.phone_maps like '+%'
    and trim(s.part) <> ''
),
shop_country as (
  select distinct on (sg.id) sg.id, n.alpha2
  from segments sg
  join names n on n.name = lower(sg.seg)
  where sg.from_end <= 3
  order by sg.id, sg.from_end
),
candidates as (
  select f.id, f.phone_web, f.phone_maps, cc.cc,
         regexp_replace(f.phone_web, '\D', '', 'g') as web_digits,
         regexp_replace(f.phone_maps, '\D', '', 'g') as maps_digits
  from florists f
  join shop_country sc on sc.id = f.id
  join calling_code cc on cc.alpha2 = sc.alpha2
)
update florists f
set phone_web = c.phone_maps
from candidates c
where f.id = c.id
  and f.phone_web = c.phone_web
  and c.maps_digits like c.cc || '%'
  and c.web_digits not like c.cc || '%'
  and left(c.web_digits, 1) <> '0'
  and length(c.web_digits) - (length(c.maps_digits) - length(c.cc)) between 1 and 3
  and right(c.web_digits, length(c.maps_digits) - length(c.cc)) = substr(c.maps_digits, length(c.cc) + 1);

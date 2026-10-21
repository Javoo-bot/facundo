-- Reach Out campaign configuration: the two settings the campaign CANNOT be run
-- without, recorded as a migration so no environment depends on someone
-- remembering to click them.
--
-- This is a DATA migration, which this repo already uses where a setting has a
-- correct value rather than a preference (2026-08-06-matching-config.sql,
-- 2026-08-10-auto-approve-payouts.sql, 2026-08-13-tier2-70-30-policy.sql do the
-- same). It exists because these two were applied to staging BY HAND on
-- 2026-09-10, which left staging in a state the repo could not reproduce — the
-- exact drift this file removes.
--
-- ---------------------------------------------------------------------------
-- WHAT IS DELIBERATELY *NOT* HERE
--
-- `sequence_enabled` and `sequence_auto_enrol_scraped` stay untouched. They are
-- the two switches that actually start sending, and 2026-08-08-sequence-
-- enrolments.sql promises that merging a migration "cannot start emailing
-- anybody". A migration that flips them would send mail the moment it is
-- applied, to whoever happens to be enrolled, with no human in the loop. They
-- are turned on from /settings, deliberately, by a person who is watching.
--
-- Everything in this file is therefore inert until someone flips those.

-- ---------------------------------------------------------------------------
-- 1. No daily ceiling.
--
-- The campaign mails every shop a scrape finds; a 1,500-shop scrape sends 1,500
-- emails, and Resend was upgraded for that volume. NULL means unlimited;
-- 0 would mean the kill switch, which is why this is NULL and not 0. Requires
-- 2026-09-10-uncapped-recruiting-sends.sql to have dropped the NOT NULL first.
update app_settings
   set sequence_daily_send_cap = null
 where id = 1;

-- ---------------------------------------------------------------------------
-- 2. Scope auto-enrol to Spain.
--
-- THIS LINE IS A SAFETY GATE, not a preference. `sequence_auto_enrol_scraped`
-- is a GLOBAL switch: with no country list it enrols every freshly scraped shop
-- in every country. Measured on production 2026-09-14, the shops that would
-- enrol on the first tick with no scope are:
--
--     PL 175 · CH 164 · DK 158 · IL 120 · FR 86 · SE 27 · ES 23
--
-- i.e. ~753 shops of which Spain is 23 — 3% of its own campaign — and with the
-- ceiling removed above, nothing would slow that down. Setting the scope BEFORE
-- the switch can be flipped is what closes that hole.
--
-- ---- FRANCE
--
-- France is now a target market and is already the largest country in the
-- database (4,635 shops, 914 mailable, vs Spain's 1,738 and 351). It is
-- deliberately NOT in this list yet, because the campaign starting 2026-09-15
-- is the 50-Spanish-city scrape, and adding 'FR' here would enrol 86 French
-- shops on the first tick — a send that cannot be taken back. Widening the
-- scope is one word; narrowing it after the mail has gone is impossible.
--
-- To add France, change the array to array['ES','FR'] — and note first that the
-- only active persona is `Marta Ruiz` at locale `en`, so a French shop gets the
-- localized COPY but an English-locale persona signature (personas.ts falls
-- back to the default locale). Worth adding an `fr` persona row first.
update app_settings
   set sequence_auto_enrol_countries = array['ES']
 where id = 1;

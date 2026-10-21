-- Let the recruiting funnel send without a daily ceiling.
--
-- WHY THIS IS A SCHEMA CHANGE AND NOT JUST A BIGGER NUMBER
--
-- `sequence_daily_send_cap` is `integer not null default 200`, so there has
-- never been a way to express "no limit" — only a larger number, which is a
-- limit someone has to remember to raise again. The Reach Out campaign starting
-- 2026-09-15 scrapes 50 Spanish cities and mails every shop it finds; the
-- operator's instruction is that a 1,500-shop scrape sends 1,500 emails, and
-- Resend has been upgraded specifically so that volume is within plan. A cap
-- that stops the campaign at 200 and reports "daily cap achieved" is then not a
-- safety feature, it is the bug.
--
-- NULL now means UNLIMITED. Nullable rather than a sentinel like -1 because
-- `budget = cap - sentToday` has to stop meaning anything at all in that mode,
-- and a NULL that the code must explicitly branch on is much harder to
-- accidentally treat as arithmetic than a negative number is.
--
-- ZERO STILL MEANS ZERO. This is the important half. 0 is the kill switch —
-- "stop sending right now" — and it stays exactly that. Overloading 0 to mean
-- "unlimited" would turn the one control someone reaches for in a panic into
-- the opposite of what they intended, which is the worst failure this file
-- could ship. The three states are:
--
--   NULL  -> no ceiling; send everything that is due
--   0     -> send nothing (kill switch)
--   n > 0 -> stop after n recruiting sends today, as before
--
-- No existing row changes. The column keeps its 200 default, so anything that
-- inserts a settings row without an opinion still gets a bounded one, and every
-- row that exists today keeps the number it already had. Going uncapped is a
-- deliberate UPDATE, not a side effect of running this migration.
alter table app_settings
  alter column sequence_daily_send_cap drop not null;

comment on column app_settings.sequence_daily_send_cap is
  'Recruiting sends allowed per UTC day, counted across the tick''s own steps and the manual /discovery send. NULL = NO LIMIT (send everything due). 0 = send nothing, the kill switch — deliberately NOT the same as NULL. A positive number is the blast-radius guard it always was: a scheduling bug cannot empty the prospect list into one afternoon. See dashboard/lib/sequences/tick.ts.';

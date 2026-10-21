-- Communications hub: capture the rendered HTML of the actual email sent,
-- not just the plain-text `subject`/`body` already logged. Closes the gap
-- where staff could see what an email said but not the real branded markup
-- that landed in the recipient's inbox (/communications log + the per-order
-- communications section). Additive, nullable — push rows never have HTML
-- (there's nothing to render), and historical email rows sent before this
-- column existed stay null; both the UI and lib/communicationsRow.ts treat
-- null as "no preview available", not an error.
alter table communications add column if not exists html text;

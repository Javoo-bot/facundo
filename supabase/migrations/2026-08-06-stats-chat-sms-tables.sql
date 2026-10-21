-- Teach the Statistics chat about the SMS half of messaging.
--
-- WHY: asked "which florists clicked sms?", the chat answered that the data
-- doesn't exist. It was telling the truth about its own instructions and
-- wrong about the database. `short_links` (2026-08-05-url-shortener) has
-- recorded per-florist link hits since 05 Aug, and `sms_events`
-- (2026-08-06-sms-events) has recorded Telnyx delivery receipts since 06 Aug.
-- Neither was added to the chat's advertised schema or to the `stats_reader`
-- grant list, so `get_messaging_stats` counts SMS clicks on the /statistics
-- dashboard while the chat sitting on the same page denies they are counted at
-- all.
--
-- Extends the allowlist in 2026-08-05-stats-reader-role.sql from 13 tables to
-- 15. That file's KEEP IN SYNC pairing still holds — the list the chat is told
-- about (SCHEMA_CONTEXT in dashboard/lib/statsChat.ts) and the list the
-- database enforces (the grants there plus the grants here) move together.
--
-- ---------------------------------------------------------------------------
-- COLUMN-level grants, not table-level, and that distinction is the whole
-- point.
--
-- Every other table in the allowlist is granted whole. These two cannot be,
-- because three of their columns are live credentials:
--
--   * short_links.code — mounted at the site root, it fronts a one-click
--     magic-link login to a real shop. This is why the table has RLS enabled
--     with no policy at all, and why lib/candidateEngagement.ts reads it with
--     the service key and returns only derived booleans rather than opening it
--     up. See the table comment in 2026-08-05-short-links.sql.
--   * short_links.target_url — contains that same magic token, unshortened.
--   * sms_events.raw — the verbatim Telnyx webhook body, whose message text is
--     the SMS we sent, which for an offer contains the short link again.
--
-- stats_reader's output is printed into a chat transcript by an LLM. A
-- table-level grant here would let "show me the short links we sent" return
-- working logins to florist accounts. Naming the columns keeps the click
-- SIGNAL (who, when, how many hits) and leaves the credential behind.
--
-- Consequence worth knowing: `select * from short_links` now fails with
-- "permission denied for column code" rather than returning rows. That is the
-- intended behaviour, and SCHEMA_CONTEXT tells the model to name columns.
--
-- NOT fixed here, deliberately — see the PR: `communications.body` is granted
-- table-wide to stats_reader today and 35 of the 39 SMS rows in it contain a
-- live short link. Closing that means converting `communications` and
-- `florists` (which likewise expose `join_token` / `unsubscribe_token`) to
-- enumerated column grants, which is a larger change with its own review.
-- ---------------------------------------------------------------------------

-- 14. short_links — the SMS click signal. `kind = 'magic'` is the offer link;
-- `kind = 'unsub'` is the unsubscribe link, which is an opt-out rather than
-- engagement (get_messaging_stats excludes it from the click count for exactly
-- that reason, and the chat is told the same).
grant select (florist_id, assignment_id, kind, created_at,
              hit_count, first_hit_at, last_hit_at)
  on short_links to stats_reader;

-- 15. sms_events — Telnyx delivery receipts, the SMS analogue of email_events.
grant select (id, communication_id, event_type, provider_event_id,
              error_code, error_detail, occurred_at)
  on sms_events to stats_reader;

-- Note on RLS, since short_links has none: the table is RLS-enabled with no
-- policy, i.e. service-role only, and stats_reader carries BYPASSRLS (load
-- bearing — see section 1 of the stats-reader-role migration; without it no
-- policy would ever match a roleless, JWT-less role and every analytics query
-- would return zero rows). So this grant, not a policy, is what makes the
-- table readable, and the column list above is the entire boundary. That is
-- the same posture the rest of the allowlist has; it is only stated here
-- because this is the first table in it with no staff-facing policy to fall
-- back on.

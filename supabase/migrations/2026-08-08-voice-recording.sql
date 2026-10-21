-- Call recording + transcripts, and the controls that make them defensible.
--
-- Recording a call is lawful in every market this targets WHEN both parties are
-- notified. The whole risk sits in that condition, so the schema is arranged so
-- that a recording without a notice is not a state the system can reach:
-- `notice_played` is NOT NULL, and lib/voice/recordingPolicy.ts refuses to
-- start a recording it cannot render a notice for.
--
-- A recording of a named person talking about their business is personal data
-- under GDPR. That brings three obligations this migration exists to support:
-- a retention limit (Art. 5(1)(e)), the ability to delete on request
-- (Art. 17), and access limited to people who need it.

alter table voice_calls
  -- What the caller was actually told, verbatim, in their language. Stored
  -- rather than referenced: the notice copy is editable from /messages, and an
  -- audit two years from now needs the words that were used on the day, not
  -- whatever the catalog says by then.
  add column if not exists notice_text text,
  -- Whether the notice covering AI + recording was completed BEFORE recording
  -- started. Recorded per call as a fact, never inferred from configuration.
  add column if not exists notice_played boolean not null default false,
  add column if not exists recording_url text,
  -- When this recording and transcript must be gone. Set at call time from
  -- app_settings.voice_retention_days so a policy change never silently
  -- extends the life of data already collected under the old one.
  add column if not exists retain_until timestamptz,
  add column if not exists purged_at timestamptz;

comment on column voice_calls.notice_played is
  'Whether the caller heard the AI + recording notice before recording began. A recording with this false is a compliance incident, not a data problem — lib/voice/recordingPolicy.ts is written so it cannot happen, and this column is how that is proved afterwards.';

comment on column voice_calls.retain_until is
  'Hard deletion deadline for recording_url + transcript. Stamped at call time from the then-current retention setting, so shortening the policy later shortens the life of NEW recordings without retroactively extending old ones.';

comment on column voice_calls.purged_at is
  'When the audio and transcript were actually deleted. The call row survives with its outcome and duration — those are business records, not personal content — so statistics stay honest after a purge.';

create index if not exists voice_calls_purge_due
  on voice_calls (retain_until) where purged_at is null and retain_until is not null;

alter table app_settings
  -- Ships DARK, like every other channel here.
  add column if not exists voice_enabled            boolean not null default false,
  add column if not exists voice_record_audio       boolean not null default false,
  add column if not exists voice_transcribe         boolean not null default true,
  -- Per-market override, because the legal position on recording differs by
  -- country and counsel may clear some before others. ISO alpha-2 -> boolean;
  -- a country absent from the map falls back to voice_record_audio.
  add column if not exists voice_record_by_country  jsonb not null default '{}'::jsonb,
  add column if not exists voice_retention_days     integer not null default 90,
  add column if not exists voice_daily_call_cap     integer not null default 50,
  add column if not exists voice_max_call_seconds   integer not null default 300;

comment on column app_settings.voice_record_by_country is
  'ISO alpha-2 -> boolean override for audio recording, so a market can be switched off without a deploy and without stopping calls elsewhere. Read by lib/voice/recordingPolicy.ts, which treats an unparseable value as "do not record" — the safe direction.';

comment on column app_settings.voice_retention_days is
  'How long a recording and transcript are kept. GDPR Art. 5(1)(e): personal data may not be kept longer than necessary, and "forever" is never a defensible answer for a recording of somebody''s voice.';

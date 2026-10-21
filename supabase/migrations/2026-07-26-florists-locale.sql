-- Florist-facing email localization (dashboard/lib/i18n). Nullable, additive:
-- unset means "unknown", and lib/i18n's resolveFloristLocale() falls back to
-- EN for null/invalid values, so this never breaks an existing send.
alter table florists add column if not exists locale text;

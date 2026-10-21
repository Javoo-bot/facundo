# Side-project Supabase

Project `your-project-ref` (eu-central-1) holds a copy of Facundo staging,
taken from the `pg_dump` of 2026-10-11 11:14.

## Rebuild it from a backup

```bash
npm install
node staging-import.mjs build <dump.sql>                       # writes migrations/<version>_baseline_from_staging.sql
node --env-file=../../.env staging-import.mjs load <dump.sql>  # applies the migration, then loads the data
node --env-file=../../.env verify.mjs                          # fails on a real email or a live token
```

`load` is safe to rerun. It skips the migration once it is recorded in
`supabase_migrations.schema_migrations`, and it resumes each table from the
row count already there.

## What the copy changes

- Every email outside `facundo.*` keeps its address but gets the TLD
  `.example`, so `ana@gmail.com` becomes `ana@gmail.example`. Nothing can be
  mailed to a real customer or florist.
- Every account's password is `SUPABASE_MOCK_USER_PASSWORD` from `.env`.
- Not copied: auth sessions, refresh tokens and user tokens, florist
  magic-login tokens, push subscriptions, and vault secrets.
- Phone numbers, names and addresses are copied as they are. Do not point
  SMS sending (Telnyx) at this database.

## Connecting

Use the transaction pooler: host `aws-0-your-region.pooler.supabase.com`,
port `6543`, user `postgres.your-project-ref`. The direct host is
IPv6-only. On the office network, port 5432 is reset, and `COPY ... FROM
STDIN` and large statements stall. That is why the loader inserts small
batches instead of streaming `COPY`.

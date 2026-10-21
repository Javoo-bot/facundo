// node --env-file=<repo>/.env verify.mjs   fails if a deliverable non-facundo email or a live credential is in the loaded data
import pg from 'pg';
const ref = new URL(process.env.SUPABASE_CONNECTION_STRING.replace('[YOUR-PASSWORD]', 'x')).hostname.split('.')[1];
const c = new pg.Client({ host: 'aws-0-your-region.pooler.supabase.com', port: 6543, user: `postgres.${ref}`, password: process.env.SUPABASE_DATABASE_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false } });
await c.connect();
const EMAIL = /([A-Za-z0-9._%+-]+)@((?:[A-Za-z0-9-]+\.)+)([A-Za-z]{2,24})(?![A-Za-z0-9-])/g;
const cols = (await c.query(`select table_schema || '.' || table_name t, column_name col from information_schema.columns
  where (table_schema = 'public' or (table_schema = 'auth' and table_name in ('users', 'identities')))
  and data_type in ('text', 'character varying', 'json', 'jsonb', 'ARRAY')
  and (table_schema, table_name) in (select schemaname, tablename from pg_tables)`)).rows.map((r) => [r.t, r.col]);
const found = new Map();
for (const [t, col] of cols) {
  const { rows } = await c.query(`select "${col}"::text v from ${t} where "${col}"::text like '%@%'`);
  for (const { v } of rows) for (const m of v.matchAll(EMAIL)) {
    const domain = (m[2] + m[3]).toLowerCase();
    if (/(^|\.)facundo\.[a-z]+$/.test(domain) || m[3].toLowerCase() === 'example') continue;
    const k = `${t}.${col}  …@${domain}`;
    found.set(k, (found.get(k) ?? 0) + 1);
  }
}
for (const [k, n] of found) console.log(String(n).padStart(4), k);
const leftover = [...found.values()].reduce((a, b) => a + b, 0);
const tokens = (await c.query(`select (select count(*) from auth.sessions) + (select count(*) from auth.refresh_tokens)
  + (select count(*) from public.florist_magic_tokens) + (select count(*) from public.push_subscriptions) + (select count(*) from vault.secrets) n`)).rows[0].n;
console.log(`${cols.length} text columns scanned; deliverable non-facundo emails: ${leftover}; live tokens: ${tokens}`);
if (leftover || +tokens) process.exitCode = 1;
await c.end();

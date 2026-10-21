// Applies agents/monitoring/schema.sql (and the factory schema it depends on)
// to the garden database, and makes sure Grafana's read-only role exists.
//
//   SUPABASE_DATABASE_PASSWORD=... GRAFANA_DB_PASSWORD=... node agents/monitoring/apply.mjs
//
// Garden only: it connects to the side project's pooler and nowhere else.
// The default transaction there is read-only, so each file runs inside
// `begin read write`.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { Client } = createRequire(join(here, "../supabase/package.json"))("pg");

export const GARDEN_POOLER = { host: "aws-0-your-region.pooler.supabase.com", port: 6543, database: "postgres" };
export const GARDEN_REF = "your-project-ref";

export async function gardenPg(user, password) {
  if (!password) throw new Error(`no password for ${user}`);
  const client = new Client({ ...GARDEN_POOLER, user: `${user}.${GARDEN_REF}`, password, ssl: { rejectUnauthorized: false }, statement_timeout: 120_000 });
  await client.connect();
  return client;
}

async function grafanaRole(db, password) {
  // The password is passed as a literal because DDL takes no bind parameters.
  const literal = `'${password.replaceAll("'", "''")}'`;
  const [{ exists }] = (await db.query("select exists (select 1 from pg_roles where rolname = 'grafana_ro')")).rows;
  // Supabase's postgres is not a superuser, so it may not name NOSUPERUSER on
  // ALTER; CREATE gives the restricted attributes once.
  await db.query(exists
    ? `alter role grafana_ro with login password ${literal}`
    : `create role grafana_ro with login password ${literal} nosuperuser nocreatedb nocreaterole noinherit nobypassrls connection limit 10`);
  await db.query("alter role grafana_ro set default_transaction_read_only = on");
  await db.query("alter role grafana_ro set statement_timeout = '30s'");
  await db.query("grant usage on schema public to grafana_ro");
  return exists ? "updated" : "created";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = await gardenPg("postgres", process.env.SUPABASE_DATABASE_PASSWORD);
  try {
    await db.query("begin read write");
    if (process.env.GRAFANA_DB_PASSWORD) console.log(`grafana_ro role ${await grafanaRole(db, process.env.GRAFANA_DB_PASSWORD)}`);
    for (const file of ["../factory/schema.sql", "schema.sql"]) {
      await db.query(readFileSync(join(here, file), "utf8"));
      console.log(`applied ${file}`);
    }
    await db.query("commit");
  } catch (e) {
    await db.query("rollback").catch(() => {});
    throw e;
  } finally {
    await db.end();
  }
}

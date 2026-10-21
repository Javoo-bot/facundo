// Supabase side: apply the knowledge migration once, upsert changed documents, vector search.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const EMBEDDING_MODEL = 'perplexity/pplx-embed-v1-0.6b';
const MIGRATION = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations', '20261012100000_knowledge_base.sql');
const VERSION = '20261012100000';

export async function connect() {
  const ref = new URL(process.env.SUPABASE_CONNECTION_STRING.replace('[YOUR-PASSWORD]', 'x')).hostname.split('.')[1];
  const c = new pg.Client({
    host: process.env.SUPABASE_POOLER_HOST ?? 'aws-0-your-region.pooler.supabase.com', port: 6543,
    user: `postgres.${ref}`, password: process.env.SUPABASE_DATABASE_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false },
    query_timeout: 120_000,
  });
  c.on('error', () => {});
  await c.connect();
  return c;
}

export async function embed(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 32) {
    const r = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts.slice(i, i + 32) }),
    });
    if (!r.ok) throw new Error(`embeddings ${r.status}: ${(await r.text()).slice(0, 160)}`);
    out.push(...(await r.json()).data.sort((a, b) => a.index - b.index).map((d) => d.embedding));
  }
  return out;
}

const hash = (d) => crypto.createHash('sha256').update(`${EMBEDDING_MODEL}\n${d.text}\n${d.authority}\n${d.reviewed}\n${d.outcome}`).digest('hex');
const vec = (v) => `[${v.join(',')}]`;

export async function migrate(c) {
  await c.query('create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text)');
  if ((await c.query('select 1 from supabase_migrations.schema_migrations where version = $1', [VERSION])).rowCount) return false;
  await c.query('begin');
  await c.query(fs.readFileSync(MIGRATION, 'utf8'));
  await c.query(`insert into supabase_migrations.schema_migrations (version, name) values ($1, 'knowledge_base')`, [VERSION]);
  await c.query('commit');
  return true;
}

/** Converges the table to `docs`: embeds only new or changed rows, deletes rows whose source item is gone. */
export async function sync(c, docs) {
  const existing = new Map((await c.query('select ref, content_hash from knowledge_chunks')).rows.map((r) => [r.ref, r.content_hash]));
  const changed = docs.filter((d) => existing.get(d.ref) !== hash(d));
  const vectors = await embed(changed.map((d) => d.text));
  for (const [i, d] of changed.entries()) {
    await c.query(
      `insert into knowledge_chunks (source, authority, ref, title, content, language, source_version, outcome, reviewed, is_public, content_hash, embedding_model, embedding, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::extensions.vector, now())
       on conflict (ref) do update set source = excluded.source, authority = excluded.authority, title = excluded.title, content = excluded.content,
         language = excluded.language, source_version = excluded.source_version, outcome = excluded.outcome, is_public = excluded.is_public,
         reviewed = knowledge_chunks.reviewed or excluded.reviewed, content_hash = excluded.content_hash,
         embedding_model = excluded.embedding_model, embedding = excluded.embedding, updated_at = now()`,
      [d.source, d.authority, d.ref, d.title, d.text, d.language, d.version, d.outcome, d.reviewed, d.isPublic ?? null, hash(d), EMBEDDING_MODEL, vec(vectors[i])],
    );
  }
  const keep = docs.map((d) => d.ref);
  const removed = (await c.query('delete from knowledge_chunks where not (ref = any($1)) returning ref', [keep])).rowCount;
  return { changed: changed.length, unchanged: docs.length - changed.length, removed };
}

export async function search(c, question, k = 5) {
  const [v] = await embed([question]);
  return (await c.query('select * from match_knowledge($1::extensions.vector, $2)', [vec(v), k])).rows;
}

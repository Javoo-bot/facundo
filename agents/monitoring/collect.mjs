// Copies the Langfuse runs that some measures are computed from (Babel, Bloom,
// Oracle, Polyglot) into the garden table agent_trace_runs, where the views in
// schema.sql turn them into cases. Rerunning refreshes the same rows.
//
//   LANGFUSE_PUBLIC_KEY=... LANGFUSE_SECRET_KEY=... LANGFUSE_BASE_URL=... \
//   GARDEN_SUPABASE_URL=... GARDEN_SUPABASE_SERVICE_ROLE_KEY=... node agents/monitoring/collect.mjs [--days 35]
//
// Only the garden sends traces, so this only ever reads the garden's project.

import { fileURLToPath } from "node:url";
import { gardenRest } from "./garden-rest.mjs";
import { TRACED_RUNS, traceRow } from "./external-rows.mjs";

const DAY_MS = 86_400_000;

async function rootRuns(name, from, { base, auth }) {
  const out = [];
  let cursor;
  do {
    const u = new URL(`${base}/api/public/v2/observations`);
    u.searchParams.set("name", name);
    u.searchParams.set("fromStartTime", from);
    u.searchParams.set("fields", "core,basic,io,metadata");
    u.searchParams.set("limit", "500");
    if (cursor) u.searchParams.set("cursor", cursor);
    const res = await fetch(u, { headers: { Authorization: auth }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Langfuse ${name}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const page = await res.json();
    out.push(...page.data.filter((o) => o.isRootObservation !== false && !o.parentObservationId));
    cursor = page.data.length ? page.meta?.cursor : null;
  } while (cursor);
  return out;
}

export async function collectTraces(db, { days = 35, env = process.env } = {}) {
  const { LANGFUSE_PUBLIC_KEY: pub, LANGFUSE_SECRET_KEY: secret, LANGFUSE_BASE_URL: base = "https://cloud.langfuse.com" } = env;
  if (!pub || !secret) return { skipped: "LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set" };
  const lf = { base, auth: `Basic ${Buffer.from(`${pub}:${secret}`).toString("base64")}` };
  const from = new Date(Date.now() - days * DAY_MS).toISOString();
  const counts = {};
  for (const name of TRACED_RUNS) {
    const rows = (await rootRuns(name, from, lf)).map(traceRow);
    await db.upsert("agent_trace_runs", rows.map((r) => ({ ...r, fetched_at: new Date().toISOString() })), "trace_id");
    counts[name] = rows.length;
  }
  return { counts };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--days");
  const out = await collectTraces(gardenRest(), { days: i > 0 ? Number(process.argv[i + 1]) : 35 });
  console.log(out.skipped ? `Langfuse runs not copied: ${out.skipped}` : `Langfuse runs copied: ${JSON.stringify(out.counts)}`);
}

// The garden database over Supabase REST with the service role. Used by the
// scripts that run on GitHub, where only the REST pair is a secret. Refuses
// any URL but the side project's.

import { assertGardenUrl } from "../factory/cards.mjs";

const PAGE = 1000;

export function gardenRest(url = process.env.GARDEN_SUPABASE_URL, key = process.env.GARDEN_SUPABASE_SERVICE_ROLE_KEY) {
  assertGardenUrl(url ?? "");
  if (!key) throw new Error("GARDEN_SUPABASE_SERVICE_ROLE_KEY is not set");
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

  async function rest(method, path, body, extra = {}) {
    const res = await fetch(`${url}/rest/v1/${path}`, {
      method, headers: { ...headers, ...extra }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const err = new Error(`${method} ${path.split("?")[0]}: ${res.status} ${await res.text()}`);
      err.status = res.status;
      throw err;
    }
    if (res.status === 204 || res.headers.get("content-length") === "0") return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async function selectAll(path) {
    const out = [];
    for (let from = 0; ; from += PAGE) {
      const rows = await rest("GET", path, undefined, { Range: `${from}-${from + PAGE - 1}`, "Range-Unit": "items" });
      out.push(...rows);
      if (rows.length < PAGE) return out;
    }
  }

  // Insert or replace on the table's primary key, in batches.
  async function upsert(table, rows, onConflict) {
    for (let i = 0; i < rows.length; i += 500) {
      await rest("POST", `${table}?on_conflict=${onConflict}`, rows.slice(i, i + 500), { Prefer: "resolution=merge-duplicates,return=minimal" });
    }
  }

  return { rest, selectAll, upsert };
}

export const inList = (xs) => `(${xs.map((x) => `"${String(x).replaceAll('"', '\\"')}"`).join(",")})`;

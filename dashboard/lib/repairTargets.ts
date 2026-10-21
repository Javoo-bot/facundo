// Which florists an enrichment repair would act on, and how they group by city.
//
// The predicate is the dashboard-side mirror of
// ingest-worker/src/repair.ts::REPAIR_FAILURE_PATTERNS. It exists here so the
// buttons can say what they will actually do ("1,732 florists across 60
// cities") before anyone clicks, and so "Repair all" enqueues exactly the
// cities that have work rather than every city on file.
//
// Kept in lockstep with the worker's copy by lib/repairTargets.test.mjs — a
// dashboard that counted a different population than the worker repairs would
// promise numbers it can't deliver.

import type { SupabaseClient } from "@supabase/supabase-js";

/** Substrings in `enrichment_notes` that mean the last enrichment FAILED,
 * rather than succeeding and finding nothing. Mirrors the worker's
 * REPAIR_FAILURE_PATTERNS exactly. */
export const REPAIR_FAILURE_PATTERNS = ["failed", "unreachable", "time budget"] as const;

/** Mirrors ingest-worker/src/repair.ts::UNCHECKED_NOTES_PREFIX exactly — the
 * free-place-layer import's "Unchecked ..." placeholder, which means the same
 * thing as null notes (enrichment never ran). */
export const UNCHECKED_NOTES_PREFIX = "unchecked";

/** PostgREST `or=` filter for "the last enrichment did not produce an answer".
 *
 * Three cases — notes that RECORD a failure, the free-layer import's
 * "Unchecked ..." placeholder, and no notes at all, which means enrichment
 * never reached the row (bare rows are written at step [6/8] and enriched at
 * [7/8]; a run that dies between them leaves NULL notes forever). Mirrors
 * ingest-worker/src/repair.ts::repairNotesFilter exactly. */
export function repairNotesFilter(): string {
  return [
    "enrichment_notes.is.null",
    `enrichment_notes.ilike.${UNCHECKED_NOTES_PREFIX}*`,
    ...REPAIR_FAILURE_PATTERNS.map((p) => `enrichment_notes.ilike.*${p}*`),
  ].join(",");
}

export interface RepairCityCount {
  cityId: string;
  country: string;
  city: string;
  florists: number;
}

/** Repairable florists per city, largest cities last so a caller that runs
 * them in order gets its cheap canary first. Cities with no repairable rows
 * are absent, never present with a zero. */
export async function repairTargetsByCity(sb: SupabaseClient): Promise<RepairCityCount[]> {
  // Paged: a silently truncated count would understate the work and, worse,
  // make "Repair all" quietly skip cities.
  const counts = new Map<string, number>();
  const pageSize = 1000;
  for (let page = 0; ; page++) {
    const { data, error } = await sb
      .from("florists")
      .select("city_id")
      .not("website_url", "is", null)
      .is("email", null)
      .is("deleted_at", null)
      .is("excluded_at", null)
      .or(repairNotesFilter())
      .range(page * pageSize, page * pageSize + pageSize - 1);
    if (error) throw error;
    const batch = (data ?? []) as Array<{ city_id: string | null }>;
    for (const row of batch) {
      if (row.city_id) counts.set(row.city_id, (counts.get(row.city_id) ?? 0) + 1);
    }
    if (batch.length < pageSize) break;
  }
  if (counts.size === 0) return [];

  // `in.(...)` has a practical URL-length ceiling, so resolve names in chunks.
  const ids = [...counts.keys()];
  const names = new Map<string, { country: string; city: string }>();
  for (let i = 0; i < ids.length; i += 50) {
    const { data, error } = await sb
      .from("cities")
      .select("id, country, city")
      .in("id", ids.slice(i, i + 50));
    if (error) throw error;
    for (const c of (data ?? []) as Array<{ id: string; country: string; city: string }>) {
      names.set(c.id, { country: c.country, city: c.city });
    }
  }

  const rows: RepairCityCount[] = [];
  for (const [cityId, florists] of counts) {
    const n = names.get(cityId);
    // A florist whose city row has vanished can't be addressed by a per-city
    // job, so it is dropped rather than counted into a total nothing will run.
    if (n) rows.push({ cityId, country: n.country, city: n.city, florists });
  }
  return rows.sort((a, b) => a.florists - b.florists);
}

/** Repairable florists in ONE city. Powers the city page's button label and
 * its disabled state. */
export async function repairTargetCount(sb: SupabaseClient, cityId: string): Promise<number> {
  const { count, error } = await sb
    .from("florists")
    .select("id", { count: "exact", head: true })
    .eq("city_id", cityId)
    .not("website_url", "is", null)
    .is("email", null)
    .is("deleted_at", null)
    .is("excluded_at", null)
    .or(repairNotesFilter());
  if (error) throw error;
  return count ?? 0;
}

// Sherlock's only source of real daily cases until the paid check exists.
//
// The free-place-layer import (Overture Maps, no Apify, no Claude — see
// docs/agent-factory/tasks/002-free-florist-layer.md) seeds florists with
// website_url set and enrichment_notes left at a placeholder ("Unchecked —
// email, phone and owner unknown until the paid check."). Nothing ever ran
// Sherlock on them. Once a day, queue a `repair` ingest job (no Apify —
// workflow.ts::runRepair just re-crawls and re-asks) for every city that still
// has some: the existing repair pipeline reads each shop's own site directly
// via enrich.ts and writes back whatever it finds.
//
// Deliberately narrower than repair.ts's general repairNotesFilter: this is an
// UNATTENDED daily cron, so it only ever selects the free-layer "Unchecked"
// population, never the wider failed/never-reached backlog a human triggers
// by hand from the dashboard's "Repair" button. A city whose free-layer rows
// get folded in via that broader button is still fine — same job, same cost
// per florist — this just keeps the unattended path's blast radius to exactly
// what this card is about.
import type { SupabaseClient } from "@supabase/supabase-js";
import { captureError } from "./monitor";
import { UNCHECKED_NOTES_PREFIX } from "./repair";
import { GARDEN_DB } from "./gardenActors";
import type { Env } from "./types";

/** Once a day, at 06:10 UTC — clear of the weather plant (04:00), the garden
 * daily report (04:30) and the garden-actors ticks (minutes 5/15/25…). */
export function isSherlockDailyCasesMinute(scheduledTimeMs: number): boolean {
  const d = new Date(scheduledTimeMs);
  return d.getUTCHours() === 6 && d.getUTCMinutes() === 10;
}

/** Garden only. Production's SUPABASE_URL is never the garden database, and
 * the free-place-layer import only ever ran there. */
export function sherlockDailyCasesGate(env: Pick<Env, "SUPABASE_URL">): boolean {
  return env.SUPABASE_URL === `https://${GARDEN_DB}.supabase.co`;
}

export interface DailyCaseCity {
  country: string;
  city: string;
  florists: number;
}

/** Cities with at least one free-layer-imported florist still carrying the
 * "Unchecked" placeholder and a website to read. Paged for the same reason
 * repairTargetsByCity is: a silently truncated select understates the work. */
export async function findFreeLayerDailyCaseCities(sb: SupabaseClient): Promise<DailyCaseCity[]> {
  const counts = new Map<string, number>();
  const pageSize = 1000;
  for (let page = 0; ; page++) {
    const { data, error } = await sb
      .from("florists")
      .select("city_id")
      .not("website_url", "is", null)
      .ilike("enrichment_notes", `${UNCHECKED_NOTES_PREFIX}*`)
      .is("deleted_at", null)
      .is("excluded_at", null)
      .range(page * pageSize, page * pageSize + pageSize - 1);
    if (error) throw error;
    const batch = (data ?? []) as Array<{ city_id: string | null }>;
    for (const row of batch) {
      if (row.city_id) counts.set(row.city_id, (counts.get(row.city_id) ?? 0) + 1);
    }
    if (batch.length < pageSize) break;
  }
  if (counts.size === 0) return [];

  const ids = [...counts.keys()];
  const names = new Map<string, { country: string; city: string }>();
  for (let i = 0; i < ids.length; i += 50) {
    const { data, error } = await sb.from("cities").select("id, country, city").in("id", ids.slice(i, i + 50));
    if (error) throw error;
    for (const c of (data ?? []) as Array<{ id: string; country: string; city: string }>) {
      names.set(c.id, { country: c.country, city: c.city });
    }
  }

  const rows: DailyCaseCity[] = [];
  for (const [cityId, florists] of counts) {
    const n = names.get(cityId);
    if (n) rows.push({ country: n.country, city: n.city, florists });
  }
  return rows;
}

export interface DailyCasesResult {
  queued: string[];
  skipped: string[];
}

/** Queue one `repair` ingest job per city that still has free-layer
 * "Unchecked" targets, unless one is already queued or running there — the
 * same per-minute claim cron (cronClaim.ts) that every other ingest job uses
 * picks it up within a minute, no new execution path needed. Never throws:
 * same contract as autoIngest.ts::queueIngestForArea — a failure to queue
 * today's handful must not break the cron tick it shares. */
export async function enqueueSherlockDailyCases(sb: SupabaseClient): Promise<DailyCasesResult> {
  const queued: string[] = [];
  const skipped: string[] = [];

  let cities: DailyCaseCity[];
  try {
    cities = await findFreeLayerDailyCaseCities(sb);
  } catch (e) {
    captureError("cron.sherlock_daily_cases_select", e);
    return { queued, skipped };
  }

  for (const c of cities) {
    try {
      const { data: pending, error: pendingError } = await sb
        .from("ingest_jobs")
        .select("id")
        .eq("country", c.country)
        .eq("city", c.city)
        .in("status", ["queued", "running"])
        .limit(1);
      if (pendingError) {
        captureError("cron.sherlock_daily_cases_lookup", pendingError);
        skipped.push(c.city);
        continue;
      }
      if (pending && pending.length > 0) {
        skipped.push(c.city);
        continue;
      }
      // Same shape POST /api/ingest/repair writes — radius/keywords/language
      // are persisted for the row's shape only, repair mode reads none of them.
      const { error } = await sb.from("ingest_jobs").insert({
        country: c.country,
        city: c.city,
        radius_km: null,
        limit_per_keyword: null,
        keywords: null,
        language: null,
        reset_existing: false,
        mode: "repair",
        status: "queued",
      });
      if (error) {
        captureError("cron.sherlock_daily_cases_insert", error);
        skipped.push(c.city);
        continue;
      }
      queued.push(c.city);
    } catch (e) {
      captureError("cron.sherlock_daily_cases_city", e);
      skipped.push(c.city);
    }
  }

  return { queued, skipped };
}

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  parseTimingRows,
  parseEnabledRows,
  type StepConfigRow,
  type StepEnabled,
  type StepTiming,
} from "../flows/timing.ts";
import { parseCustomStepRows, type CustomStepRow } from "../flows/customSteps.ts";

export interface StepConfig {
  /** Waits staff have changed. A step with no entry runs on its code default. */
  timing: StepTiming;
  /** Steps staff have switched OFF. Only the off ones are listed. */
  enabled: StepEnabled;
  /** Touches staff have DUPLICATED. Injected into the sequence before any of
   *  the above is applied, so a copy is retimed and switched off by exactly
   *  the same machinery as a built-in step. */
  custom: CustomStepRow[];
}

/**
 * Everything staff have changed about the funnel steps, as two flat maps —
 * the single I/O seam for funnel configuration, deliberately kept out of the
 * pure lib/flows/timing.ts so the scheduler's arithmetic stays unit-testable
 * without a database.
 *
 * Best-effort, matching lib/messageOverrides.ts and the codebase's other
 * read-time helpers: any error (a blip, a table not migrated yet, an RLS
 * surprise) returns empty maps rather than throwing. That fails the SAFE way
 * in both directions — an unreadable table means every step runs on its code
 * default and nothing is silently switched off.
 *
 * One read per tick, not one per enrolment: the table has one row per step.
 * `admin` must be a service-role client.
 */
export async function loadStepConfig(admin: SupabaseClient): Promise<StepConfig> {
  try {
    const { data, error } = await admin
      .from("sequence_step_timing")
      .select("sequence_id,step_key,days,enabled");
    // Two reads, not a join: they are different grains (one row per step
    // that was CHANGED, one row per step that was ADDED) and a duplicate that
    // has never been retimed has no row in the first table at all.
    const { data: customData } = await admin
      .from("sequence_custom_steps")
      .select("sequence_id,step_key,source_step_key,after_step_key");
    const custom = parseCustomStepRows(customData as Record<string, unknown>[] | null);
    if (error || !data) return { timing: {}, enabled: {}, custom };
    const rows = data as StepConfigRow[];
    return { timing: parseTimingRows(rows), enabled: parseEnabledRows(rows), custom };
  } catch {
    return { timing: {}, enabled: {}, custom: [] };
  }
}

/** The keys the scheduler wants: the steps that are switched off. */
export function disabledStepKeys(config: StepConfig): Set<string> {
  return new Set(Object.keys(config.enabled).filter((k) => config.enabled[k] === false));
}

/** Waits only. Kept for the two call sites that park a `next_action_at` and
 *  have no use for the on/off flag. */
export async function loadStepTiming(admin: SupabaseClient): Promise<StepTiming> {
  return (await loadStepConfig(admin)).timing;
}

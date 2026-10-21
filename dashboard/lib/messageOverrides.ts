import type { SupabaseClient } from "@supabase/supabase-js";
import type { Locale } from "@/lib/i18n";

/**
 * Loads the DB overrides for ONE locale as a flat `{key: value}` map, for
 * layering on top of the static catalog via `tWithOverrides` — the single I/O
 * seam for message overrides, deliberately kept out of the pure lib/i18n core
 * so `t()`/`tWithOverrides`/`flattenKeys` stay unit-testable without a DB.
 *
 * Best-effort, matching the codebase's other read-time DB helpers (e.g.
 * lib/emailToggles.ts): any error (network blip, table not migrated yet, RLS
 * surprise) returns `{}` rather than throwing, so a DB hiccup degrades to "no
 * overrides" (the built-in copy still sends) instead of breaking a send.
 * `admin` must be a service-role client — see lib/supabaseAdmin.ts — callers
 * already hold one for the app_settings/florists reads alongside this.
 */
export async function loadOverrides(admin: SupabaseClient, locale: Locale): Promise<Record<string, string>> {
  try {
    const { data, error } = await admin.from("message_overrides").select("key,value").eq("locale", locale);
    if (error || !data) return {};
    const map: Record<string, string> = {};
    for (const row of data as { key: unknown; value: unknown }[]) {
      if (typeof row.key === "string" && typeof row.value === "string") map[row.key] = row.value;
    }
    return map;
  } catch {
    return {};
  }
}

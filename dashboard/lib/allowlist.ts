import { createServiceClient } from "@/lib/supabaseAdmin";
import type { StaffRole } from "./staffRoles";

/**
 * Allow-list check, backed by the `allowed_emails` table — the single
 * runtime source of truth for who may sign in and call any auth-gated route
 * (the same table also backs RLS via the `is_email_allowed()` SECURITY
 * DEFINER function; edits here take effect for both).
 *
 * SERVER-ONLY: this module imports the service-role client
 * (`lib/supabaseAdmin`) and must never be imported from a `"use client"`
 * file — doing so would pull the service-role key into the client bundle.
 *
 * FAIL-CLOSED: any DB error or thrown exception denies access. An outage or
 * misconfiguration must never accidentally open the door.
 */
export async function isAllowed(email: string | null | undefined): Promise<boolean> {
  if (!email) return false;
  try {
    const admin = createServiceClient();
    const { data, error } = await admin
      .from("allowed_emails")
      .select("email")
      .eq("email", email.toLowerCase())
      .limit(1);
    if (error) return false; // FAIL CLOSED
    return (data?.length ?? 0) > 0;
  } catch {
    return false; // FAIL CLOSED
  }
}

/**
 * Looks up the caller's permission level. Same fail-closed contract as
 * isAllowed: any DB error or exception returns null (no elevated role), never
 * throws. Callers must treat null as "no access to whatever this role gates."
 */
export async function getStaffRole(email: string | null | undefined): Promise<StaffRole | null> {
  if (!email) return null;
  try {
    const admin = createServiceClient();
    const { data, error } = await admin
      .from("allowed_emails")
      .select("role")
      .eq("email", email.toLowerCase())
      .limit(1);
    if (error) return null; // FAIL CLOSED
    return (data?.[0]?.role as StaffRole | undefined) ?? null;
  } catch {
    return null; // FAIL CLOSED
  }
}

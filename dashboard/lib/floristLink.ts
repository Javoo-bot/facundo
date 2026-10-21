import "server-only";
import type { createServiceClient } from "@/lib/supabaseAdmin";

// Linking a Supabase auth user to the florist record that shares its email.
//
// Extracted from app/florist/(app)/layout.tsx, which grew this logic inline
// when the florist PWA was the only way in. The magic-link redeem route
// (app/florist/m/[token]) needs the exact same step, and POST /api/florist/link
// had its own third copy — which inserted WITHOUT `email`, a column
// florist_users declares NOT NULL (supabase/migrations/2026-07-21-florist-team.sql),
// so that copy could only ever have thrown. One definition now.

type Admin = ReturnType<typeof createServiceClient>;

/**
 * Ensures a `florist_users` row maps `userId` to a florist, matching on email.
 * Returns the florist id, or null when no non-excluded florist owns that email.
 *
 * Idempotent: an existing mapping is returned untouched, so this is safe to
 * call on every sign-in.
 */
export async function ensureFloristUser(
  admin: Admin,
  userId: string,
  email: string | null | undefined,
  /** Skip the email lookup when the caller already knows the florist (the
   * magic-link route holds it from the token row). The email match is a
   * fallback for ordinary sign-ins, not the authority. */
  knownFloristId?: string
): Promise<string | null> {
  const { data: existing } = await admin
    .from("florist_users")
    .select("florist_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (existing) return existing.florist_id;

  if (!email) return null;
  const lower = email.toLowerCase();

  let floristId = knownFloristId ?? null;
  if (!floristId) {
    const { data: florist } = await admin
      .from("florists")
      .select("id")
      .eq("email", lower)
      .is("excluded_at", null)
      .maybeSingle();
    floristId = florist?.id ?? null;
  }
  if (!floristId) return null;

  const { error } = await admin
    .from("florist_users")
    .insert({ user_id: userId, florist_id: floristId, role: "owner", email: lower });
  if (error) {
    // A concurrent sign-in (magic link clicked twice, two tabs) can win the
    // race; re-read rather than fail, since the mapping we wanted now exists.
    const { data: raced } = await admin
      .from("florist_users")
      .select("florist_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (raced) return raced.florist_id;
    console.error("ensureFloristUser: insert failed", error.message);
    return null;
  }
  return floristId;
}

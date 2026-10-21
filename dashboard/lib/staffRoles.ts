// Pure staff-role types + the last-admin-guard decision logic. Kept separate from
// lib/allowlist.ts / lib/apiAuth.ts so this is unit-testable without a DB — same
// split as lib/airwallex/revealGuard.ts.

export type StaffRole = "admin" | "ops" | "finance" | "read_only";

export const STAFF_ROLES: StaffRole[] = ["admin", "ops", "finance", "read_only"];

export interface AllowedEmailRow {
  email: string;
  role: StaffRole;
}

/**
 * Would changing `targetEmail` to `nextRole` (or removing it, if `nextRole` is
 * null) leave zero admins on the allow-list? Used to block both PATCH (demote)
 * and DELETE (remove) on the last remaining admin.
 */
export function wouldRemoveLastAdmin(
  rows: AllowedEmailRow[],
  targetEmail: string,
  nextRole: StaffRole | null
): boolean {
  const target = rows.find((r) => r.email.toLowerCase() === targetEmail.toLowerCase());
  if (!target || target.role !== "admin") return false;
  if (nextRole === "admin") return false;
  const otherAdmins = rows.filter(
    (r) => r.role === "admin" && r.email.toLowerCase() !== targetEmail.toLowerCase()
  );
  return otherAdmins.length === 0;
}

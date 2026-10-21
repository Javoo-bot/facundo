import { createServerClient } from "./supabase";
import { isAllowed, getStaffRole } from "./allowlist";
import type { StaffRole } from "./staffRoles";

export function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { "Content-Type": "application/json" },
  });
}

export async function requireAllowedUser(): Promise<{ ok: true; email: string } | { ok: false; res: Response }> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, res: jsonError("Not signed in.", 401) };
  if (!(await isAllowed(user.email))) return { ok: false, res: jsonError("This account is not authorized.", 403) };
  return { ok: true, email: user.email ?? "" };
}

/**
 * Like requireAllowedUser, but additionally requires the caller's staff role to
 * be one of `roles`. Use for any route that must be narrower than "any staff
 * member" — see the permission matrix in the design spec.
 */
export async function requireRole(
  ...roles: StaffRole[]
): Promise<{ ok: true; email: string; role: StaffRole } | { ok: false; res: Response }> {
  const base = await requireAllowedUser();
  if (!base.ok) return base;
  const role = await getStaffRole(base.email);
  if (!role || !roles.includes(role)) {
    return { ok: false, res: jsonError("Your role doesn't allow this.", 403) };
  }
  return { ok: true, email: base.email, role };
}

import type { createServiceClient } from "./supabaseAdmin";

export type LoginMethod = "google" | "password" | "otp" | "magic_link";
export type LoginSurface = "staff" | "florist";

export interface LoginEventInput {
  surface: LoginSurface;
  method: LoginMethod;
  userEmail?: string | null;
  floristId?: string | null;
  userAgent?: string | null;
}

/** Pure shape check, split out so it's testable without a DB — a staff row
 * needs an email to be worth anything, a florist row needs a florist_id. */
export function validateLoginEventInput(input: LoginEventInput): { ok: true } | { ok: false; reason: string } {
  if (input.surface === "staff" && !input.userEmail) return { ok: false, reason: "staff login requires userEmail" };
  if (input.surface === "florist" && !input.floristId) return { ok: false, reason: "florist login requires floristId" };
  return { ok: true };
}

/** Best-effort login-event insert. Never throws — a logging failure must never
 * cost anyone their sign-in. Call after the real session is already established. */
export async function logLoginEvent(
  admin: ReturnType<typeof createServiceClient>,
  input: LoginEventInput,
): Promise<void> {
  const check = validateLoginEventInput(input);
  if (!check.ok) {
    console.error("logLoginEvent: invalid input", check.reason);
    return;
  }
  const { error } = await admin.from("login_events").insert({
    surface: input.surface,
    method: input.method,
    user_email: input.userEmail ?? null,
    florist_id: input.floristId ?? null,
    user_agent: input.userAgent ?? null,
  });
  if (error) console.error("logLoginEvent: insert failed", error.message);
}

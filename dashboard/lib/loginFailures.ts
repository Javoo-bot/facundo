import type { createServiceClient } from "./supabaseAdmin";

/** Where in the sign-in flow the attempt died. Free text in the DB on purpose
 * (see the migration) — this union is the app-side vocabulary, not a constraint. */
export type LoginFailureStage = "code_exchange" | "no_code" | "not_allowed";

export interface LoginFailureInput {
  stage: LoginFailureStage;
  /** Provider error code, e.g. "pkce_code_verifier_not_found". */
  reason?: string | null;
  /** Provider message. Truncated by buildLoginFailureRow. */
  detail?: string | null;
  /** Only known once a session exists — i.e. an allow-list rejection. */
  userEmail?: string | null;
  host?: string | null;
  /** The callback's `next` param; "/auth/reset" marks a password reset. */
  nextParam?: string | null;
  userAgent?: string | null;
}

/** Provider messages are long and occasionally include a whole paragraph of
 * remediation advice (Supabase's PKCE error is ~250 chars). Cap it so one bad
 * actor hammering the callback can't bloat the table. */
export const DETAIL_MAX = 500;

/**
 * Pure row builder, split out so it's exercisable under `node --test` without a
 * DB — same convention as lib/loginEvents.ts's validateLoginEventInput and
 * lib/analyticsRules.ts. Normalises empty strings to null so "unknown" is one
 * value in the table rather than two.
 */
export function buildLoginFailureRow(input: LoginFailureInput) {
  const clean = (v: string | null | undefined): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t.length ? t : null;
  };
  const detail = clean(input.detail);
  return {
    stage: input.stage,
    reason: clean(input.reason),
    detail: detail === null ? null : detail.slice(0, DETAIL_MAX),
    user_email: clean(input.userEmail)?.toLowerCase() ?? null,
    host: clean(input.host),
    next_param: clean(input.nextParam),
    user_agent: clean(input.userAgent),
  };
}

/**
 * Best-effort failure insert. NEVER throws and never blocks: a diagnostics
 * write must not be able to turn a recoverable sign-in failure into a broken
 * page. Mirrors lib/loginEvents.ts::logLoginEvent, which makes the same promise
 * on the success path.
 */
export async function logLoginFailure(
  admin: ReturnType<typeof createServiceClient>,
  input: LoginFailureInput,
): Promise<void> {
  try {
    const { error } = await admin.from("login_failures").insert(buildLoginFailureRow(input));
    if (error) console.error("logLoginFailure: insert failed", error.message);
  } catch (e) {
    // Includes the case where the migration hasn't been applied yet — the
    // callback must still redirect normally against an older database.
    console.error("logLoginFailure: threw", e instanceof Error ? e.message : String(e));
  }
}

// Where every demo shop's contact details point. A demo shop is not just
// EXCLUDED from real customer orders (florists.is_test_shop already does that,
// see lib/match.ts) — its email/phone are literally set to this sink at
// creation, so an offer/SMS/push send to it can never be mistaken for a real
// address even if some future code path stops special-casing is_test_shop.
//
// Pure, so `node --test` can pin the fail-closed behaviour without a database.

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface DemoSink {
  email: string;
  phone: string | null;
}

export type DemoSinkResult =
  | { ok: true; sink: DemoSink }
  | { ok: false; reason: "no-test-email" | "invalid-test-email" };

/** `app_settings.test_email` / `test_phone`, or a reason the sandbox refuses to
 *  create/act on a demo shop. Phone is optional (SMS-less demo shops are still
 *  useful for email-only scenarios); email is mandatory — a demo shop with no
 *  reachable address is just a shop with no address, not a safe default. */
export function resolveDemoSink(settings: { test_email?: string | null; test_phone?: string | null } | null | undefined): DemoSinkResult {
  const email = settings?.test_email?.trim() || "";
  if (!email) return { ok: false, reason: "no-test-email" };
  if (!EMAIL_RE.test(email)) return { ok: false, reason: "invalid-test-email" };
  const phone = settings?.test_phone?.trim() || null;
  return { ok: true, sink: { email, phone } };
}

// Which outbound-email transport is armed in this environment.
//
// Decision (2026-08-21): after the 2026-08-20 move to Ongage exhausted the
// need for a stopgap, the team went dual-transport instead of picking one
// globally. PRODUCTION runs Resend — its account (fc.example.net domain) has
// DKIM/SPF verified and a working delivery/open/click webhook
// (app/api/webhooks/resend/route.ts) that Ongage has no equivalent for yet
// (see lib/lifecycle.ts's `x-email-delivery-feedback-ongage` cross-cutting
// entry). STAGING keeps Ongage — its job is proving the send path works
// end-to-end in QA, so losing delivery/open/click tracking there is an
// acceptable trade.
//
// Selection is an EXPLICIT env flag (`EMAIL_TRANSPORT`), not inferred from
// which secrets happen to be present. Inferring from config presence would
// mean an environment silently changes provider the moment someone adds or
// rotates a credential for the "other" one — an explicit flag makes "which
// transport is live here" a single grep-able line instead of a deduction, and
// lets each environment fail closed on its OWN missing secrets rather than
// falling back to whichever provider still happens to be configured.
//
// Alias-free (relative imports only, and none at all) so plain `node --test`
// can reach it directly, and so lib/emailFrom.ts (imported relatively by
// lib/ongage.test.mjs) can import it too without breaking that test's alias-
// free resolution.

export interface EmailTransportEnv {
  EMAIL_TRANSPORT?: string;
  RESEND_API_KEY?: string;
  ONGAGE_LIST_ID?: string;
  ONGAGE_USERNAME?: string;
  ONGAGE_PASSWORD?: string;
  ONGAGE_ACCOUNT_CODE?: string;
  ONGAGE_SENDING_CONNECTION_ID?: string;
  // Index signature so process.env (ProcessEnv) assigns cleanly, mirroring
  // lib/railGate.ts::RailGateEnv.
  [key: string]: string | undefined;
}

export type EmailTransport = "resend" | "ongage";

/** Duplicates ongageConfig()'s "are all five vars present" check (lib/ongage.ts)
 * rather than importing it, so this stays a pure function of an arbitrary env
 * object instead of always reading live process.env — same tradeoff
 * lib/workingSet.ts documents for isInWorkingSet's cross-file duplication. */
function ongageConfigured(env: EmailTransportEnv): boolean {
  const connectionId = Number(env.ONGAGE_SENDING_CONNECTION_ID?.trim());
  return Boolean(
    env.ONGAGE_LIST_ID?.trim() &&
      env.ONGAGE_USERNAME?.trim() &&
      env.ONGAGE_PASSWORD?.trim() &&
      env.ONGAGE_ACCOUNT_CODE?.trim() &&
      Number.isFinite(connectionId) &&
      connectionId > 0,
  );
}

/** `"resend" | "ongage" | null`. Null means sendEmail() must fail closed:
 * EMAIL_TRANSPORT is unset/invalid, or the requested transport's own secrets
 * aren't configured. Never guesses and never falls back to the other
 * transport — call emailTransportError() for why, to log. */
export function resolveEmailTransport(env: EmailTransportEnv = process.env): EmailTransport | null {
  const raw = env.EMAIL_TRANSPORT?.trim();
  if (raw === "resend") return env.RESEND_API_KEY?.trim() ? "resend" : null;
  if (raw === "ongage") return ongageConfigured(env) ? "ongage" : null;
  return null;
}

/** A one-line, caller-loggable reason resolveEmailTransport(env) returned
 * null. States exactly what's missing rather than guessing which transport
 * was "meant". */
export function emailTransportError(env: EmailTransportEnv = process.env): string {
  const raw = env.EMAIL_TRANSPORT?.trim();
  if (raw !== "resend" && raw !== "ongage") {
    return `EMAIL_TRANSPORT must be set to "resend" or "ongage" (got ${JSON.stringify(env.EMAIL_TRANSPORT ?? null)})`;
  }
  if (raw === "resend") return "EMAIL_TRANSPORT=resend but RESEND_API_KEY is not set";
  return "EMAIL_TRANSPORT=ongage but Ongage is not configured (ONGAGE_LIST_ID / ONGAGE_USERNAME / ONGAGE_PASSWORD / ONGAGE_ACCOUNT_CODE / ONGAGE_SENDING_CONNECTION_ID)";
}

// The two "should we capture this?" predicates, kept free of posthog-js so they
// can be exercised directly in Node (lib/analyticsRules.test.mjs). They decide
// whether a person is recorded at all, so a silent mistake here means either
// recording someone we promised not to, or recording nobody — both invisible
// without a test. lib/analytics.ts wires them to the real posthog client.

/** Parses the comma-separated NEXT_PUBLIC_POSTHOG_EXCLUDED_EMAILS list.
 * Tolerates spaces and casing so the env var can be written naturally. */
export function parseExcludedEmails(raw: string | undefined | null): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** True when this email is opted out of PostHog entirely (no replay, no events). */
export function isExcludedEmail(email: string | undefined | null, excluded: Set<string>): boolean {
  if (!email) return false;
  return excluded.has(email.trim().toLowerCase());
}

/** True when session replay may run on this hostname. Events are unaffected —
 * only the recording is suppressed — so a staging deploy stays verifiable.
 * Fails closed for anything localhost-shaped or containing "staging", rather
 * than allow-listing production, so a new preview/staging host doesn't start
 * recording just because nobody remembered to add it here. */
export function replayAllowedOnHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return false;
  if (host.endsWith(".local") || host.endsWith(".localhost")) return false;
  if (host.includes("staging")) return false;
  return true;
}

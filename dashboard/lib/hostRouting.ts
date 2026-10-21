// Which surface a hostname is allowed to serve.
//
// The app is ONE Next deployment serving two audiences: the staff backoffice
// (the `app/(staff)` route group, which owns the URL root) and the florist PWA
// (`app/florist/**`). Until now every hostname served both, so
// florist.fc.example.net/settings rendered the backoffice sign-in. These rules
// split them by Host header.
//
// Deliberately a DENYLIST per host, not an allowlist: each host blocks only the
// other surface's page routes and passes everything else through. An allowlist
// would mean enumerating every shared path (auth, static, manifest, icons, API)
// correctly on the first try, and anything forgotten would 404 in production.
//
// `/api/**` is intentionally NOT partitioned — every route handler already
// authorizes independently (`currentFlorist()`, `isAllowed()`, staff-role
// checks), so reachability is not the security boundary there. Blocking API
// paths by host would add real breakage risk (the florist PWA calls
// /api/staff/view-as; the customer proof link is /api/orders/proof) to buy
// nothing. See middleware.ts.
//
// Pure + dependency-free so it can be unit-tested under `node --test` — same
// convention as lib/analyticsRules.ts.

/** Hostname that serves ONLY the florist PWA. */
export const FLORIST_HOST = "florist.fc.example.net";
/** Hostname that serves ONLY the staff backoffice. */
export const BACKOFFICE_HOST = "bo.fc.example.net";

/**
 * First URL segment of every `app/(staff)` page route. The `(staff)` route
 * group's parens don't appear in URLs, so these sit at the root and are what
 * has to be blocked on the florist host.
 *
 * Keep in sync when adding a staff route — a missing entry means that page
 * stays reachable on florist.fc.example.net (fails open, not closed).
 */
export const STAFF_SEGMENTS: ReadonlySet<string> = new Set([
  "admin",
  "city",
  "communications",
  "cx",
  "discovery",
  "email-templates",
  // The Q&A EDITOR. The Q&A itself is the public /help (app/help), which is
  // deliberately NOT listed here — it has to stay reachable on the florist
  // host, since that's the host the offer emails link to.
  "faq",
  "florists", // NB: plural = staff. Singular "florist" is the PWA.
  "jobs",
  "lifecycle",
  "operations",
  "orders",
  "payments",
  "settings",
  "statistics",
]);

/** Prefixes that must resolve identically on every host: framework assets and
 * API routes. Listed explicitly so a future staff segment can never shadow one. */
const ALWAYS_PASS = ["/api/", "/_next/"];

export type HostRoute =
  | { kind: "pass" }
  | { kind: "not-found" }
  | { kind: "redirect"; to: string };

/** Strip port and casing so "Florist.Fc.example.net:443" matches. */
export function normalizeHost(hostname: string | null | undefined): string {
  if (!hostname) return "";
  return hostname.trim().toLowerCase().split(":")[0];
}

/** First path segment, or "" for the root. `/orders/abc` -> "orders". */
export function firstSegment(pathname: string): string {
  return pathname.split("/").filter(Boolean)[0] ?? "";
}

function isFloristPath(pathname: string): boolean {
  return pathname === "/florist" || pathname.startsWith("/florist/");
}

/**
 * Decide what to do with a request, given its Host and path.
 *
 * Unrecognised hosts always pass: the example.org hosts (and workers.dev, and
 * localhost) keep serving both surfaces unrestricted, so this can't break the
 * existing staff workflow or local dev while the new hostnames bed in.
 */
export function decideHostRoute(hostname: string | null | undefined, pathname: string): HostRoute {
  const host = normalizeHost(hostname);
  if (host !== FLORIST_HOST && host !== BACKOFFICE_HOST) return { kind: "pass" };
  if (ALWAYS_PASS.some((p) => pathname.startsWith(p))) return { kind: "pass" };

  if (host === FLORIST_HOST) {
    // Bare root on the florist host is a florist landing, not the backoffice.
    if (pathname === "/") return { kind: "redirect", to: "/florist" };
    return STAFF_SEGMENTS.has(firstSegment(pathname)) ? { kind: "not-found" } : { kind: "pass" };
  }

  // BACKOFFICE_HOST: the staff console owns the root; only the PWA is blocked.
  return isFloristPath(pathname) ? { kind: "not-found" } : { kind: "pass" };
}

/**
 * Where to send the browser to reach the florist PWA, given the host the
 * request currently came in on. On the backoffice host `/florist` is blocked
 * above, so it must be an absolute URL to the florist host instead; every
 * other host (florist host itself, legacy example.org, workers.dev, localhost)
 * still serves both surfaces, so a relative path works.
 */
export function floristAppUrl(hostname: string | null | undefined): string {
  return normalizeHost(hostname) === BACKOFFICE_HOST ? `https://${FLORIST_HOST}/florist` : "/florist";
}

/**
 * Cookie `domain` attribute for auth cookies that must be readable on both
 * fc.example.net hosts (e.g. the staff "view as florist" cookie, minted on the
 * backoffice host and read on the florist host). `undefined` outside the two
 * production hosts, so localhost/workers.dev/example.org keep the default
 * host-only cookie — a `domain` attribute there wouldn't match the current
 * host and the browser would silently drop the cookie.
 */
export function sharedCookieDomain(hostname: string | null | undefined): string | undefined {
  const host = normalizeHost(hostname);
  return host === BACKOFFICE_HOST || host === FLORIST_HOST ? ".fc.example.net" : undefined;
}

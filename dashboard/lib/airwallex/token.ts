// Pure helpers for Airwallex bearer-token caching. Airwallex tokens are JWTs
// that expire (~30 min); re-authenticating on every call (the v1 behaviour) is
// wasteful, so client.ts caches the token until shortly before it expires.
// The pure decision logic lives here so it's unit-testable without network.

export interface TokenCache {
  token: string;
  expMs: number;
}

// Decode the `exp` (seconds) claim from a JWT's payload → epoch ms, or null if
// the token isn't a parseable JWT / has no numeric exp.
export function jwtExpMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

// A cached token is usable while it's still more than `skewMs` from expiry —
// the skew guards against a token expiring mid-request.
export function tokenIsFresh(cache: TokenCache | null, nowMs: number, skewMs = 60_000): boolean {
  return !!cache && cache.expMs - skewMs > nowMs;
}

// Build the cache entry for a freshly-fetched token; falls back to a
// conservative TTL when the token carries no usable exp.
export function newTokenCache(token: string, nowMs: number, fallbackTtlMs = 25 * 60_000): TokenCache {
  return { token, expMs: jwtExpMs(token) ?? nowMs + fallbackTtlMs };
}

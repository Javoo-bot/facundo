// Minimal type declarations for the plain-JS operator script, so
// test/get-shopify-admin-token.test.ts can import `verifyOAuthCallbackHmac`
// under `tsc --noEmit` / vitest without needing `allowJs`.

export function verifyOAuthCallbackHmac(
  query: Record<string, string>,
  clientSecret: string,
): boolean;

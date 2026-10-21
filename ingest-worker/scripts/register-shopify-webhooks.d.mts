// Minimal type declarations for the plain-JS operator script, so
// test/register-shopify-webhooks.test.ts can import `planActions` under
// `tsc --noEmit` / vitest without needing `allowJs`.

export interface ShopifyWebhookSubscription {
  id: number | string;
  topic: string;
  format: string;
  address: string;
  [k: string]: unknown;
}

export type WebhookAction =
  | { topic: string; kind: "create" }
  | { topic: string; kind: "skip"; id: number | string }
  | { topic: string; kind: "repoint"; id: number | string; from: string };

export function planActions(
  existing: ShopifyWebhookSubscription[],
  topics: string[],
  url: string,
): WebhookAction[];

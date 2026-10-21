// Low-level Airwallex HTTP client: one place for the base URL, bearer-token
// auth (cached), and a retrying fetch. Everything in lib/airwallex/ that talks
// to the API goes through awxGet/awxPost.
//
// Sandbox by default (api-demo.airwallex.com). Auth env:
//   AIRWALLEX_CLIENT_ID, AIRWALLEX_API_KEY   (demo.airwallex.com creds)
//   AIRWALLEX_BASE                           (optional; defaults to the demo host)
//   AIRWALLEX_API_VERSION                    (optional; pins the API version, see below)

import { retryingFetch } from "./retry";
import { type TokenCache, tokenIsFresh, newTokenCache } from "./token";
import { logExternalOp } from "@/lib/externalOps";

// A short, safe operation label from an Airwallex path (drops ids/query so the
// log groups by call type). Only the path + HTTP status are ever logged — never
// a response body, so sensitive card details (PAN/CVV) are never recorded.
function opLabel(path: string): string {
  return path.replace(/^\/api\/v\d+\//, "").split("?")[0].replace(/\/[0-9a-f-]{8,}/gi, "/:id").replace(/\//g, "_");
}

const BASE = process.env.AIRWALLEX_BASE || "https://api-demo.airwallex.com";

// Airwallex resolves an unpinned request against whatever API version the
// ACCOUNT is on, and our two accounts sit on different ones: production on
// 2023-08-31, the sandbox on 2026-02-27. That single difference is why
// identical code issued cards in production and failed in the sandbox with
// "cardholder_id must be provided" — in 2026-02-27 cardholder_id became
// mandatory even for issue_to: "ORGANISATION".
//
// Pinning makes the two environments agree, and removes a live production
// risk: an unpinned production account that Airwallex later migrates would
// start failing every card issue with that same error, with no code change to
// point at. Overridable so a version bump is a config change, not a deploy.
const API_VERSION = process.env.AIRWALLEX_API_VERSION || "2023-08-31";

export class AirwallexError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`Airwallex ${status}: ${body}`);
    this.name = "AirwallexError";
  }
}

let tokenCache: TokenCache | null = null;

// Test/hot-reload hook — clears the module-level token cache.
export function _resetTokenCache(): void {
  tokenCache = null;
}

export async function airwallexToken(): Promise<string> {
  const now = Date.now();
  if (tokenIsFresh(tokenCache, now)) return tokenCache!.token;
  const res = await retryingFetch(`${BASE}/api/v1/authentication/login`, {
    method: "POST",
    headers: {
      "x-client-id": process.env.AIRWALLEX_CLIENT_ID ?? "",
      "x-api-key": process.env.AIRWALLEX_API_KEY ?? "",
      "x-api-version": API_VERSION,
    },
  });
  if (!res.ok) throw new AirwallexError(res.status, await res.text().catch(() => ""));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Airwallex JSON response is untyped
  const token = ((await res.json()) as any).token as string;
  tokenCache = newTokenCache(token, now);
  return token;
}

async function authedFetch(path: string, init: RequestInit): Promise<Response> {
  const token = await airwallexToken();
  return retryingFetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-api-version": API_VERSION,
    },
  });
}

export async function awxGet<T>(path: string): Promise<T> {
  const start = Date.now();
  const res = await authedFetch(path, { method: "GET" });
  await logExternalOp({ provider: "airwallex", operation: opLabel(path), ok: res.ok, statusCode: res.status, durationMs: Date.now() - start });
  if (!res.ok) throw new AirwallexError(res.status, await res.text().catch(() => ""));
  return (await res.json()) as T;
}

export async function awxPost<T>(path: string, body: unknown): Promise<T> {
  const start = Date.now();
  // request_id is safe to log as a ref (it's our own idempotency key); never log the body.
  const ref = body && typeof body === "object" && "request_id" in body ? String((body as { request_id: unknown }).request_id) : null;
  const res = await authedFetch(path, { method: "POST", body: JSON.stringify(body) });
  await logExternalOp({ provider: "airwallex", operation: opLabel(path), ref, ok: res.ok, statusCode: res.status, durationMs: Date.now() - start });
  if (!res.ok) throw new AirwallexError(res.status, await res.text().catch(() => ""));
  return (await res.json()) as T;
}

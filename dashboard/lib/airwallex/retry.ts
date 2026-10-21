// Retrying fetch for Airwallex calls — retries transient failures (network
// errors and 429/5xx responses) with capped exponential backoff. 4xx other
// than 429 are returned as-is (the caller decides what a client error means).
//
// `fetchImpl` and `sleep` are injectable so the retry logic is unit-testable
// without real network or real timers.

export interface RetryOpts {
  attempts?: number;
  baseDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function retryingFetch(
  url: string,
  init: RequestInit,
  opts: RetryOpts = {},
): Promise<Response> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const base = opts.baseDelayMs ?? 300;

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(url, init);
      // Retry transient statuses only while attempts remain; otherwise return
      // the response and let the caller surface the error.
      if (isRetryable(res.status) && i < attempts - 1) {
        await sleep(base * 2 ** i);
        continue;
      }
      return res;
    } catch (e) {
      // Network/DNS/timeout error — retry while attempts remain, else rethrow.
      lastErr = e;
      if (i < attempts - 1) {
        await sleep(base * 2 ** i);
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("retryingFetch: exhausted retries");
}

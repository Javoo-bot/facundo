import test from "node:test";
import assert from "node:assert/strict";
import { logExternalOp } from "./externalOps.ts";

// logExternalOp is called from hot paths (webhook receivers, cron sweeps) that
// must never be affected by a logging failure. createServiceClient() throws
// when SUPABASE_SERVICE_ROLE_KEY isn't set — which is exactly the case in
// this plain `node --test` environment (no .env.local loaded) — so calling
// the REAL function here exercises the real "logging backend is unavailable"
// failure path, not a mock of it.
test("logExternalOp never throws, even when the underlying client can't be created", async () => {
  const before = { ...process.env };
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    await assert.doesNotReject(() =>
      logExternalOp({ provider: "airwallex", operation: "webhook_in", direction: "in", ok: false, statusCode: 401, error: "bad-signature" }),
    );
  } finally {
    process.env = before;
  }
});

test("logExternalOp resolves to undefined on failure (never surfaces a value or throws to the caller)", async () => {
  const before = { ...process.env };
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const result = await logExternalOp({ provider: "airwallex", operation: "webhook_in", direction: "in", ok: true, statusCode: 200 });
    assert.equal(result, undefined);
  } finally {
    process.env = before;
  }
});

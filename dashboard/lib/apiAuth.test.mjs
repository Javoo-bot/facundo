import test from "node:test";
import assert from "node:assert/strict";
import { jsonError } from "./apiAuth.ts";

test("jsonError returns a JSON Response with the status", async () => {
  const res = jsonError("nope", 403);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "nope" });
});

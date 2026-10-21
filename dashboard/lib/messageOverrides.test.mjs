import test from "node:test";
import assert from "node:assert/strict";
import { loadOverrides } from "./messageOverrides.ts";

// Minimal fake of the one Supabase call chain loadOverrides makes
// (admin.from("message_overrides").select("key,value").eq("locale", locale)) —
// enough to exercise the success/error/throw paths without a real DB.
function fakeAdmin({ data = null, error = null, throwOnFrom = false } = {}) {
  return {
    from(table) {
      assert.equal(table, "message_overrides");
      if (throwOnFrom) throw new Error("boom");
      return {
        select(cols) {
          assert.equal(cols, "key,value");
          return {
            eq(col, value) {
              assert.equal(col, "locale");
              assert.equal(typeof value, "string");
              return Promise.resolve({ data, error });
            },
          };
        },
      };
    },
  };
}

test("loadOverrides returns a flat {key: value} map from the query rows", async () => {
  const admin = fakeAdmin({
    data: [
      { key: "email.shell.footer", value: "Custom footer" },
      { key: "email.offer.headline", value: "Custom headline" },
    ],
  });
  const overrides = await loadOverrides(admin, "en");
  assert.deepEqual(overrides, {
    "email.shell.footer": "Custom footer",
    "email.offer.headline": "Custom headline",
  });
});

test("loadOverrides returns {} when the query errors (never throws)", async () => {
  const admin = fakeAdmin({ data: null, error: { message: "relation does not exist" } });
  const overrides = await loadOverrides(admin, "en");
  assert.deepEqual(overrides, {});
});

test("loadOverrides returns {} when there are no rows for this locale", async () => {
  const admin = fakeAdmin({ data: [] });
  const overrides = await loadOverrides(admin, "fr");
  assert.deepEqual(overrides, {});
});

test("loadOverrides returns {} (never throws) if the client itself throws", async () => {
  const admin = fakeAdmin({ throwOnFrom: true });
  const overrides = await loadOverrides(admin, "en");
  assert.deepEqual(overrides, {});
});

test("loadOverrides skips a malformed row (non-string key/value) rather than throwing", async () => {
  const admin = fakeAdmin({
    data: [
      { key: "email.shell.footer", value: "Custom footer" },
      { key: 123, value: "bad key" },
      { key: "email.offer.headline", value: null },
    ],
  });
  const overrides = await loadOverrides(admin, "en");
  assert.deepEqual(overrides, { "email.shell.footer": "Custom footer" });
});

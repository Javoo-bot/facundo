import { describe, expect, it } from "vitest";
import { chunk, isInstanceAlreadyExistsError, isPlatformInternalError } from "../src/batching";

// The pure batching helper behind workflow.ts::runEnrichBatches (see
// config.ts::ENRICH_BATCH_SIZE for why enrichment is chunked into child
// Workflow instances). workflow.ts itself is Workers-runtime code exercised
// via `wrangler dev`, not vitest — see vitest.config.ts — hence chunk()
// living in its own plain module.
describe("chunk", () => {
  it("splits into consecutive batches of at most `size`, preserving order", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns one batch when everything fits", () => {
    expect(chunk([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
  });

  it("returns an empty array for an empty input", () => {
    expect(chunk([], 10)).toEqual([]);
  });

  it("returns exactly-sized batches when the count divides evenly", () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });

  it("mirrors the real Kfar Saba shape: 352 items at ENRICH_BATCH_SIZE=40 -> 9 batches, last one partial", () => {
    const items = Array.from({ length: 352 }, (_, i) => i);
    const batches = chunk(items, 40);
    expect(batches).toHaveLength(9);
    expect(batches.slice(0, 8).every((b) => b.length === 40)).toBe(true);
    expect(batches[8]).toHaveLength(32);
    expect(batches.flat()).toEqual(items);
  });
});

// The bug that broke Zadar/Kfar Saba/Girona on 2026-09-03: a Workflow step's
// callback can be re-invoked more than once for the same logical run before
// its result is durably checkpointed, and a second `.create()` call with the
// same instance id throws instead of no-op'ing. This is what makes that one
// error tolerable instead of fatal.
describe("isInstanceAlreadyExistsError", () => {
  it("recognizes the real production error text", () => {
    expect(isInstanceAlreadyExistsError(new Error("(instance.already_exists) Instance already exists"))).toBe(true);
  });

  it("is case-insensitive and tolerant of the underscore/space variants", () => {
    expect(isInstanceAlreadyExistsError(new Error("Instance Already Exists"))).toBe(true);
    expect(isInstanceAlreadyExistsError(new Error("instance.already_exists"))).toBe(true);
  });

  it("does not match an unrelated error", () => {
    expect(isInstanceAlreadyExistsError(new Error("Apify run start failed with status 400"))).toBe(false);
  });

  it("handles a non-Error throw", () => {
    expect(isInstanceAlreadyExistsError("already exists")).toBe(true);
    expect(isInstanceAlreadyExistsError({ weird: "object" })).toBe(false);
  });
});

// The 2026-08-04+ recurring Cloudflare platform fault (documented, not
// caused by this codebase) that runEnrichBatches retries a batch for,
// with a fresh instance id, instead of failing the whole job.
describe("isPlatformInternalError", () => {
  it("recognizes the real production error text", () => {
    expect(isPlatformInternalError("Attempt failed due to internal workflows error")).toBe(true);
  });

  it("recognizes the platform's own error class name", () => {
    expect(isPlatformInternalError("WorkflowInternalError: something went sideways")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isPlatformInternalError("ATTEMPT FAILED DUE TO INTERNAL WORKFLOWS ERROR")).toBe(true);
  });

  it("does not match an unrelated error", () => {
    expect(isPlatformInternalError("Worker exceeded memory limit.")).toBe(false);
    expect(isPlatformInternalError("(instance.already_exists) Instance already exists")).toBe(false);
  });

  it("handles undefined", () => {
    expect(isPlatformInternalError(undefined)).toBe(false);
  });
});

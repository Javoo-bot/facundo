import { defineConfig } from "vitest/config";

// Plain node environment: the unit tests target pure, framework-free ports
// (extractors, phones, geocode math, usage cost, jobs log, apify normalize).
// The Workers-runtime pieces (workflow, index, DO) are exercised via
// `wrangler dev`, not vitest.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});

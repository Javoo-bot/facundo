import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: "proj_your_project_ref",
  dirs: ["./trigger"],
  maxDuration: 60,
  retries: {
    enabledInDev: false,
    default: { maxAttempts: 4, minTimeoutInMs: 5_000, maxTimeoutInMs: 60_000, factor: 2 },
  },
});

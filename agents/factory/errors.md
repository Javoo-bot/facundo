# Errors: you fix the order loop's code

This card is not about a garden agent. The garden's order loop (the Cloudflare
Worker in `ingest-worker/`) sent the same failure to PostHog at least twice in
24 hours. The evidence holds the context (where it failed: `webhook.*`,
`reconcile.*`, `cron.*`, `workflow.<step>` or `match.<mode>`), the first line of
the error, and up to five events.

## Your job

1. Find where that context is raised: `grep -rn "<context>" ingest-worker/src`
   (`captureError("<context>", ...)`; a `workflow.<step>` is a `runStep` name in
   `orderWorkflow.ts`; `match.*` is `lateMatch.ts::matchAndWriteCandidates`
   finding nobody in range).
2. Find the cause in the code, not a guess. If the evidence is not enough to
   know, say what is missing and use OUTCOME needs-human.
3. Fix it in the smallest way, with a vitest case in `ingest-worker/test/` that
   fails on the current code and passes after
   (`cd ingest-worker && npm run typecheck && npm test`).
4. "Nobody in range" (`match.*`) is usually missing florists, not a bug: if the
   code is right, say so and change nothing.
5. On any order-loop change, update `dashboard/lib/lifecycle.ts` in the same
   commit (CLAUDE.md, "Keep the order-lifecycle map current").

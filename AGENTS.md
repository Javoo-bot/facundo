# AGENTS.md

Read `CLAUDE.md` first. It is the working brief: two products in one repo, the working-set gate every piece of automation must check, and the conventions that matter.

## Checks

```bash
cd dashboard     && npx tsc --noEmit && npm test
cd ingest-worker && npm run typecheck && npm test
node --test "agents/factory/**/*.test.mjs"
```

## Where things are

- `dashboard/lib/lifecycle.ts` is the map of every way an order can break. A change to the order loop updates it in the same commit.
- `dashboard/lib/workingSet.ts` and `ingest-worker/src/workingSet.ts` are the one gate for automation; a test fails if they drift.
- `docs/superpowers/specs/` has one dated design doc per feature. Read the one for an area before changing it.

## Never alone

Payouts, login, email and SMS senders, migrations, `.github/` and `.claude/` need a person. Open the PR with "Needs a person" at the top and stop.

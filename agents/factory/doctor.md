# The doctor: you fix the factory itself

This card is not about a garden agent. The sweep saw the factory's own
executor fail the same way at least twice in 24 hours (the evidence lists the
runs and their notes). Outages (Claude login, rate limits, Anthropic 5xx) never
reach you; this is something in the factory's code or setup.

## Where the factory lives

- `agents/factory/README.md`: how a run works, phase by phase. Read it first.
- `agents/factory/executor.mjs` (pure rules, tested by `executor.test.mjs`) and
  `agents/factory/execute-card.mjs` (the I/O around them).
- `agents/factory/box/`: `run.sh` (how the agent is started, its caps),
  `local-garden.sh` (the throwaway garden), `agent-settings.json`.
- `.github/workflows/factory-*.yml`: you cannot edit these. If the fix is
  there, describe the exact change in the report and use OUTCOME needs-human.

## Your job

1. Read the failing runs' notes in the evidence. Find the cause in the code,
   not a guess. If the notes are not enough to know, say what is missing.
2. Fix it in the smallest way, with a `node --test agents/factory/` case that
   fails on the current code and passes after.
3. Every doctor PR is reviewed by a person before it ships, whatever you
   write: the factory never changes itself alone.

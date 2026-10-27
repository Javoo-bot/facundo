# Topic 3: Check one real test

**Goal:** take one fix the factory made last week, check whether its test
really proved the fix, and turn what we learn into a checking skill.

## Where we are (review of 2026-10-26)

- The executor's brief (`agents/factory/executor.mjs`) tells the agent to:
  write a test that fails on today's code, keep the failing output, fix, run it
  green, run the package's whole suite, and never change a test that judges
  the fix.
- The report must contain "What the tests show": the failing run and the
  passing run, named.
- Rules: `docs/agent-factory/verification-principles.md` (16 rules).
- Candidates from last week (draft PRs in the factory's repo): #9 (photo
  checker error), #10 (holding reply when the AI is down), #11, #12, #13 (no
  florist in range), #14 (chats with no order facts).

## The owner's direction

Check one example closely, then build a verification skill from it.

## To settle

1. Which PR to use as the example.
2. Did its failing test fail for the right reason, or for any reason?
3. Would the test catch the bug coming back (try putting the bug back)?
4. Did it check what the florist or client actually sees, or only inside the
   code?
5. What the skill checks on every factory PR from now on.

## First review (2026-10-26)

Six PRs checked by putting each fix back to the old code and re-running the
tests (#14 not checked: the reviewing agent lost its connection).

| PR | Verdict | Why |
|---|---|---|
| #10 retry when the AI is busy | Proves the fix | 4 tests fail on the old code, 4 guards fail when their rule is broken. Report counts are out of date. |
| #11 assistant not confident | Partly | The test named as proof switches the Planner on by hand; it stays green with the switch bug back. |
| #12 money questions | Partly | The test fails only on two missing labels; the main change has no test. |
| #13 no florist in range | Partly | The model-name fix is tested; the cost-recording step is not (removing it leaves all green). |
| #37 which florist this is | Partly | All 6 tests pass with the line that wires the fix in removed. |
| #38 assistant failed | No fix | Notes only; its probe output is honest. |

Lesson, now in `writing-a-test.md` rules 2 and 9: the line that wires a fix
in is the one most often left untested, and the proof named in the report
must be a test the agent wrote and ran. Every test and its success rule is
on the Agent Test Bench,
one a day for the owner's verdict.

## Done when

One PR is reviewed with a clear verdict, and a skill (or new rules in
`verification-principles.md`) exists that the factory runs on every PR.

# The garden clock (Trigger.dev)

Trigger.dev keeps time; GitHub does the work. Each scheduled task in
`trigger/clock.ts` dispatches one GitHub workflow on `main` (table in `jobs.ts`).
The garden workflows carry no GitHub cron, because GitHub skips scheduled runs
under load (it dropped the 04:00 UTC jobs on 2026-10-14).

- Project `proj_your_project_ref`, environment **prod**. Live since 2026-10-14.
- Env vars in Trigger.dev prod: `GITHUB_DISPATCH_TOKEN` (fine-grained PAT, Actions
  read/write). `CLOCK_DRY_RUN=1` makes every task log the request instead of sending it.

## Keys in `.env`

| Name | What it is |
|---|---|
| `TRIGGER_SECRET_KEY` | dev environment key |
| `TRIGGER_PROD_SECRET_KEY` | prod environment key: lets a script read and set prod env vars and trigger tasks without a personal login |
| `TRIGGER_PROJECT_REF` | the project |
| `GITHUB_DISPATCH_TOKEN` | the token the clock dispatches with; `arm.mjs` copies it into Trigger.dev prod |

Deploying (`npx trigger.dev@latest deploy`) needs a personal access token
(`TRIGGER_ACCESS_TOKEN`, or the `trigger login` profile on the laptop); the
environment secret keys cannot deploy.

## Change a time

Edit `jobs.ts`, run `npm test` (a test fails if a garden workflow gets a GitHub
cron back or loses an input the clock sends), then deploy.

## Pause everything

Set `CLOCK_DRY_RUN=1` in Trigger.dev prod (dashboard, Environment variables). It
takes effect on the next run without a redeploy.

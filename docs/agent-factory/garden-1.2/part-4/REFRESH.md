# Morning refresh of the Manager Control Room

The cloud routine "Manager Control Room refresh" follows this file every hour
from 08:00 to 20:00, so work finished in Slack shows the same
day. It only reads data and republishes one page. It never commits, pushes,
opens PRs or changes the database.

1. **Get the history the build needs.** Factory fixes merge into `garden`;
   the receipts Claude leaves from the Slack manager channels live on
   `control-room-log` (`.claude/rules/slack-roles.md`):

   ```bash
   git fetch --unshallow origin 2>/dev/null || true
   git fetch origin garden
   git fetch origin control-room-log || true
   ```

2. **Check the garden settings.** `GARDEN_SUPABASE_URL` and `SUPABASE_API_KEY`
   must be set in the routine's environment. If either is empty, stop and
   report which one is missing.

3. **Run the tests, then build:**

   ```bash
   node --test docs/agent-factory/garden-1.2/part-4/control-app.test.mjs
   node docs/agent-factory/garden-1.2/part-4/build-control-app.mjs
   ```

   If a test fails, stop and do not publish: yesterday's page stays up. If
   the build throws, report the error and stop.

4. **Publish.** Publish
   `docs/agent-factory/garden-1.2/part-4/control-app.html` over yesterday's
   copy, at the same address. Never create a new page.

5. **Report** in one line: the build's printed summary, plus "published" or
   the reason it wasn't.

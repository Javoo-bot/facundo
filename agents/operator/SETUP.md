# Garden operator: setup

The garden's grey decisions (held agent replies and pending semi-auto steps)
reach a person through a Claude project. Every morning at 06:45 Madrid an email
to `owner@example.com` lists what is waiting and links to the project
(https://claude.ai/project/<your-project-id>). In the
project, Claude reads and answers the decisions through the "Garden operator"
connector, and every answer is recorded in the garden table `operator_decisions`.

Garden only: the worker refuses any database but the side project
`your-project-ref`, any dashboard but the garden one, and any digest inbox
but `owner@example.com`.

## The owner's clicks in claude.ai (once)

1. claude.ai → **Settings** → **Connectors** → **Add custom connector**.
2. Name: `Garden operator`. URL:
   `https://facundo-garden-operator.your-subdomain.workers.dev/mcp`.
   Leave the advanced OAuth fields empty. Click **Add**.
3. Click **Connect** on the new connector. A green "Garden operator" page opens.
   Write your name (it is recorded with every decision) and the garden
   passphrase: `GARDEN_OPERATOR_PASSPHRASE` in `dev_cx/.env`. Click **Connect**.
4. Open the project (link above) → **Project instructions** → paste the whole
   of `agents/operator/PROJECT-INSTRUCTIONS.md` → **Save**.
5. In a new chat inside the project, open the **tools** menu (the sliders icon
   under the message box) and switch **Garden operator** on.
6. Say "what's waiting?".

Claude asks before each `decide` call. To stop asking for approval on the read
tools, set `list_decisions`, `show_decision` and `today_summary` to "Always
allow" in the connector's settings; keep `decide` on "Ask".

## How it works

- `src/index.ts`: OAuth (Cloudflare `workers-oauth-provider`, dynamic client
  registration) in front of a stateless MCP endpoint at `/mcp`, and the cron.
  The authorize page asks for a name and the passphrase.
- `src/tools.ts`: the four tools.
- `src/dashboard.ts`: answers go through the garden dashboard's own staff
  routes, `/api/conversations/reply` and `/api/orders/approvals`, signed in as
  the garden staff account `owner+garden-operator@example.com` (role ops).
  So a decision runs exactly the code a CX click runs.
- `src/decisions.ts`: the pure part (what each answer does, the relay rule
  check, the email text). Tests: `npm test`.
- `schema.sql`: `operator_decisions`, applied to the garden database only.

The cron fires at 04:45 and 05:45 UTC; only the one that is 06:45 in Madrid
sends, so the email keeps its time across the clock change.

## Deploy

From `agents/operator`, with the garden token
(`CLOUDFLARE_WORKERS_API_KEY`, `CLOUDFLARE_ACCOUNT_ID` from `dev_cx/.env`):

```
npm install
npm test && npm run typecheck
npx wrangler deploy
```

Secrets on the worker (`wrangler secret put`): `SUPABASE_SERVICE_ROLE_KEY` and
`SUPABASE_ANON_KEY` (garden), `OPERATOR_PASSWORD` and `OPERATOR_PASSPHRASE`
(`GARDEN_OPERATOR_PASSWORD`, `GARDEN_OPERATOR_PASSPHRASE` in `dev_cx/.env`),
`RESEND_API_KEY` (the garden's Resend key). OAuth grants live in the KV
namespace `OAUTH_KV_GARDEN_OPERATOR`.

To shut everyone out, change `OPERATOR_PASSPHRASE` and delete the keys in that
KV namespace.

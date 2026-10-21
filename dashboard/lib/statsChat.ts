import type { createServiceClient } from "./supabaseAdmin";
import { isReadOnlySelect } from "./statsChatGuard";
import { traceAgentRun, type Generation } from "./agentTrace";

// KEEP IN SYNC: the 15 tables listed below are the same 15 that `stats_reader`
// is granted select on — 13 in supabase/migrations/2026-08-05-stats-reader-role.sql
// plus short_links and sms_events in 2026-08-06-stats-chat-sms-tables.sql — and
// that grant, not this prompt, is what the database enforces. Adding a table
// here without adding it there advertises a table the chat will get "permission
// denied" on; adding it there without adding it here hands out access nobody
// asked for. Both lists, one change.
//
// The last two are granted per COLUMN, not per table, because each holds a
// credential the chat must never print (short_links.code / .target_url front a
// florist login; sms_events.raw echoes the sent SMS, which contains that link).
// Hence the "name the columns" instruction at the end of the prompt — `select *`
// on those two fails rather than returning rows.
const SCHEMA_CONTEXT = `
You answer staff questions about Facundo's order-fulfilment operations by
writing PostgreSQL SELECT queries. You have one tool, run_sql. You may ONLY
query these tables:

- orders(id, city_id, status, created_at, ...) — one row per Shopify order.
- order_line_items(id, order_id, title, variant, sku, quantity, unit_price,
  line_total, product_type, ...) — items on an order. The product name is
  \`title\`, not \`product_title\`.
- order_assignments(id, order_id, florist_id, status, decline_reason, offer_kind,
  assigned_at, sent_at, opened_at, accepted_at, declined_at, delivered_at,
  sla_deadline_at, payout_price) — one row per florist offered an order.
  status: candidate|queued|sent|opened|declined|expired|accepted|reassigned|
  delivered|released. decline_reason is set on a PRE-accept decline; a
  POST-accept hand-back is status='released' with its own reason in the same
  column.
- delivery_events(id, assignment_id, type, created_at) — ready/delivered photo events.
- florists(id, name, city_id, email, source, trust_tier, ...) — the florist directory.
- order_issues(id, order_id, type, status, created_at, resolved_at) — post-accept
  problems raised by a florist or CX.
- communications(id, channel, audience, kind, order_id, florist_id, created_at,
  status, provider, provider_message_id) — one row per outbound email/push/SMS.
- email_events(id, communication_id, event_type, occurred_at) — Resend delivery/
  open/click/bounce events, joined to communications via communication_id.
  These cover EMAIL only.
- sms_events(id, communication_id, event_type, provider_event_id, error_code,
  error_detail, occurred_at) — Telnyx delivery receipts for SMS, the SMS
  counterpart of email_events, joined to communications the same way.
  event_type: queued|sending|sent|delivered|sending_failed|delivery_failed|
  delivery_unconfirmed. 'delivered' is the only success; the two *_failed values
  differ in whether the carrier had accepted it yet. There is NO 'opened' for
  SMS — nothing reports that a text was read, so never present an SMS open rate.
  Count DISTINCT communication_id per stage, not events, or one message Telnyx
  reports on twice reads as two deliveries.
- short_links(florist_id, assignment_id, kind, created_at, hit_count,
  first_hit_at, last_hit_at) — the shortened link carried by an outbound SMS,
  minted per send. THIS IS THE SMS CLICK SIGNAL: hit_count > 0 means that
  florist followed the link in their text, and first_hit_at is when. Use it for
  any "who clicked / opened / responded to an SMS" question — email_events
  cannot answer those. kind = 'magic' is the offer link (real engagement);
  kind = 'unsub' is the unsubscribe link, which is an opt-out, so exclude it
  unless the question is about opt-outs. Join to florists on florist_id, or to a
  specific offer on assignment_id.
- login_events(id, occurred_at, surface, user_email, florist_id, method) — every
  SUCCESSFUL staff/florist sign-in. Failures are NOT here; see login_failures.
- login_failures(id, occurred_at, stage, reason, detail, user_email, host,
  next_param, user_agent) — every FAILED sign-in attempt, from the auth
  callback. \`stage\` is 'code_exchange' (a code arrived but could not be
  exchanged), 'no_code' (nothing to exchange) or 'not_allowed' (a real session
  rejected by the allow list). \`user_email\` is only populated for
  'not_allowed' — an exchange failure has no user yet, so counting distinct
  people affected is not possible for those; count attempts, or group by
  \`user_agent\`. \`reason\` is the provider error code, e.g.
  'pkce_code_verifier_not_found', which means the sign-in was STARTED IN A
  DIFFERENT BROWSER than it finished in — typically a link opened inside a chat
  app (Google Chat, Slack, Teams), identifiable from \`user_agent\`.
  \`next_param\` = '/auth/reset' means the attempt was a password reset, not a
  sign-in.
- cities(id, city, country, region, center_lat, center_lng, radius_km) — target
  cities. The city name is \`city\`, not \`name\`.
- trust_tiers(code, ...) — florist trust-tier definitions.
- payouts(id, assignment_id, florist_id, leg, amount, currency, status) — payout legs.
- outreach(id, florist_id, channel, status, subject, test_mode, sent_by, sent_at)
  — recruiting outreach log. It has no \`kind\` or \`created_at\`; use \`sent_at\`
  for time.

On sms_events and short_links, always name the columns you want — \`select *\`
on those two is refused, because both hold columns you are not granted.

Always answer in plain language after seeing the query result — never just dump
raw rows. If a question needs data outside this table list, say so rather than
guessing.
`.trim();

const TOOL = {
  type: "function" as const,
  function: {
    name: "run_sql",
    description: "Run a read-only SQL SELECT against the tables listed in your instructions. Returns up to 500 rows as JSON.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "A single PostgreSQL SELECT or WITH statement." } },
      required: ["query"],
    },
  },
};

type ChatMessage = { role: "user" | "assistant" | "tool"; content: string; tool_call_id?: string; tool_calls?: unknown[] };

async function runSql(admin: ReturnType<typeof createServiceClient>, query: string, staffEmail: string): Promise<string> {
  const gate = isReadOnlySelect(query);
  console.log(`stats-chat run_sql by ${staffEmail}: ${query}`, gate.ok ? "" : `REJECTED: ${gate.reason}`);
  if (!gate.ok) return JSON.stringify({ error: gate.reason });

  const { data, error } = await admin.rpc("run_readonly_stats_query", { q: gate.query });
  if (error) return JSON.stringify({ error: error.message });
  return JSON.stringify(data);
}

/** Runs the OpenRouter tool-calling loop for one turn of the stats chat.
 * `model` is app_settings.stats_chat_model. Non-streaming — returns the final
 * assistant text once the model stops calling tools (capped at 5 rounds so a
 * confused model can't loop forever). */
export async function chatWithStats(
  admin: ReturnType<typeof createServiceClient>,
  model: string,
  history: { role: "user" | "assistant"; content: string }[],
  staffEmail: string,
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  const messages: ChatMessage[] = [{ role: "user", content: SCHEMA_CONTEXT }, ...history];
  // No row stores a stats-chat turn, so the Langfuse trace is the only record
  // of what Oracle was shown: every round's full message list.
  const generations: Generation[] = [];
  let answer: string | null = null;

  try {
    for (let round = 0; round < 5; round++) {
      const startedAt = new Date();
      const sent = [...messages];
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, tools: [TOOL] }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const detail = `OpenRouter HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`;
        generations.push({ name: `round-${round + 1}`, model, input: sent, output: null, error: detail, startedAt, endedAt: new Date() });
        throw new Error(detail);
      }

      const json = (await res.json()) as {
        choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
        usage?: unknown;
      };
      const message = json.choices?.[0]?.message;
      generations.push({
        name: `round-${round + 1}`, model, input: sent, output: message ?? null, usage: json.usage ?? null,
        error: message ? null : "no message", startedAt, endedAt: new Date(),
      });
      if (!message) throw new Error("OpenRouter returned no message");

      if (!message.tool_calls?.length) {
        answer = message.content ?? "";
        return answer;
      }

      messages.push({ role: "assistant", content: message.content ?? "", tool_calls: message.tool_calls });
      for (const call of message.tool_calls) {
        const args = JSON.parse(call.function.arguments) as { query?: string };
        const result = await runSql(admin, args.query ?? "", staffEmail);
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }
    answer = "I wasn't able to finish answering that — try narrowing the question.";
    return answer;
  } finally {
    await traceAgentRun({
      agent: "oracle",
      input: history,
      output: answer,
      metadata: { rounds: generations.length },
      generations,
    });
  }
}

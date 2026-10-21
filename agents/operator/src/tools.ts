import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { decisionsToday, loadDecision, openDecisions, order, record, thread } from "./db";
import { callDashboard, routeFor } from "./dashboard";
import { ACTIONS, finalText, madridDay, parseDecisionId, planDecision, type Decision } from "./decisions";
import { gardenEnv, type Env } from "./garden";
import { mailOperator } from "./mail";

const RELAY_RULE =
  "The relay rule: the florist never sees what the client paid or was refunded, only what to do " +
  '("use roses instead of tulips", "the client confirmed, go ahead"). Money, refunds and product changes are decided by the team; ' +
  "the florist hears only the outcome.";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function summary(d: Decision) {
  return {
    id: d.id,
    order: d.orderName,
    waiting: d.waiting,
    what_happened: d.what,
    why_the_agent_stopped: d.why,
    agents_draft: d.draft,
    since: d.since,
    with_owner: d.withOwner,
  };
}

export function createServer(rawEnv: Env, operator: string): McpServer {
  const env = gardenEnv(rawEnv);
  const server = new McpServer({ name: "Garden operator", version: "1.0.0" });

  server.registerTool(
    "list_decisions",
    {
      title: "What's waiting",
      description:
        "Lists the garden's open grey decisions: things an agent would not decide alone and parked for a person. " +
        "Each item says what happened, who is waiting, the agent's draft reply (if any) and why the agent stopped. " +
        "Items already passed to the owner are left out unless include_with_owner is true. Garden (test) data only.",
      inputSchema: z.object({
        hours: z.number().int().min(1).max(24 * 30).default(24).describe("How far back to look, in hours. Default 24 (today)."),
        include_with_owner: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ hours, include_with_owner }) => {
      const all = await openDecisions(env, hours);
      const shown = include_with_owner ? all : all.filter((d) => !d.withOwner);
      return text(JSON.stringify({ count: shown.length, with_owner: all.filter((d) => d.withOwner).length, decisions: shown.map(summary) }, null, 1));
    },
  );

  server.registerTool(
    "show_decision",
    {
      title: "Show one decision",
      description:
        "Full context for one decision: the order, the whole conversation, the agent's draft, and the instructions and facts " +
        "the agent was given when it wrote the draft. The order's total is what the client paid: never pass it to the florist. " +
        RELAY_RULE,
      inputSchema: z.object({ id: z.string().describe('The id from list_decisions, e.g. "c-…" or "a-…".') }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const parsed = parseDecisionId(id);
      if (!parsed) return text(`"${id}" is not a decision id. Use an id from list_decisions.`);
      const loaded = await loadDecision(env, parsed.source, parsed.sourceId);
      if (!loaded) return text("No such decision.");
      const d = loaded.decision;
      const [orderRow, messages] = await Promise.all([
        d.orderId ? order(env, d.orderId) : null,
        d.source === "conversation" ? thread(env, d.sourceId) : null,
      ]);
      return text(
        JSON.stringify(
          {
            ...summary(d),
            still_open: loaded.open,
            agent: d.agent,
            draft_subject: d.draftSubject,
            order_details: orderRow,
            conversation: messages?.map((m) => ({
              at: m.created_at,
              from: m.direction === "in" ? "florist" : m.ai_generated ? "agent" : (m.actor ?? "team"),
              status: m.status,
              text: m.body_text,
            })),
            agent_instructions_and_facts: d.aiContext,
          },
          null,
          1,
        ),
      );
    },
  );

  server.registerTool(
    "decide",
    {
      title: "Decide",
      description:
        "Answer one decision. Actions: approve_draft (send the agent's draft as it is, or say yes to the step), " +
        "send_my_reply (send your own words in `text` instead of the draft), reject (send nothing: closes the conversation, or declines the step; " +
        "put why in `note`), escalate_to_owner (too tricky or about money: The owner gets an email, put why in `note`). " +
        "It goes through the same dashboard buttons the CX team uses, and every decision is recorded with the agent's draft beside the final text. " +
        "Always confirm with the operator before calling it. " +
        RELAY_RULE +
        " A reply to a florist that mentions an amount of money or a refund is refused; rephrase it as what to do.",
      inputSchema: z.object({
        id: z.string(),
        action: z.enum(ACTIONS as [string, ...string[]]),
        text: z.string().optional().describe("Your reply, for send_my_reply. Friendly and short, in the florist's language."),
        note: z.string().optional().describe("Why, in a few words. Kept with the decision."),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ id, action, text: reply, note }) => {
      const parsed = parseDecisionId(id);
      if (!parsed) return text(`"${id}" is not a decision id. Use an id from list_decisions.`);
      const loaded = await loadDecision(env, parsed.source, parsed.sourceId);
      if (!loaded) return text("No such decision.");
      if (!loaded.open) return text("Already handled (someone answered it, or the step moved on). Nothing was sent.");
      const d = loaded.decision;
      const input = { action: action as (typeof ACTIONS)[number], text: reply, note };
      const plan = planDecision(d, input);
      if (plan.kind === "refuse") return text(plan.why);

      if (plan.kind === "to_owner") {
        if (d.withOwner) return text("Already with the owner.");
        await mailOperator(
          env,
          `For the owner: ${d.orderName ?? "garden"} · ${d.waiting}`,
          [`${operator} passed this to you.`, "", `What happened: ${d.what}`, `Why the agent stopped: ${d.why}`, d.draft ? `Agent's draft: ${d.draft}` : "", note ? `Note: ${note}` : "", "", `Decision id: ${d.id}`]
            .filter((l) => l !== "")
            .join("\n"),
        );
        await record(env, { decision: d, action: "escalate_to_owner", finalText: null, note: note ?? null, operator });
        return text("Passed to the owner by email. It leaves your list.");
      }

      const call = routeFor(plan)!;
      const result = await callDashboard(env, call);
      if (!result.ok) return text(`It did not go through: ${result.error}. Nothing was recorded.`);
      const sent = finalText(d, input);
      await record(env, { decision: d, action: input.action, finalText: sent, note: note ?? null, operator });
      if (plan.kind === "reply") return text(`Sent to ${d.waiting}: "${sent}"`);
      if (plan.kind === "close") return text("Closed. Nothing was sent.");
      if (plan.kind === "reject") return text("Step declined.");
      return text(plan.edits ? "Approved with your text." : "Approved.");
    },
  );

  server.registerTool(
    "today_summary",
    {
      title: "Today in one look",
      description: "How many decisions are waiting, how many are with the owner, and what was decided today (Madrid time), by action and agent.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const day = madridDay(new Date());
      const [open, done] = await Promise.all([openDecisions(env, 24), decisionsToday(env, new Date(Date.now() - 24 * 3600_000).toISOString())]);
      const count = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {});
      return text(
        JSON.stringify(
          {
            day,
            waiting: open.filter((d) => !d.withOwner).length,
            with_owner: open.filter((d) => d.withOwner).length,
            decided_last_24h: done.length,
            by_action: count(done.map((r) => r.action)),
            by_agent: count(done.map((r) => r.agent ?? "unknown")),
          },
          null,
          1,
        ),
      );
    },
  );

  return server;
}

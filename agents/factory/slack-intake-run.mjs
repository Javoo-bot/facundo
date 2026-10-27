// Slack intake, I/O half. Reads #cx-desk from a bookmark, looks each order up
// in the garden, answers in the message's thread, and writes factory_alerts
// (source 'slack'; the sweep turns them into cards on a general rule by
// CARD_LIFE in general-rules.mjs) and slack_intake (one row per message, and
// the one question still waiting).
//
//   SLACK_BOT_TOKEN=xoxb-... SLACK_CX_DESK_CHANNEL_ID=C... \
//   GARDEN_SUPABASE_URL=... GARDEN_SUPABASE_SERVICE_ROLE_KEY=... node agents/factory/slack-intake-run.mjs [--dry-run]
//
// Off (prints why, exits 0) until the Slack app exists: see "Slack intake" in
// agents/factory/README.md. The pure half is slack-intake.mjs.
//
// Reading safely (docs/agent-factory/human-loop.md, the owner 2026-10-13):
// 1. a bookmark per source: the last Slack ts handled, never "the last hour";
// 2. re-check before posting: the order is read live right before the reply;
// 3. save after the post: the alert, the row and the bookmark are written only
//    once the reply went through. A failed post stops the run with nothing
//    saved, so the retry starts from the same message.

import { pathToFileURL } from "node:url";
import { decide, parseOpsMessage, questionExpired, slackAlert, PASS_TO_OWNER } from "./slack-intake.mjs";
import { madridDay } from "../monitoring/deep-analysis.mjs";

const SOURCE = "slack:cx-desk";
const FIRST_RUN_LOOKBACK_MS = 3600_000;

/** A message a person wrote at the top of the channel: not ours, not a join,
 * edit or bot post, and not a reply inside a thread. */
export function isOpsMessage(m, botUserId) {
  return !!m.text && !m.subtype && !m.bot_id && m.user !== botUserId && (!m.thread_ts || m.thread_ts === m.ts);
}

const tsAfter = (a, b) => Number(a) > Number(b);

/**
 * One pass. `slack` and `garden` are the two doors to the world; tests pass fakes.
 * slack:  { channelId, botUserId, history(oldest), replies(ts), post(threadTs, text), permalink(ts) }
 * garden: { bookmark(), saveBookmark(ts), pending(), known(ts), findOrder(names), saveItem(row), saveAlert(row) }
 */
export async function runIntake({ slack, garden, now = Date.now(), dryRun = false, log = console.log }) {
  const done = [];

  async function settle(row, outcome, order) {
    if (dryRun) { log(`[dry run] ${row.ts}: ${outcome.kind} -> "${outcome.reply}"`); done.push({ ts: row.ts, kind: outcome.kind }); return; }
    const reply = await slack.post(row.ts, outcome.reply);
    const at = new Date(now).toISOString();
    if (outcome.kind === "alert") {
      const permalink = await slack.permalink(row.ts).catch(() => null);
      const alert = slackAlert({ outcome, order, text: row.text, channel: slack.channelId, ts: row.ts, permalink });
      await garden.saveAlert({ ...alert, placed_at: at, last_seen_at: at, placed_day: madridDay(new Date(now)) });
    }
    await garden.saveItem({
      channel: slack.channelId, ts: row.ts, user_id: row.user_id, text: row.text, order_name: order?.order_name ?? row.order_name ?? null,
      state: outcome.kind === "ask" ? "asked" : outcome.kind === "pass" ? "passed" : outcome.kind,
      question: outcome.question ?? row.question ?? null, rule_id: outcome.rule ?? null, why: outcome.why ?? null,
      reply_ts: reply?.ts ?? null, updated_at: at,
    });
    done.push({ ts: row.ts, kind: outcome.kind, rule: outcome.rule ?? null });
  }

  // 1. The questions we asked: an answer settles them, silence past the wait passes them on.
  for (const row of await garden.pending()) {
    const answer = (await slack.replies(row.ts)).find((m) => tsAfter(m.ts, row.reply_ts) && m.user !== slack.botUserId && !m.bot_id && m.text);
    if (!answer) {
      if (questionExpired(row.updated_at, now)) await settle(row, { kind: "pass", why: "no answer to our question", reply: PASS_TO_OWNER }, null);
      continue;
    }
    const parsed = parseOpsMessage(`${row.text} ${answer.text}`);
    const names = row.question?.about === "order" ? parseOpsMessage(answer.text).orderNames : [row.order_name];
    const order = names.length ? await garden.findOrder(names) : null;
    await settle(row, decide({ parsed, order, asked: row.question, answer: answer.text, now }), order);
  }

  // 2. New messages since the bookmark, oldest first; the bookmark moves after each one.
  // The very first run has no bookmark and starts an hour back, not at the
  // channel's first message.
  const from = (await garden.bookmark()) ?? ((now - FIRST_RUN_LOOKBACK_MS) / 1000).toFixed(6);
  for (const m of await slack.history(from)) {
    if (from && !tsAfter(m.ts, from)) continue;
    if (isOpsMessage(m, slack.botUserId) && !(await garden.known(m.ts))) {
      const parsed = parseOpsMessage(m.text);
      const order = parsed.orderNames.length ? await garden.findOrder(parsed.orderNames) : null;
      await settle({ ts: m.ts, user_id: m.user, text: parsed.text, order_name: parsed.orderNames[0] ?? null }, decide({ parsed, order, now }), order);
    }
    if (!dryRun) await garden.saveBookmark(m.ts);
  }
  return done;
}

// ---- The real doors --------------------------------------------------------------

export function slackApi(token, channelId, fetchImpl = fetch) {
  async function call(method, params, post = false) {
    const url = new URL(`https://slack.com/api/${method}`);
    if (!post) for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
    const res = await fetchImpl(url, {
      method: post ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, ...(post ? { "Content-Type": "application/json; charset=utf-8" } : {}) },
      body: post ? JSON.stringify(params) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json();
    if (!body.ok) throw new Error(`Slack ${method}: ${body.error ?? res.status}`);
    return body;
  }
  async function pages(method, params, key) {
    const out = [];
    let cursor;
    do {
      const body = await call(method, { ...params, limit: 200, cursor });
      out.push(...body[key]);
      cursor = body.response_metadata?.next_cursor || null;
    } while (cursor);
    return out;
  }
  return {
    channelId,
    botUserId: null,
    async init() { this.botUserId = (await call("auth.test", {})).user_id; return this; },
    history: async (oldest) => (await pages("conversations.history", { channel: channelId, oldest: oldest ?? undefined, inclusive: false }, "messages")).sort((a, b) => Number(a.ts) - Number(b.ts)),
    replies: async (ts) => pages("conversations.replies", { channel: channelId, ts }, "messages"),
    post: async (threadTs, text) => call("chat.postMessage", { channel: channelId, thread_ts: threadTs, text, unfurl_links: false }, true),
    permalink: async (ts) => (await call("chat.getPermalink", { channel: channelId, message_ts: ts })).permalink,
  };
}

export function gardenStore({ rest, selectAll }, channelId) {
  const enc = encodeURIComponent;
  return {
    async bookmark() {
      const [b] = await rest("GET", `factory_bookmarks?source=eq.${enc(SOURCE)}&select=position`);
      return b?.position ?? null;
    },
    saveBookmark: (ts) => rest("POST", "factory_bookmarks?on_conflict=source", { source: SOURCE, position: ts, updated_at: new Date().toISOString() }, { Prefer: "resolution=merge-duplicates,return=minimal" }),
    pending: () => selectAll(`slack_intake?channel=eq.${channelId}&state=eq.asked&select=*&order=ts.asc`),
    known: async (ts) => (await rest("GET", `slack_intake?channel=eq.${channelId}&ts=eq.${ts}&select=ts`)).length > 0,
    saveItem: (row) => rest("POST", "slack_intake?on_conflict=channel,ts", row, { Prefer: "resolution=merge-duplicates,return=minimal" }),
    // The same alert reported again keeps its first placing and is seen now,
    // as the sweep does for a problem still there.
    async saveAlert(row) {
      await rest("POST", "factory_alerts", row, { Prefer: "resolution=ignore-duplicates,return=minimal" });
      await rest("PATCH", `factory_alerts?alert_id=eq.${enc(row.alert_id)}`, { last_seen_at: row.last_seen_at }, { Prefer: "return=minimal" });
    },
    // The live state of the first named order the garden has.
    async findOrder(names) {
      const list = `(${names.map((n) => `"${n}"`).join(",")})`;
      const found = await rest("GET", `orders?order_name=in.${enc(list)}&deleted_at=is.null&select=id,order_name,status,escalation_reason,delivery_at`);
      const order = names.map((n) => found.find((o) => o.order_name === n)).find(Boolean);
      if (!order) return null;
      const [offers, photos, waiting] = await Promise.all([
        rest("GET", `order_assignments?order_id=eq.${order.id}&select=status,florist:florists(name)&order=assigned_at.desc&limit=1`),
        rest("GET", `photo_verifications?order_id=eq.${order.id}&select=verdict&order=created_at.desc&limit=1`),
        rest("GET", `conversations?order_id=eq.${order.id}&status=eq.awaiting_human&select=id`),
      ]);
      return { ...order, offer: offers[0]?.status ?? null, florist: offers[0]?.florist?.name ?? null, photo: photos[0]?.verdict ?? null, waiting_conversations: waiting.length };
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { SLACK_BOT_TOKEN: token, SLACK_CX_DESK_CHANNEL_ID: channel } = process.env;
  if (!token || !channel) {
    console.log("slack intake off: SLACK_BOT_TOKEN and SLACK_CX_DESK_CHANNEL_ID are not both set");
  } else {
    const { gardenRest } = await import("../monitoring/garden-rest.mjs");
    const slack = await slackApi(token, channel).init();
    const done = await runIntake({ slack, garden: gardenStore(gardenRest(), channel), dryRun: process.argv.includes("--dry-run") });
    console.log(`slack intake: ${done.length} message(s) handled`);
    if (done.length) console.table(done);
  }
}

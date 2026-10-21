// Garden only. Pretend florists and clients answer the garden's emails: a small
// Workers AI model writes each reply in persona, and the reply goes in through the
// garden dashboard's real inbound email webhook, so the real support agent handles
// it. Port of agents/garden/actors/run.mjs, which ran on the owner's laptop with Ollama.
//
// Production runs this same file. Every condition in actorsGate must hold, and
// production has none of them (see docs/agent-factory/garden-deploy.md).
import { createServiceClient } from "./db";
import { PERSONAS_TXT } from "./gardenPersonas";
import type { Env } from "./types";

/** Minutes 5, 15, 25…: every 10 minutes, off the round minutes the daily digest uses. */
export function isActorsMinute(scheduledTimeMs: number): boolean {
  return new Date(scheduledTimeMs).getUTCMinutes() % 10 === 5;
}
export const GARDEN_DB = "your-project-ref";
export const ACTOR_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";
export const EVENT_PREFIX = "garden-actor";
export const MAX_OUTBOUND_AGE_MS = 36 * 3600 * 1000;
/** Inbound emails per run, counting each half of a burst. */
export const MAX_PER_RUN = 4;
// About 16 neurons a model call; 150 emails a day stays far inside the free 10,000 neurons a day.
export const MAX_PER_DAY = 150;
export const BURST_GAP_MS = 20_000;
/** How far back persona assignments count when spreading new conversations across personas. */
export const ASSIGNMENT_WINDOW_MS = 3 * 86400e3;
export const ASSIGN_OPERATION = "persona_assign";

export type Role = "florist" | "client";
export interface Persona {
  id: string; role: Role;
  /** "order", one code, or several codes joined by "/" (one picked per conversation). */
  lang: string;
  maxReplies: number; brief: string;
  /** Each reply goes in as two separate emails, BURST_GAP_MS apart. */
  burst: boolean;
}
/** Which persona plays one conversation (one person on one order), recorded in external_ops. */
export interface Assignment { orderId: string; person: string; personaId: string; atMs: number }
export interface Comm {
  id: string; created_at: string; audience: string; kind?: string | null; order_id: string;
  florist_id: string | null; subject?: string | null; body?: string | null;
  rfc_message_id?: string | null; provider_message_id?: string | null;
}
export interface Order {
  id: string; order_name: string | null; tags: string | null; locale?: string | null;
  buyer_name?: string | null; buyer_email?: string | null; recipient_name?: string | null;
  delivery_address?: unknown; delivery_at?: string | null; greeting?: string | null;
}
export interface Florist { id: string; name: string | null; email: string | null; place_id: string | null }
export interface PlannedReply {
  comm: Comm; persona: Persona; eventId: string;
  /** 1 for the persona's first reply in this conversation. */
  turn: number;
  /** "order" or a single language code. */
  lang: string;
}

export function parsePersonas(text: string): Persona[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [id, role, lang, max, brief, options = "", ...rest] = l.split("|").map((s) => s.trim());
      const flags = options.split(",").map((s) => s.trim()).filter(Boolean);
      const maxReplies = Number(max);
      const ok = (role === "florist" || role === "client") && !!brief && !!lang && !!id && !id.includes(":")
        && Number.isInteger(maxReplies) && maxReplies >= 0 && !rest.length && flags.every((f) => f === "burst");
      if (!ok) throw new Error(`bad persona line: ${l}`);
      return { id, role, lang, maxReplies, brief, burst: flags.includes("burst") };
    });
}

export function isGardenOrder(order: Pick<Order, "order_name" | "tags">): boolean {
  return /^#?GARDEN-/.test(order.order_name ?? "") || /\bGARDEN\b/.test(order.tags ?? "");
}

export function isPlusAddressOf(address: string | null | undefined, base: string | null | undefined): boolean {
  if (!address || !base) return false;
  const [local, domain] = base.toLowerCase().split("@");
  const a = address.toLowerCase().trim();
  return a.startsWith(`${local}+`) && a.endsWith(`@${domain}`) && a.length > local.length + domain.length + 2;
}

/** An invented client: a plus-address of the test inbox, or an unroutable .example address. */
export function isGardenClient(email: string | null | undefined, testEmail: string | null | undefined): boolean {
  return isPlusAddressOf(email, testEmail) || /@[^@\s]+\.example$/i.test(email ?? "");
}

/** A florist the weather invented: place_id GARDEN_… or a "[GARDEN]" name, with an email to reply from. */
export function isGardenFlorist(florist: Pick<Florist, "place_id" | "name" | "email">): boolean {
  const marked = (florist.place_id ?? "").startsWith("GARDEN_") || (florist.name ?? "").includes("[GARDEN]");
  return marked && /^[^@\s]+@[^@\s]+$/.test(florist.email ?? "");
}

export function personKey(comm: Pick<Comm, "audience" | "florist_id">): string {
  return comm.audience === "client" ? "client" : `f-${comm.florist_id}`;
}

export function eventId(comm: Comm): string {
  return `${EVENT_PREFIX}:${comm.order_id}:${personKey(comm)}:${comm.id}`;
}

export function parseEventId(id: string | null | undefined): { orderId: string; person: string; sourceId: string } | null {
  const [prefix, orderId, person, sourceId] = (id ?? "").split(":");
  return prefix === EVENT_PREFIX && sourceId ? { orderId, person, sourceId } : null;
}

async function hash(s: string): Promise<number> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return new DataView(d).getUint32(0);
}

/**
 * A new conversation gets the persona of its role used least in the window, so every
 * persona comes up once per pool-size conversations. Ties break by a hash of the
 * conversation, so the pick does not depend on row order.
 */
export async function pickPersona(pool: Persona[], used: Map<string, number>, convKey: string): Promise<Persona> {
  const fewest = Math.min(...pool.map((p) => used.get(p.id) ?? 0));
  const ties = pool.filter((p) => (used.get(p.id) ?? 0) === fewest);
  return ties[(await hash(convKey)) % ties.length];
}

/** "fr/it/de" becomes one of the three, fixed per conversation. */
export async function langFor(persona: Persona, convKey: string): Promise<string> {
  const options = persona.lang.split("/").map((s) => s.trim()).filter(Boolean);
  return options[(await hash(`lang:${convKey}`)) % options.length];
}

/**
 * Which outbound emails get a pretend reply this run, and which conversations got a
 * persona for the first time (the caller records those before sending anything).
 * One reply per person per order, only to that person's latest email, never to the
 * same email twice, and never more than the persona's limit in a conversation; a
 * persona with limit 0 is assigned and recorded but never replies.
 */
export async function planReplies(
  comms: Comm[], priorEventIds: string[], personas: Persona[], nowMs: number, assignments: Assignment[] = [],
): Promise<{ plan: PlannedReply[]; assigned: Assignment[] }> {
  const prior = priorEventIds.map(parseEventId).filter((p): p is NonNullable<typeof p> => p !== null);
  const byId = new Map(personas.map((p) => [p.id, p]));
  const current = new Map<string, Persona>();
  const used = new Map<string, number>();
  for (const a of assignments) {
    const p = byId.get(a.personaId);
    if (!p) continue;
    current.set(`${a.orderId}:${a.person}`, p);
    if (nowMs - a.atMs <= ASSIGNMENT_WINDOW_MS) used.set(p.id, (used.get(p.id) ?? 0) + 1);
  }
  const latest = new Map<string, Comm>();
  for (const c of comms) {
    const key = `${c.order_id}:${personKey(c)}`;
    const cur = latest.get(key);
    if (!cur || c.created_at > cur.created_at) latest.set(key, c);
  }
  const plan: PlannedReply[] = [];
  const assigned: Assignment[] = [];
  for (const [key, c] of latest) {
    if (nowMs - Date.parse(c.created_at) > MAX_OUTBOUND_AGE_MS) continue;
    const person = personKey(c);
    let persona = current.get(key);
    if (!persona) {
      const role: Role = c.audience === "client" ? "client" : "florist";
      persona = await pickPersona(personas.filter((p) => p.role === role), used, key);
      used.set(persona.id, (used.get(persona.id) ?? 0) + 1);
      current.set(key, persona);
      assigned.push({ orderId: c.order_id, person, personaId: persona.id, atMs: nowMs });
    }
    const replied = new Set(prior.filter((p) => p.orderId === c.order_id && p.person === person).map((p) => p.sourceId));
    if (replied.has(c.id) || replied.size >= persona.maxReplies) continue;
    plan.push({ comm: c, persona, eventId: eventId(c), turn: replied.size + 1, lang: await langFor(persona, key) });
  }
  return { plan, assigned };
}

/** Emails one planned reply sends. */
export function messageCount(item: PlannedReply): number {
  return item.persona.burst ? 2 : 1;
}

/** The planned replies that fit in this many emails, in order; a burst that does not fit waits. */
export function withinBudget(plan: PlannedReply[], budget: number): PlannedReply[] {
  const out: PlannedReply[] = [];
  let left = budget;
  for (const item of plan) {
    if (messageCount(item) > left) continue;
    out.push(item);
    left -= messageCount(item);
  }
  return out;
}

/** The two halves of a burst reply. The model is asked to separate them with "---". */
export function splitBurst(text: string): string[] {
  for (const sep of [/^\s*-{3,}\s*$/m, /\n\s*\n/]) {
    const parts = text.split(sep).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) return [parts[0], parts.slice(1).join("\n\n")];
  }
  const sentences = text.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  if (sentences.length < 2) return [text.trim()];
  const half = Math.ceil(sentences.length / 2);
  return [sentences.slice(0, half).join(" "), sentences.slice(half).join(" ")];
}

/** orders.delivery_address is a string on old rows and {line1, line2, postal, city, ...} on new ones. */
export function formatAddress(a: unknown): string {
  if (!a || typeof a === "string") return (a as string | null) ?? "";
  const o = a as Record<string, string | undefined>;
  return [o.line1, o.line2, [o.postal, o.city].filter(Boolean).join(" "), o.region, o.country].filter(Boolean).join(", ");
}

const LANG: Record<string, string> = { es: "Spanish", en: "English", fr: "French", de: "German", it: "Italian", pt: "Portuguese", nl: "Dutch" };

export function buildPrompt(item: PlannedReply, order: Order, florist: Florist | undefined): string {
  const { persona, comm } = item;
  const lang = LANG[item.lang === "order" ? (order.locale ?? "en").slice(0, 2) : item.lang] ?? "English";
  const who = persona.role === "florist"
    ? `You are the florist shop "${florist?.name}". Facundo, a flower delivery company, sends you orders to make and deliver.`
    : `You are ${order.buyer_name ?? "a customer"}, who ordered flowers from Facundo for ${order.recipient_name ?? "someone"}.`;
  const facts = persona.role === "florist"
    ? `Order ${order.order_name}, deliver to ${formatAddress(order.delivery_address)}, on ${order.delivery_at}.`
    : `Your order ${order.order_name}: recipient ${order.recipient_name}, address ${formatAddress(order.delivery_address)}, delivery ${order.delivery_at}, card message "${order.greeting ?? ""}".`;
  return [
    `${who} This is a test with invented people; play your part naturally.`,
    `How you write: ${persona.brief}`,
    `What you know: ${facts}`,
    `You just received this email from Facundo:\nSubject: ${comm.subject ?? ""}\n${(comm.body ?? "").slice(0, 1500)}`,
    item.turn === 1 ? "This is your first reply in this conversation." : `This is your reply number ${item.turn} in this conversation.`,
    persona.burst
      ? `Write two separate short emails you send one after the other, in ${lang}, each at most 2 sentences, with a line containing only --- between them. No subject line, no placeholders, never say you are an AI.`
      : `Write only the body of your reply email, in ${lang}, at most 4 sentences. No subject line, no placeholders, never say you are an AI.`,
  ].join("\n\n");
}

/** Drops any reasoning block and a "Subject:" line the model adds despite being told not to. */
export function cleanReply(text: string): string {
  const end = text.lastIndexOf("</think>");
  const body = end >= 0 ? text.slice(end + "</think>".length) : text;
  return body.trim().replace(/^subject:[^\n]*\n+/i, "").trim();
}

function b64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

/** Svix v1 signature, the scheme dashboard/lib/resendWebhookGuard.ts verifies. */
export async function svixHeaders(id: string, payload: string, secret: string, nowMs = Date.now()): Promise<Record<string, string>> {
  const ts = String(Math.floor(nowMs / 1000));
  const raw = Uint8Array.from(atob(secret.split("_")[1] ?? ""), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${payload}`));
  return { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${b64(sig)}` };
}

export function inboundPayload(item: PlannedReply, order: Order, florist: Florist | undefined, text: string, id = item.eventId): string {
  const { comm } = item;
  const fromAddr = comm.audience === "client" ? order.buyer_email : florist?.email;
  const fromName = comm.audience === "client" ? order.buyer_name : florist?.name;
  const msgId = comm.rfc_message_id ?? `<${comm.provider_message_id}@resend.dev>`;
  return JSON.stringify({
    type: "email.received",
    data: {
      email_id: id,
      from: `${fromName} <${fromAddr}>`,
      to: [`reply@${msgId.split("@")[1]?.replace(">", "") ?? "fc.example.com"}`],
      subject: /^re:/i.test(comm.subject ?? "") ? comm.subject : `Re: ${comm.subject ?? ""}`,
      text,
      headers: { "in-reply-to": msgId, references: msgId },
    },
  });
}

export type PostInbound = (id: string, payload: string) => Promise<{ status: number; text: string }>;

/**
 * Sends one planned reply through the inbound webhook: one email, or for a burst
 * persona two emails BURST_GAP_MS apart, the second with id "<eventId>:2".
 */
export async function deliver(
  item: PlannedReply, order: Order, florist: Florist | undefined, reply: string,
  post: PostInbound, sleep: (ms: number) => Promise<void>,
): Promise<{ id: string; status: number; text: string; body: string }[]> {
  const parts = item.persona.burst ? splitBurst(reply) : [reply];
  const sent = [];
  for (const [i, body] of parts.entries()) {
    if (i > 0) await sleep(BURST_GAP_MS);
    const id = i === 0 ? item.eventId : `${item.eventId}:${i + 1}`;
    sent.push({ id, body, ...(await post(id, inboundPayload(item, order, florist, body, id))) });
  }
  return sent;
}

/** Every condition must hold. Production has none of them; the garden has all. */
export function actorsGate(env: Partial<Env>): { ok: true; ai: Ai; secret: string; dashboard: string } | { ok: false; reason: string } {
  if (env.GARDEN_ACTORS !== "1") return { ok: false, reason: "GARDEN_ACTORS is not 1" };
  if (!env.AI) return { ok: false, reason: "no AI binding" };
  if (!env.GARDEN_INBOUND_WEBHOOK_SECRET) return { ok: false, reason: "no GARDEN_INBOUND_WEBHOOK_SECRET" };
  if (env.SUPABASE_URL !== `https://${GARDEN_DB}.supabase.co`) return { ok: false, reason: "SUPABASE_URL is not the garden database" };
  if (!env.DASHBOARD_URL?.includes("garden")) return { ok: false, reason: "DASHBOARD_URL is not the garden dashboard" };
  return { ok: true, ai: env.AI, secret: env.GARDEN_INBOUND_WEBHOOK_SECRET, dashboard: env.DASHBOARD_URL };
}

export interface ActorsResult { ran: boolean; reason?: string; due?: number; lines: string[] }

export async function runGardenActors(env: Env, nowMs = Date.now()): Promise<ActorsResult> {
  const gate = actorsGate(env);
  if (!gate.ok) return { ran: false, reason: gate.reason, lines: [] };
  const sb = createServiceClient(env);
  const q = async <T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> => {
    const { data, error } = await p;
    if (error) throw new Error(`${what}: ${error.message}`);
    return data as T;
  };

  const settings = await q<{ test_mode: boolean; test_email: string | null } | null>(
    sb.from("app_settings").select("test_mode,test_email").limit(1).maybeSingle(), "app_settings");
  if (!settings?.test_mode || !settings.test_email) return { ran: false, reason: "garden test_mode is off or test_email unset", lines: [] };

  const since = new Date(nowMs - 2 * 86400e3).toISOString();
  const orders = (await q<Order[]>(
    sb.from("orders").select("id,order_name,tags,locale,buyer_name,buyer_email,recipient_name,delivery_address,delivery_at,greeting")
      .gte("created_at", since).or("order_name.like.*GARDEN-*,tags.like.*GARDEN*"), "orders")).filter(isGardenOrder);
  if (!orders.length) return { ran: true, due: 0, lines: [] };
  const byOrder = new Map(orders.map((o) => [o.id, o]));

  // A failed send still counts as received: the pretend person stands in for whoever
  // the garden meant to reach.
  const comms = await q<Comm[]>(
    sb.from("communications").select("id,created_at,audience,kind,order_id,florist_id,subject,body,rfc_message_id,provider_message_id")
      .eq("channel", "email").in("status", ["sent", "failed"]).in("audience", ["florist", "client"])
      .in("order_id", orders.map((o) => o.id)), "communications");
  const floristIds = [...new Set(comms.map((c) => c.florist_id).filter((id): id is string => !!id))];
  const florists = new Map((floristIds.length
    ? await q<Florist[]>(sb.from("florists").select("id,name,email,place_id").in("id", floristIds), "florists")
    : []).map((f) => [f.id, f]));
  const eligible = comms.filter((c) =>
    c.audience === "client"
      ? isGardenClient(byOrder.get(c.order_id)?.buyer_email, settings.test_email)
      : florists.has(c.florist_id ?? "") && isGardenFlorist(florists.get(c.florist_id ?? "")!));

  // Bounded so the newest rows always fit under PostgREST's 1,000-row cap: a reply
  // only matters while its conversation's latest email is under 36 hours old.
  const recent = new Date(nowMs - ASSIGNMENT_WINDOW_MS).toISOString();
  const prior = await q<{ provider_event_id: string; created_at: string }[]>(
    sb.from("conversation_messages").select("provider_event_id,created_at")
      .eq("direction", "in").like("provider_event_id", `${EVENT_PREFIX}:%`)
      .gte("created_at", recent).order("created_at", { ascending: false }), "conversation_messages");
  const ledger = await q<{ ref: string; meta: { persona?: string } | null; created_at: string }[]>(
    sb.from("external_ops").select("ref,meta,created_at")
      .eq("provider", EVENT_PREFIX).eq("operation", ASSIGN_OPERATION)
      .gte("created_at", recent).order("created_at", { ascending: false }), "external_ops");
  const assignments: Assignment[] = ledger.flatMap((r) => {
    const [orderId, person] = r.ref.split(":");
    return r.meta?.persona && person ? [{ orderId, person, personaId: r.meta.persona, atMs: Date.parse(r.created_at) }] : [];
  });

  const today = new Date(nowMs).toISOString().slice(0, 10);
  const left = MAX_PER_DAY - prior.filter((m) => m.created_at.startsWith(today)).length;
  const all = parsePersonas(PERSONAS_TXT);
  const { plan: due, assigned } = await planReplies(eligible, prior.map((m) => m.provider_event_id), all, nowMs, assignments);

  // Recorded before any reply goes out, so a conversation keeps its persona, and a
  // silent one is never picked up again as if it were new.
  const personas = new Map(all.map((p) => [p.id, p]));
  if (assigned.length) {
    await q(sb.from("external_ops").insert(assigned.map((a) => ({
      provider: EVENT_PREFIX, operation: ASSIGN_OPERATION, direction: "out", order_id: a.orderId,
      ref: `${a.orderId}:${a.person}`, ok: true,
      meta: { persona: a.personaId, silent: personas.get(a.personaId)?.maxReplies === 0 },
    }))), "external_ops insert");
  }
  const lines = assigned
    .filter((a) => personas.get(a.personaId)?.maxReplies === 0)
    .map((a) => `${byOrder.get(a.orderId)?.order_name} ${a.personaId}: stays silent (recorded)`);

  const plan = withinBudget(due, Math.max(0, Math.min(MAX_PER_RUN, left)));
  const post: PostInbound = async (id, payload) => {
    const r = await fetch(`${gate.dashboard}/api/webhooks/resend-inbound`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await svixHeaders(id, payload, gate.secret)) },
      body: payload,
    });
    return { status: r.status, text: (await r.text()).slice(0, 80) };
  };
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  for (const item of plan) {
    const order = byOrder.get(item.comm.order_id)!;
    const florist = florists.get(item.comm.florist_id ?? "");
    try {
      const out = (await gate.ai.run(ACTOR_MODEL, {
        messages: [{ role: "user", content: buildPrompt(item, order, florist) }],
        max_tokens: 300,
      })) as { response?: string };
      const text = cleanReply(out.response ?? "");
      if (!text) throw new Error("model returned an empty reply");
      for (const s of await deliver(item, order, florist, text, post, sleep)) {
        lines.push(`${order.order_name} ${item.persona.id} (${item.lang}, turn ${item.turn}) -> ${item.comm.kind}: ${s.status} ${s.text} | ${s.body.replace(/\n/g, " ")}`);
      }
    } catch (e) {
      lines.push(`${order.order_name} ${item.persona.id}: FAILED ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ran: true, due: plan.length, lines };
}

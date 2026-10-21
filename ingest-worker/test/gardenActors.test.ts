import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath, URL } from "node:url";
import {
  actorsGate, BURST_GAP_MS, buildPrompt, cleanReply, deliver, eventId, isActorsMinute, isGardenClient, isGardenFlorist,
  isGardenOrder, parsePersonas, planReplies as planWithLedger, runGardenActors, splitBurst, svixHeaders, withinBudget,
  type Assignment, type Comm, type Persona, type PlannedReply,
} from "../src/gardenActors";
import { PERSONAS_TXT } from "../src/gardenPersonas";
import { verifyResendSignature } from "../../dashboard/lib/resendWebhookGuard";
import type { Env } from "../src/types";

const personas = parsePersonas(PERSONAS_TXT);
const planReplies = async (...a: Parameters<typeof planWithLedger>) => (await planWithLedger(...a)).plan;
const NOW = Date.parse("2026-10-13T12:00:00Z");
const comm = (id: string, minutesAgo: number, extra: Partial<Comm> = {}): Comm => ({
  id, order_id: "o1", audience: "florist", florist_id: "f1", kind: "offer",
  created_at: new Date(NOW - minutesAgo * 60e3).toISOString(), ...extra,
});
const gardenEnv = (over: Partial<Env> = {}): Env => ({
  GARDEN_ACTORS: "1",
  AI: { run: vi.fn() } as unknown as Ai,
  GARDEN_INBOUND_WEBHOOK_SECRET: "whsec_" + randomBytes(24).toString("base64"),
  SUPABASE_URL: "https://your-project-ref.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  DASHBOARD_URL: "https://facundo-dashboard-garden.your-subdomain.workers.dev",
  ...over,
} as Env);

afterEach(() => vi.unstubAllGlobals());

describe("production can never run the actors", () => {
  it("does nothing, not even a fetch or a model call, when any garden switch is missing", async () => {
    const cases: Partial<Env>[] = [
      { GARDEN_ACTORS: undefined },
      { GARDEN_ACTORS: "0" },
      { AI: undefined },
      { GARDEN_INBOUND_WEBHOOK_SECRET: undefined },
      { SUPABASE_URL: "https://productionproject.supabase.co" },
      { SUPABASE_URL: "https://evil.example/your-project-ref.supabase.co" },
      { DASHBOARD_URL: undefined },
      { DASHBOARD_URL: "https://bo.fc.example.net" },
    ];
    for (const over of cases) {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const env = gardenEnv(over);
      const r = await runGardenActors(env, NOW);
      expect(r.ran, JSON.stringify(over)).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
      if (env.AI) expect(env.AI.run).not.toHaveBeenCalled();
    }
  });

  it("the gate passes only with every switch present", () => {
    expect(actorsGate(gardenEnv()).ok).toBe(true);
  });

  it("runs on minutes 5, 15, 25 … only, six times an hour", () => {
    const hour = Date.parse("2026-10-14T08:00:00Z");
    const minutes = [...Array(60).keys()].filter((m) => isActorsMinute(hour + m * 60e3));
    expect(minutes).toEqual([5, 15, 25, 35, 45, 55]);
  });

  it("wrangler.jsonc gives the AI binding and switch to env.garden only", () => {
    const text = readFileSync(fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)), "utf8")
      .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    const cfg = JSON.parse(text);
    expect(cfg.ai).toBeUndefined();
    expect(cfg.vars.GARDEN_ACTORS).toBeUndefined();
    for (const [name, e] of Object.entries(cfg.env) as [string, Record<string, any>][]) {
      if (name === "garden") continue;
      expect(e.ai, name).toBeUndefined();
      expect(e.vars?.GARDEN_ACTORS, name).toBeUndefined();
    }
    expect(cfg.env.garden.ai).toEqual({ binding: "AI" });
    expect(cfg.env.garden.vars.GARDEN_ACTORS).toBe("1");
  });
});

describe("personas and planning (ported from agents/garden/actors)", () => {
  it("the worker's persona copy matches personas.txt", () => {
    const file = readFileSync(fileURLToPath(new URL("../../agents/garden/actors/personas.txt", import.meta.url)), "utf8");
    expect(parsePersonas(PERSONAS_TXT)).toEqual(parsePersonas(file));
    expect(personas.some((p) => p.role === "florist") && personas.some((p) => p.role === "client")).toBe(true);
  });

  it("only GARDEN orders and marked florists count", () => {
    expect(isGardenOrder({ order_name: "#GARDEN-2026-10-13-07", tags: null })).toBe(true);
    expect(isGardenOrder({ order_name: "#FC11-003", tags: "fc11" })).toBe(false);
    expect(isGardenOrder({ order_name: "#2000034", tags: "Local-florist, GARDEN" })).toBe(true);
    expect(isGardenFlorist({ name: "Floristería La Rosa [GARDEN]", place_id: "GARDEN_A1", email: "owner+garden-a1@fc.example.com" })).toBe(true);
    expect(isGardenFlorist({ name: "Example Garden Flowers", place_id: "ChIJexampleExamplePlaceId00", email: "owner+handsown@fc.example.com" })).toBe(false);
    expect(isGardenFlorist({ name: "GARDEN FLOWERS LTD", place_id: "ChIJxyz", email: "shop@example.com" })).toBe(false);
    expect(isGardenFlorist({ name: "Floristería La Rosa [GARDEN]", place_id: "GARDEN_A1", email: null })).toBe(false);
    expect(isGardenClient("garden-buyer@facundo.example", "owner@fc.example.com")).toBe(true);
    expect(isGardenClient("maria@gmail.com", "owner@fc.example.com")).toBe(false);
  });

  it("replies once, to the latest email only", async () => {
    const plan = await planReplies([comm("a", 30), comm("b", 10)], [], personas, NOW);
    expect(plan.map((p) => p.comm.id)).toEqual(["b"]);
  });

  it("never replies to the same email twice", async () => {
    const c = comm("b", 10);
    expect(await planReplies([c], [eventId(c)], personas, NOW)).toHaveLength(0);
  });

  it("stops at the persona limit even when the agent writes again", async () => {
    const sent = [comm("a", 60), comm("b", 30), comm("c", 5)];
    const persona = (await planReplies([sent[2]], [], personas, NOW))[0].persona;
    const prior = sent.slice(0, persona.maxReplies).map(eventId);
    expect(await planReplies(sent, prior, personas, NOW)).toHaveLength(0);
  });

  it("ignores emails older than a day and a half", async () => {
    expect(await planReplies([comm("old", 37 * 60)], [], personas, NOW)).toHaveLength(0);
  });
});

describe("prompt, reply cleaning and signature", () => {
  it("prompt carries persona, order facts, the email and the language", async () => {
    const c = comm("b", 1, { subject: "New order", body: "Can you take it?" });
    const [item] = await planReplies([c], [], personas, NOW, [assign("o1", "f-f1", "florist-accept-ask")]);
    const p = buildPrompt(item, { id: "o1", order_name: "#GARDEN-1", tags: null, locale: "fr", delivery_address: { line1: "1 Rue X", city: "Paris" }, delivery_at: "2026-10-14" }, { id: "f1", name: "Fleurs [GARDEN]", email: "a@b.c", place_id: "GARDEN_1" });
    expect(p).toContain("Fleurs [GARDEN]");
    expect(p).toContain("1 Rue X, Paris");
    expect(p).toContain("Can you take it?");
    expect(p).toContain("in French");
    expect(p).toContain("first reply");
  });

  it("a fixed-language persona writes in its language, and a burst persona is asked for two emails", async () => {
    const order = { id: "o1", order_name: "#GARDEN-1", tags: null, locale: "en" };
    const [es] = await planReplies([comm("b", 1)], [], personas, NOW, [assign("o1", "f-f1", "florist-spanish")]);
    expect(buildPrompt(es, order, undefined)).toContain("in Spanish");
    const [dbl] = await planReplies([comm("b", 1)], ["garden-actor:o1:f-f1:a"], personas, NOW, [assign("o1", "f-f1", "florist-double")]);
    const p = buildPrompt(dbl, order, undefined);
    expect(p).toContain("two separate short emails");
    expect(p).toContain("reply number 2");
  });

  it("drops reasoning and a stray subject line", () => {
    expect(cleanReply("Okay...\n</think>\n\nYes, we can do it.")).toBe("Yes, we can do it.");
    expect(cleanReply("Subject: Re: order\n\nSí, sin problema.")).toBe("Sí, sin problema.");
    expect(cleanReply("Plain reply.")).toBe("Plain reply.");
  });

  it("the dashboard webhook guard accepts the signature and rejects a tampered body", async () => {
    const secret = "whsec_" + randomBytes(24).toString("base64");
    const h = await svixHeaders("garden-actor:o1:f-f1:b", '{"x":1}', secret, NOW);
    expect(verifyResendSignature('{"x":1}', h as never, secret, NOW)).toBe(true);
    expect(verifyResendSignature('{"x":2}', h as never, secret, NOW)).toBe(false);
  });
});

const assign = (orderId: string, person: string, personaId: string, atMs = NOW - 3600e3): Assignment =>
  ({ orderId, person, personaId, atMs });
const byId = (id: string): Persona => personas.find((p) => p.id === id)!;

describe("persona file format", () => {
  it("reads the optional sixth field, a language list and a silent person; old five-field lines still parse", () => {
    const [old, burst, multi, silent] = parsePersonas([
      "# comment",
      "a | florist | order | 2 | Writes short.",
      "b | florist | es | 2 | Writes twice. | burst",
      "c | florist | fr/it/de | 1 | Writes abroad.",
      "d | client | order | 0 | Never answers.",
    ].join("\n"));
    expect(old).toEqual({ id: "a", role: "florist", lang: "order", maxReplies: 2, brief: "Writes short.", burst: false });
    expect(burst.burst).toBe(true);
    expect(multi.lang).toBe("fr/it/de");
    expect(silent.maxReplies).toBe(0);
  });

  it("rejects a bad line instead of guessing", () => {
    for (const line of [
      "a | shop | order | 1 | x",
      "a | florist | order | 1 |",
      "a | florist | order | two | x",
      "a | florist | order | -1 | x",
      "a | florist | order | 1 | x | loud",
      "a | florist | order | 1 | x | burst | extra",
      "a:b | florist | order | 1 | x",
    ]) expect(() => parsePersonas(line), line).toThrow(/bad persona line/);
  });

  it("the shipped file has every persona the garden asked for", () => {
    const ids = personas.map((p) => p.id);
    for (const id of ["florist-decline", "florist-cancel", "florist-rude", "florist-human", "florist-europe", "florist-double",
      "client-florist", "client-late", "client-silent", "client-nervous"]) expect(ids).toContain(id);
    expect(byId("florist-double").burst).toBe(true);
    expect(byId("client-silent").maxReplies).toBe(0);
    expect(byId("client-nervous").maxReplies).toBe(3);
    expect(byId("florist-europe").lang).toBe("fr/it/de");
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("persona selection", () => {
  /** Runs the planner over n new conversations one at a time, feeding each assignment back, as the cron does. */
  async function assignInTurn(n: number, audience: "florist" | "client"): Promise<Assignment[]> {
    let ledger: Assignment[] = [];
    for (let i = 0; i < n; i++) {
      const c = comm(`m${i}`, 5, { order_id: `o${i}`, audience, florist_id: audience === "client" ? null : `f${i}` });
      const { assigned } = await planWithLedger([c], [], personas, NOW, ledger);
      ledger = [...ledger, ...assigned];
    }
    return ledger;
  }

  it("every persona of a role comes up once before any comes up twice, the silent one included", async () => {
    for (const role of ["florist", "client"] as const) {
      const pool = personas.filter((p) => p.role === role).map((p) => p.id).sort();
      const ledger = await assignInTurn(pool.length, role);
      expect(ledger.map((a) => a.personaId).sort(), role).toEqual(pool);
    }
  });

  it("spreads a batch that arrives in one run too", async () => {
    const pool = personas.filter((p) => p.role === "client");
    const comms = pool.map((_, i) => comm(`m${i}`, 5, { order_id: `o${i}`, audience: "client", florist_id: null }));
    const { assigned } = await planWithLedger(comms, [], personas, NOW, []);
    expect(new Set(assigned.map((a) => a.personaId)).size).toBe(pool.length);
  });

  it("florist personas answer only florist emails and client personas only client emails", async () => {
    const comms = Array.from({ length: 40 }, (_, i) => i % 2
      ? comm(`m${i}`, 5, { order_id: `o${i}`, audience: "client", florist_id: null })
      : comm(`m${i}`, 5, { order_id: `o${i}`, florist_id: `f${i}` }));
    const { assigned } = await planWithLedger(comms, [], personas, NOW, []);
    expect(assigned).toHaveLength(40);
    for (const a of assigned) expect(byId(a.personaId).role).toBe(a.person === "client" ? "client" : "florist");
  });

  it("a conversation keeps the persona it was given, even when others are less used", async () => {
    const ledger = [assign("o1", "f-f1", "florist-rude")];
    const { plan, assigned } = await planWithLedger([comm("b", 5)], [], personas, NOW, ledger);
    expect(assigned).toHaveLength(0);
    expect(plan[0].persona.id).toBe("florist-rude");
  });

  it("only assignments inside the window count toward the spread", async () => {
    const others = personas.filter((p) => p.role === "client" && p.id !== "client-late");
    const fresh = others.map((p, i) => assign(`new${i}`, "client", p.id));
    const stale = others.map((p, i) => assign(`old${i}`, "client", p.id, NOW - 4 * 86400e3));
    const c = comm("m", 5, { order_id: "o9", audience: "client", florist_id: null });
    expect((await planWithLedger([c], [], personas, NOW, fresh)).assigned[0].personaId).toBe("client-late");
    const picks = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const ci = comm("m", 5, { order_id: `p${i}`, audience: "client", florist_id: null });
      picks.add((await planWithLedger([ci], [], personas, NOW, stale)).assigned[0].personaId);
    }
    expect(picks.size).toBeGreaterThan(1);
  });

  it("a fr/it/de persona keeps one language for the whole conversation and uses all three across conversations", async () => {
    const langs = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const ledger = [assign(`o${i}`, "f-f1", "florist-europe")];
      const a = await planReplies([comm("x", 5, { order_id: `o${i}` })], [], personas, NOW, ledger);
      const b = await planReplies([comm("y", 1, { order_id: `o${i}` })], [`garden-actor:o${i}:f-f1:x`], personas, NOW, ledger);
      expect(b[0].lang).toBe(a[0].lang);
      langs.add(a[0].lang);
    }
    expect([...langs].sort()).toEqual(["de", "fr", "it"]);
  });
});

describe("the silent client", () => {
  it("is assigned and recorded, never answers, and is not assigned again", async () => {
    const c = comm("m", 5, { audience: "client", florist_id: null });
    const others = personas.filter((p) => p.role === "client" && p.id !== "client-silent").map((p, i) => assign(`x${i}`, "client", p.id));
    const first = await planWithLedger([c], [], personas, NOW, others);
    expect(first.assigned).toEqual([{ orderId: "o1", person: "client", personaId: "client-silent", atMs: NOW }]);
    expect(first.plan).toHaveLength(0);
    const later = comm("m2", 1, { audience: "client", florist_id: null });
    const again = await planWithLedger([c, later], [], personas, NOW, [...others, ...first.assigned]);
    expect(again).toEqual({ plan: [], assigned: [] });
  });
});

describe("nervous client and the persona limit", () => {
  it("answers three times, then stops", async () => {
    const ledger = [assign("o1", "client", "client-nervous")];
    const sent = ["a", "b", "c", "d"].map((id, i) => comm(id, 40 - i * 10, { audience: "client", florist_id: null }));
    const prior: string[] = [];
    for (const [i, c] of sent.entries()) {
      const plan = await planReplies(sent.slice(0, i + 1), prior, personas, NOW, ledger);
      if (i < 3) {
        expect(plan.map((p) => [p.comm.id, p.turn])).toEqual([[c.id, i + 1]]);
        prior.push(plan[0].eventId);
      } else expect(plan).toHaveLength(0);
    }
  });

  it("both halves of a burst count as one reply, not two", async () => {
    const ledger = [assign("o1", "f-f1", "florist-double")];
    const prior = ["garden-actor:o1:f-f1:a", "garden-actor:o1:f-f1:a:2"];
    const plan = await planReplies([comm("a", 30), comm("b", 5)], prior, personas, NOW, ledger);
    expect(plan.map((p) => [p.comm.id, p.turn])).toEqual([["b", 2]]);
  });
});

describe("burst sending", () => {
  const order = { id: "o1", order_name: "#GARDEN-1", tags: null, buyer_name: "B", buyer_email: "b@x.example" };
  const florist = { id: "f1", name: "Fleurs [GARDEN]", email: "owner+g1@fc.example.com", place_id: "GARDEN_1" };
  const item = (personaId: string): PlannedReply =>
    ({ comm: comm("b", 1, { subject: "Offer", rfc_message_id: "<m1@fc.example.com>" }), persona: byId(personaId), eventId: "garden-actor:o1:f-f1:b", turn: 1, lang: "order" });

  it("a burst persona sends two separate inbound emails, a moment apart, with their own ids", async () => {
    const events: string[] = [];
    const posts: { id: string; payload: string }[] = [];
    const sent = await deliver(item("florist-double"), order, florist, "Yes, I'll do it.\n---\nWhat time should it arrive?",
      async (id, payload) => { events.push(`post ${id}`); posts.push({ id, payload }); return { status: 200, text: "ok" }; },
      async (ms) => { events.push(`wait ${ms}`); });
    expect(events).toEqual(["post garden-actor:o1:f-f1:b", `wait ${BURST_GAP_MS}`, "post garden-actor:o1:f-f1:b:2"]);
    expect(BURST_GAP_MS).toBeGreaterThanOrEqual(5_000);
    const bodies = posts.map((p) => JSON.parse(p.payload).data);
    expect(bodies.map((d) => d.text)).toEqual(["Yes, I'll do it.", "What time should it arrive?"]);
    expect(bodies.map((d) => d.email_id)).toEqual(posts.map((p) => p.id));
    expect(bodies.every((d) => d.headers["in-reply-to"] === "<m1@fc.example.com>" && d.from.includes(florist.email))).toBe(true);
    expect(sent.map((s) => s.status)).toEqual([200, 200]);
  });

  it("a normal persona sends one email and never waits", async () => {
    const post = vi.fn(async () => ({ status: 200, text: "ok" }));
    const sleep = vi.fn(async () => {});
    await deliver(item("florist-terse"), order, florist, "Yes.\n---\nOk.", post, sleep);
    expect(post).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("splits a burst even when the model forgets the separator", () => {
    expect(splitBurst("Yes, done.\n\nWhat time?")).toEqual(["Yes, done.", "What time?"]);
    expect(splitBurst("Yes, done. Also the card? And the time?")).toEqual(["Yes, done. Also the card?", "And the time?"]);
    expect(splitBurst("Yes")).toEqual(["Yes"]);
  });

  it("a run never sends more than four emails, counting both halves of a burst", () => {
    const plan = ["florist-double", "florist-terse", "florist-double", "florist-rude", "client-late"].map(item);
    expect(withinBudget(plan, 4).map((p) => p.persona.id)).toEqual(["florist-double", "florist-terse", "florist-rude"]);
    expect(withinBudget(plan, 1).map((p) => p.persona.id)).toEqual(["florist-terse"]);
  });
});

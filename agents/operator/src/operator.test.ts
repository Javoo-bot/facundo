import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { routeFor, sessionCookie } from "./dashboard";
import {
  fromApproval,
  fromConversation,
  isDigestTime,
  parseDecisionId,
  planDecision,
  relayProblem,
  renderDigest,
  type ApprovalRow,
  type ConversationRow,
  type Decision,
} from "./decisions";
import { gardenEnv, type Env } from "./garden";

const CID = "50e71c05-7bf8-4cce-aae2-62f831f77a0d";
const AID = "0fc74311-0337-4d94-a6cd-a18712315956";

const convo = (over: Partial<ConversationRow> = {}): ConversationRow => ({
  id: CID,
  kind: "support",
  channel: "email",
  escalation_reason: "low_confidence",
  escalated_at: "2026-10-14T09:16:17.999Z",
  order_id: "d9638424-3ab0-4a1b-9b14-fe264abb88c9",
  florists: { name: "Floristería La Rosa" },
  orders: { order_name: "#GARDEN-20261014-09" },
  conversation_messages: [
    { direction: "out", status: "draft", body_text: "La dirección es Calle de las Flores 46.", subject: "Re: pedido", created_at: "2026-10-14T09:16:17Z", ai_context: { agent: "concierge" } },
    { direction: "in", status: "received", body_text: "¿Cuál es la dirección?", subject: "pedido", created_at: "2026-10-14T09:15:00Z", ai_context: null },
  ],
  ...over,
});

const approval = (kind: string, over: Partial<ApprovalRow> = {}): ApprovalRow => ({
  id: AID,
  kind,
  order_id: "fa119397-2fae-430a-b101-5dee4ac462f2",
  draft_subject: null,
  draft_body: null,
  preview: { type: "reason", reason: "This florist accepted and has not started. Ask them for a photo." },
  block_reason: null,
  created_at: "2026-10-14T08:00:55Z",
  orders: { order_name: "#GARDEN-20261014-03" },
  ...over,
});

describe("decision ids", () => {
  it("round-trips both sources and rejects anything else", () => {
    expect(parseDecisionId(`c-${CID}`)).toEqual({ source: "conversation", sourceId: CID });
    expect(parseDecisionId(` a-${AID} `)).toEqual({ source: "approval", sourceId: AID });
    expect(parseDecisionId(CID)).toBeNull();
    expect(parseDecisionId("c-1; drop table orders")).toBeNull();
  });
});

describe("rows into decisions", () => {
  it("a held reply shows the florist's last message, the agent's draft and the reason in words", () => {
    const d = fromConversation(convo(), false);
    expect(d.id).toBe(`c-${CID}`);
    expect(d.what).toContain("¿Cuál es la dirección?");
    expect(d.draft).toBe("La dirección es Calle de las Flores 46.");
    expect(d.why).toBe("The assistant wasn't confident enough");
    expect(d.agent).toBe("concierge");
    expect(d.audience).toBe("florist");
    expect(d.aiContext).toEqual({ agent: "concierge" });
  });

  it("uses the dashboard's words for every reason, including the hyphen/underscore drift", () => {
    expect(fromConversation(convo({ escalation_reason: "intent" }), false).why).toMatch(/money, contracts, or a person/);
    expect(fromConversation(convo({ escalation_reason: "open_issue" }), false).why).toMatch(/open problem report/);
  });

  it("a recruiting thread is Cupid's, a pending step names what it would do", () => {
    expect(fromConversation(convo({ kind: "recruiting" }), false).agent).toBe("cupid");
    const d = fromApproval(approval("chase_photo"), false);
    expect(d.what).toBe("Ask the florist for the delivery photo");
    expect(d.why).toMatch(/Ask them for a photo/);
    expect(d.agent).toBe("step:chase_photo");
  });
});

describe("the relay rule", () => {
  it.each(["Te pagamos 40 €", "Total 55,90€", "the client paid $60", "EUR 30 for you", "€ 25", "Le client a payé 30 euros"])("refuses money: %s", (t) => {
    expect(relayProblem(t)).toMatch(/money/);
  });
  it.each(["Le hemos hecho un reembolso", "We refunded the client", "remboursement fait", "Erstattung erfolgt"])("refuses refunds: %s", (t) => {
    expect(relayProblem(t)).toMatch(/refund/);
  });
  it.each(["Usa rosas en vez de tulipanes", "El cliente confirmó, adelante", "Calle de las Flores 46, piso 2", "Entrega antes de las 14:00", "Look in your app for your payout"])("lets plain instructions through: %s", (t) => {
    expect(relayProblem(t)).toBeNull();
  });
});

describe("what an answer does", () => {
  const d = fromConversation(convo(), false);

  it("approve_draft sends the agent's exact draft through the reply route", () => {
    const plan = planDecision(d, { action: "approve_draft" });
    expect(plan).toEqual({ kind: "reply", conversationId: CID, text: "La dirección es Calle de las Flores 46." });
    expect(routeFor(plan)).toEqual({ path: "/api/conversations/reply", body: { conversationId: CID, action: "send", text: "La dirección es Calle de las Flores 46." } });
  });

  it("send_my_reply sends the operator's words and needs some", () => {
    expect(planDecision(d, { action: "send_my_reply", text: "  Sí, piso 2.  " })).toEqual({ kind: "reply", conversationId: CID, text: "Sí, piso 2." });
    expect(planDecision(d, { action: "send_my_reply", text: "   " }).kind).toBe("refuse");
  });

  it("refuses to tell a florist what the client paid, whoever wrote it", () => {
    expect(planDecision(d, { action: "send_my_reply", text: "El cliente pagó 60 €, adelante" }).kind).toBe("refuse");
    const moneyDraft = fromConversation(
      convo({ conversation_messages: [{ direction: "out", status: "draft", body_text: "Te reembolsamos", subject: null, created_at: "2026-10-14T09:16:17Z", ai_context: null }] }),
      false,
    );
    expect(planDecision(moneyDraft, { action: "approve_draft" }).kind).toBe("refuse");
  });

  it("reject closes a conversation without sending, and declines a step with the note", () => {
    const close = planDecision(d, { action: "reject" });
    expect(routeFor(close)).toEqual({ path: "/api/conversations/reply", body: { conversationId: CID, action: "close" } });
    const step = fromApproval(approval("chase_photo"), false);
    expect(routeFor(planDecision(step, { action: "reject", note: "already called her" }))).toEqual({
      path: "/api/orders/approvals",
      body: { approvalId: AID, action: "reject", reason: "already called her" },
    });
  });

  it("a step is approved as-is; only email steps take the operator's own text", () => {
    const photo = fromApproval(approval("chase_photo"), false);
    expect(routeFor(planDecision(photo, { action: "approve_draft" }))).toEqual({ path: "/api/orders/approvals", body: { approvalId: AID, action: "approve" } });
    expect(planDecision(photo, { action: "send_my_reply", text: "Hola" }).kind).toBe("refuse");
    const offer = fromApproval(approval("offer", { draft_subject: "Nuevo pedido", draft_body: "Ganas 40 € por este pedido" }), false);
    expect(planDecision(offer, { action: "approve_draft" }).kind).toBe("approve");
    const client = fromApproval(approval("client_delivered", { draft_subject: "Entregado", draft_body: "Tus flores" }), false);
    expect(routeFor(planDecision(client, { action: "send_my_reply", text: "Tus flores llegaron" }))).toEqual({
      path: "/api/orders/approvals",
      body: { approvalId: AID, action: "approve", subject: "Entregado", body: "Tus flores llegaron" },
    });
  });

  it("an item with the owner is his: only escalation is allowed, and it calls no dashboard route", () => {
    const withOwner = fromConversation(convo(), true);
    expect(planDecision(withOwner, { action: "approve_draft" }).kind).toBe("refuse");
    const plan = planDecision(d, { action: "escalate_to_owner", note: "money" });
    expect(plan).toEqual({ kind: "to_owner" });
    expect(routeFor(plan)).toBeNull();
  });
});

describe("the morning email", () => {
  it("one plain line per decision, the count, and the project link", () => {
    const open: Decision[] = [fromConversation(convo(), false), fromApproval(approval("chase_photo"), false)];
    const { subject, text } = renderDigest(open, [fromConversation(convo(), true)], "2026-10-14");
    expect(subject).toBe("Garden 2026-10-14: 2 decisions waiting");
    expect(text).toContain("- #GARDEN-20261014-09 · Floristería La Rosa (florist): the assistant wasn't confident enough.");
    expect(text).toContain("1 more is with the owner.");
    expect(text).toContain("https://claude.ai/project/<your-project-id>");
  });

  it("ends each line with one period and keeps a long list short", () => {
    const step = fromApproval(approval("chase_photo"), false);
    const { text } = renderDigest(Array.from({ length: 20 }, () => step), [], "2026-10-14");
    expect(text).toContain("Ask them for a photo.\n");
    expect(text).not.toContain("..");
    expect(text.match(/^- #/gm)?.length).toBe(15);
    expect(text).toContain("- and 5 more.");
  });

  it("says so when nothing is waiting", () => {
    expect(renderDigest([], [], "2026-10-14").subject).toBe("Garden 2026-10-14: nothing waiting for you");
  });

  it("sends at 06:45 Madrid in summer and in winter, from exactly one of the two crons", () => {
    expect(isDigestTime(new Date("2026-10-14T04:45:00Z"))).toBe(true);
    expect(isDigestTime(new Date("2026-10-14T05:45:00Z"))).toBe(false);
    expect(isDigestTime(new Date("2026-12-01T04:45:00Z"))).toBe(false);
    expect(isDigestTime(new Date("2026-12-01T05:45:00Z"))).toBe(true);
  });
});

describe("garden only", () => {
  const good = {
    SUPABASE_URL: "https://your-project-ref.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "k",
    SUPABASE_ANON_KEY: "k",
    DASHBOARD_URL: "https://facundo-dashboard-garden.your-subdomain.workers.dev",
    OPERATOR_EMAIL: "op@example.com",
    OPERATOR_PASSWORD: "p",
    DIGEST_TO: "owner@example.com",
  } as unknown as Env;

  it("accepts the garden and refuses production or any other inbox", () => {
    expect(gardenEnv(good)).toBe(good);
    expect(() => gardenEnv({ ...good, SUPABASE_URL: "https://prodproject.supabase.co" })).toThrow(/not the garden database/);
    expect(() => gardenEnv({ ...good, DASHBOARD_URL: "https://bo.fc.example.net" })).toThrow(/not the garden dashboard/);
    expect(() => gardenEnv({ ...good, DIGEST_TO: "team@fc.example.com" })).toThrow(/only goes to/);
    expect(() => gardenEnv({ ...good, OPERATOR_PASSWORD: "" })).toThrow(/missing OPERATOR_PASSWORD/);
  });

  it("the deploy config is pinned to the garden account and garden addresses", () => {
    const cfg = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    expect(cfg).toContain('"account_id": "<your-account-id>"');
    expect(cfg).toContain('"SUPABASE_URL": "https://your-project-ref.supabase.co"');
    expect(cfg).not.toMatch(/fc\.example\.net/);
  });
});

describe("the dashboard session cookie", () => {
  it("is the @supabase/ssr base64 cookie, chunked under 3180 characters", () => {
    const session = { access_token: "a".repeat(5000), user: { email: "ñ@example.com" } };
    const cookie = sessionCookie(session);
    const parts = cookie.split("; ");
    expect(parts.length).toBe(3);
    expect(parts.every((p, i) => p.startsWith(`sb-your-project-ref-auth-token.${i}=`))).toBe(true);
    const value = parts.map((p) => p.slice(p.indexOf("=") + 1)).join("");
    expect(value.startsWith("base64-")).toBe(true);
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(value.slice(7).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
    expect(JSON.parse(decoded)).toEqual(session);
  });
});

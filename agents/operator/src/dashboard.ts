// Acting through the garden dashboard's own staff routes, the same ones the CX
// desk buttons call, so a decision here runs exactly the code a person's click
// runs (persona, test_mode redirect, escalation reset, approval executors).
//
// The worker signs in as a garden-only staff account (role ops) and presents
// that session the way a browser does: the @supabase/ssr auth cookie.

import { gardenEnv, GARDEN_DB_HOST, type Env } from "./garden";
import type { Plan } from "./decisions";

const COOKIE = `sb-${GARDEN_DB_HOST.split(".")[0]}-auth-token`;
const CHUNK = 3180;

export function sessionCookie(session: unknown): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(JSON.stringify(session))) binary += String.fromCharCode(byte);
  const value = `base64-${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
  const parts: string[] = [];
  for (let i = 0; i * CHUNK < value.length; i++) parts.push(`${COOKIE}.${i}=${value.slice(i * CHUNK, (i + 1) * CHUNK)}`);
  return parts.join("; ");
}

async function signIn(env: Env): Promise<string> {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, "content-type": "application/json" },
    body: JSON.stringify({ email: env.OPERATOR_EMAIL, password: env.OPERATOR_PASSWORD }),
  });
  if (!res.ok) throw new Error(`garden staff sign-in failed: ${res.status}`);
  return sessionCookie(await res.json());
}

export type RouteCall = { path: string; body: Record<string, unknown> };

export function routeFor(plan: Plan): RouteCall | null {
  switch (plan.kind) {
    case "reply":
      return { path: "/api/conversations/reply", body: { conversationId: plan.conversationId, action: "send", text: plan.text } };
    case "close":
      return { path: "/api/conversations/reply", body: { conversationId: plan.conversationId, action: "close" } };
    case "approve":
      return { path: "/api/orders/approvals", body: { approvalId: plan.approvalId, action: "approve", ...(plan.edits ?? {}) } };
    case "reject":
      return { path: "/api/orders/approvals", body: { approvalId: plan.approvalId, action: "reject", reason: plan.reason } };
    default:
      return null;
  }
}

export async function callDashboard(env: Env, call: RouteCall): Promise<{ ok: true } | { ok: false; error: string }> {
  gardenEnv(env);
  const cookie = await signIn(env);
  const res = await fetch(`${env.DASHBOARD_URL}${call.path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(call.body),
  });
  if (res.ok) return { ok: true };
  const text = await res.text();
  let error = text.slice(0, 300);
  try {
    error = (JSON.parse(text) as { error?: string }).error ?? error;
  } catch {}
  return { ok: false, error: `${res.status} ${error}` };
}

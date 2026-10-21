// The garden operator: a remote MCP server that claude.ai connects to as the
// "Garden operator" custom connector, plus the 06:45 Madrid email that lists
// what is waiting. Garden only (garden.ts).

import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { openDecisions } from "./db";
import { isDigestTime, madridDay, renderDigest } from "./decisions";
import { gardenEnv, type Env } from "./garden";
import { mailOperator } from "./mail";
import { createServer } from "./tools";

const ORIGIN = "https://facundo-garden-operator.your-subdomain.workers.dev";

type Props = { operator: string };
type AuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

const escape = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(query: string, redirectHost: string, error?: string): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Garden operator</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f1ea;color:#1f2a1f;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
form{background:#fff;padding:24px;border-radius:12px;max-width:360px;width:100%;box-shadow:0 1px 4px #0002}
label{display:block;margin:12px 0 4px;font-size:14px}input{width:100%;box-sizing:border-box;padding:8px;font-size:16px}
button{margin-top:16px;width:100%;padding:10px;font-size:16px;background:#2f5d3a;color:#fff;border:0;border-radius:8px}
.err{color:#a33}.small{font-size:13px;color:#555}</style></head>
<body><form method="post" action="/authorize?${escape(query)}">
<h1 style="font-size:20px;margin:0 0 8px">Garden operator</h1>
<p class="small">Garden (test data) only. Access goes to <strong>${escape(redirectHost)}</strong>.</p>
${error ? `<p class="err">${escape(error)}</p>` : ""}
<label for="name">Your name</label><input id="name" name="name" required maxlength="60" autocomplete="name">
<label for="passphrase">Garden passphrase</label><input id="passphrase" name="passphrase" type="password" required autocomplete="current-password">
<button type="submit">Connect</button></form></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" } });
}

async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

const authorizeHandler = {
  async fetch(request: Request, env: AuthEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response("Garden operator MCP server. Connect at /mcp. Garden only.\n");
    if (url.pathname !== "/authorize") return new Response("Not found", { status: 404 });
    gardenEnv(env);
    const oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    const redirectHost = new URL(oauthReq.redirectUri).host;
    if (request.method === "GET") return page(url.searchParams.toString(), redirectHost);
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const form = await request.formData();
    const name = String(form.get("name") ?? "").trim();
    const passphrase = String(form.get("passphrase") ?? "");
    if (!env.OPERATOR_PASSPHRASE || !(await sameSecret(passphrase, env.OPERATOR_PASSPHRASE))) {
      return page(url.searchParams.toString(), redirectHost, "That passphrase is not right.");
    }
    if (!name) return page(url.searchParams.toString(), redirectHost, "Please write your name.");
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReq,
      // The user id becomes part of the bearer token, so it must be header-safe.
      userId: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "operator",
      metadata: {},
      scope: oauthReq.scope,
      props: { operator: name } satisfies Props,
    });
    return Response.redirect(redirectTo, 302);
  },
};

const mcpHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: Props }): Promise<Response> {
    const operator = ctx.props?.operator ?? "operator";
    return createMcpHandler(() => createServer(env, operator), { route: "/mcp" })(request, env, ctx);
  },
};

const provider = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: mcpHandler as never,
  defaultHandler: authorizeHandler as never,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  resourceMetadata: { resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] },
});

async function sendDigest(env: Env, at = new Date()): Promise<{ subject: string; text: string }> {
  gardenEnv(env);
  const all = await openDecisions(env, 24);
  const digest = renderDigest(all.filter((d) => !d.withOwner), all.filter((d) => d.withOwner), madridDay(at));
  await mailOperator(env, digest.subject, digest.text);
  return digest;
}

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => provider.fetch(request, env, ctx),
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const at = new Date(controller.scheduledTime);
    if (!isDigestTime(at)) {
      console.log(`digest: ${at.toISOString()} is not 06:45 in Madrid, skipped`);
      return;
    }
    const digest = await sendDigest(env, at);
    console.log(`digest sent: ${digest.subject}`);
  },
};

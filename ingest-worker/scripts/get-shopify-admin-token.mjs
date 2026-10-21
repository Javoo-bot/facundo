#!/usr/bin/env node
// Runs the Shopify OAuth authorization-code grant end-to-end to mint (or
// re-mint) an offline Admin API access token for this custom app — the
// replacement for the old one-click "Install app" button, which Shopify
// retired for custom apps created via the Dev Dashboard (Jan 2026+): those
// now authorize exactly like a public app, via /admin/oauth/authorize +
// /admin/oauth/access_token. Useful because the access token itself is shown
// exactly once and can't be recovered later if lost — this makes minting a
// fresh one a one-command operation instead of a manual admin dance.
//
// Prerequisite (one-time, can't be automated): the exact --redirect-uri this
// script uses must be added to the app's "Allowed redirection URL(s)" in the
// Shopify Dev Dashboard, or Shopify will reject the authorize request.
//
// Usage:
//   node scripts/get-shopify-admin-token.mjs \
//     --shop your-store.myshopify.com \
//     --client-id <your-client-id> \
//     --client-secret shpss_xxxxxxxxxxxxxxxxxxxxxxxxxxxx \
//     [--scopes read_orders,write_orders] \
//     [--redirect-uri http://localhost:8945/callback] \
//     [--set-secret]   # pipe the resulting token straight into
//                        `wrangler secret put SHOPIFY_ADMIN_TOKEN`
//
// Flags may instead come from env vars: SHOPIFY_SHOP, SHOPIFY_CLIENT_ID,
// SHOPIFY_SECRET, SHOPIFY_SCOPES, SHOPIFY_REDIRECT_URI. Flags take precedence.

import http from "node:http";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DEFAULT_SCOPES = "read_orders,write_orders";
const DEFAULT_REDIRECT_URI = "http://localhost:8945/callback";
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000; // give up if the browser flow never completes

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--shop") out.shop = argv[++i];
    else if (a === "--client-id") out.clientId = argv[++i];
    else if (a === "--client-secret") out.clientSecret = argv[++i];
    else if (a === "--scopes") out.scopes = argv[++i];
    else if (a === "--redirect-uri") out.redirectUri = argv[++i];
    else if (a === "--set-secret") out.setSecret = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function usage() {
  console.error(
    [
      "Usage: node scripts/get-shopify-admin-token.mjs --shop <shop>.myshopify.com --client-id <id> --client-secret <secret> [--scopes read_orders,write_orders] [--redirect-uri http://localhost:8945/callback] [--set-secret]",
      "(or set SHOPIFY_SHOP / SHOPIFY_CLIENT_ID / SHOPIFY_SECRET / SHOPIFY_SCOPES / SHOPIFY_REDIRECT_URI env vars)",
      "",
      "The --redirect-uri must already be registered as an Allowed redirection URL for this app in the Shopify Dev Dashboard.",
    ].join("\n"),
  );
}

// Pure: Shopify's OAuth-callback HMAC check — exclude `hmac`/`signature`,
// sort the rest alphabetically by key, join as `key=value` pairs with `&`,
// HMAC-SHA256 (hex) with the client secret. Unit-tested in isolation (see
// test/get-shopify-admin-token.test.ts) since it's easy to get subtly wrong
// (this is NOT the same algorithm as verifying an inbound webhook body).
export function verifyOAuthCallbackHmac(query, clientSecret) {
  const hmac = query.hmac;
  if (!hmac) return false;
  const message = Object.keys(query)
    .filter((k) => k !== "hmac" && k !== "signature")
    .sort()
    .map((k) => `${k}=${query[k]}`)
    .join("&");
  const expected = crypto.createHmac("sha256", clientSecret).update(message).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(hmac, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function exchangeCodeForToken(shop, clientId, clientSecret, code) {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code }).toString(),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text().catch(() => "")}`);
  return res.json();
}

function setWranglerSecret(token) {
  const workerDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  console.log("\nSetting SHOPIFY_ADMIN_TOKEN via `wrangler secret put`...");
  const result = spawnSync("npx", ["wrangler", "secret", "put", "SHOPIFY_ADMIN_TOKEN"], {
    input: token,
    stdio: ["pipe", "inherit", "inherit"],
    cwd: workerDir,
  });
  if (result.status !== 0) throw new Error("wrangler secret put failed — see output above");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return; }

  const shop = args.shop ?? process.env.SHOPIFY_SHOP;
  const clientId = args.clientId ?? process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = args.clientSecret ?? process.env.SHOPIFY_SECRET;
  const scopes = args.scopes ?? process.env.SHOPIFY_SCOPES ?? DEFAULT_SCOPES;
  const redirectUri = args.redirectUri ?? process.env.SHOPIFY_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;

  if (!shop || !clientId || !clientSecret) {
    usage();
    process.exitCode = 1;
    return;
  }

  const state = crypto.randomBytes(16).toString("hex");
  const authorizeUrl =
    `https://${shop}/admin/oauth/authorize?client_id=${encodeURIComponent(clientId)}` +
    `&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

  const { port, pathname } = new URL(redirectUri);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`Timed out waiting for the OAuth callback after ${CALLBACK_TIMEOUT_MS / 1000}s`));
    }, CALLBACK_TIMEOUT_MS);

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname !== pathname) { res.writeHead(404).end("not found"); return; }

      const query = Object.fromEntries(url.searchParams.entries());
      const fail = (msg) => {
        res.writeHead(400, { "Content-Type": "text/plain" }).end(msg);
        clearTimeout(timer);
        server.close();
        reject(new Error(msg));
      };

      if (query.state !== state) { fail("state mismatch — possible CSRF, aborting"); return; }
      if (!verifyOAuthCallbackHmac(query, clientSecret)) { fail("HMAC verification failed on the callback"); return; }
      if (!query.code) { fail("no `code` in callback"); return; }

      try {
        const token = await exchangeCodeForToken(shop, clientId, clientSecret, query.code);
        res.writeHead(200, { "Content-Type": "text/html" }).end("<h1>Done</h1><p>You can close this tab.</p>");
        clearTimeout(timer);
        server.close();
        resolve(token);
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    });

    server.listen(Number(port), () => {
      console.log(`\nOpen this URL to authorize (listening on ${redirectUri} for the callback):\n\n  ${authorizeUrl}\n`);
      // Best-effort auto-open on macOS; harmless no-op elsewhere if `open` isn't found.
      if (process.platform === "darwin") spawnSync("open", [authorizeUrl]);
    });
  }).then(
    (token) => {
      console.log(`\nAccess token acquired (scope: ${token.scope}):\n\n  ${token.access_token}\n`);
      if (args.setSecret) setWranglerSecret(token.access_token);
      else console.log("Re-run with --set-secret to push this straight into `wrangler secret put SHOPIFY_ADMIN_TOKEN`.");
    },
    (err) => {
      console.error(`\nOAuth flow failed: ${err.message}`);
      process.exitCode = 1;
    },
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.stack ?? e.message : e);
    process.exitCode = 1;
  });
}

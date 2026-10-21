// Plumbing shared by the weather (weather.mjs) and its placeholder florist
// puppet (weather-puppet.mjs): settings, the garden-only guard, a PostgREST
// client, and the signed Shopify webhook. No npm dependencies, so the GitHub
// workflow runs it on a bare Node 22.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const GARDEN_REF = "your-project-ref";
export const WORKER_URL = "https://facundo-ingest-worker-garden.your-subdomain.workers.dev";
export const DASHBOARD_URL = "https://facundo-dashboard-garden.your-subdomain.workers.dev";
export const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

// Locally the values live in the main checkout's .env files (a worktree has
// none); in GitHub Actions they arrive as GARDEN_* environment variables.
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.replace(/\r$/, ""));
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
}
const mainCheckout = ROOT.split(`${path.sep}.claude${path.sep}worktrees${path.sep}`)[0];
for (const dir of new Set([ROOT, mainCheckout])) {
  loadEnvFile(path.join(dir, ".env"));
  loadEnvFile(path.join(dir, "dashboard", ".env.local"));
}

const SUPABASE_URL = (process.env.GARDEN_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
const SERVICE_KEY = process.env.GARDEN_SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const WEBHOOK_SECRET = process.env.GARDEN_SHOPIFY_WEBHOOK_SECRET;

if (SUPABASE_URL !== `https://${GARDEN_REF}.supabase.co`) {
  console.error(`REFUSING: the database is not the garden (side-project ${GARDEN_REF}) Supabase`);
  process.exit(1);
}
if (!SERVICE_KEY || !WEBHOOK_SECRET) {
  console.error("REFUSING: GARDEN_SUPABASE_SERVICE_ROLE_KEY and GARDEN_SHOPIFY_WEBHOOK_SECRET are both required");
  process.exit(1);
}

/** PostgREST call with the service role. `query` is the part after /rest/v1/. */
export async function db(query, { method = "GET", body, prefer } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/json",
      ...(prefer ? { Prefer: prefer } : method === "GET" ? {} : { Prefer: "return=representation" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${query.split("?")[0]} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

export const inList = (values) => `in.(${values.map((v) => `"${v}"`).join(",")})`;

/** Refuses to plant unless every switch that keeps the garden away from real
 *  people and money is in its safe position (docs/agent-factory/garden-deploy.md). */
export async function preflight() {
  const [s] = await db("app_settings?id=eq.1&select=*");
  if (!s) throw new Error("REFUSING: no app_settings row");
  const bad = [];
  if (s.test_mode !== true) bad.push("test_mode is not true");
  if (!s.test_email) bad.push("test_email is not set");
  if (s.payments_live !== false) bad.push("payments_live is not false");
  if (s.shopify_writeback_enabled !== false) bad.push("shopify_writeback_enabled is not false");
  if (s.test_shop_matching !== "exclude") bad.push("test_shop_matching is not 'exclude'");
  if (bad.length) throw new Error(`REFUSING: ${bad.join("; ")}`);
  return s;
}

async function hmac(body) {
  return crypto.createHmac("sha256", WEBHOOK_SECRET).update(body, "utf8").digest("base64");
}

/** POSTs a Shopify-shaped webhook to the garden worker's real /webhooks/shopify. */
export async function postWebhook(payload, { topic = "orders/create", badSignature = false } = {}) {
  const body = JSON.stringify(payload);
  const res = await fetch(`${WORKER_URL}/webhooks/shopify`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Shopify-Topic": topic,
      "X-Shopify-Hmac-Sha256": badSignature ? "Z2FyZGVuLWJhZC1zaWduYXR1cmU=" : await hmac(body),
    },
    body,
  });
  return res.status;
}

/** Deterministic per-day randomness: the same date always plants the same orders. */
export function seededRandom(seed) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const madridDate = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(d);
export const addDays = (isoDate, n) => new Date(Date.parse(`${isoDate}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
export const compact = (isoDate) => isoDate.replaceAll("-", "");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

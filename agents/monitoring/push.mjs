// Pushes the garden's monitoring to Grafana Cloud: the datasources, the three
// dashboards in agents/monitoring/dashboards/, the email contact point and the
// alert rule. Idempotent: every object has a stable uid and is overwritten.
//
//   node --env-file=.env agents/monitoring/push.mjs [--check]
//
// Reads GRAFANA_URL, GRAFANA_TOKEN, GRAFANA_DB_PASSWORD, LANGFUSE_PUBLIC_KEY,
// LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL, TRIGGER_PROD_SECRET_KEY, GARDEN_API_KEY
// (the garden's OpenRouter key) and, when it exists, POSTHOG_PERSONAL_API_KEY.
// --check only tests the datasources and lists the alert rule's state.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GARDEN_POOLER, GARDEN_REF } from "./apply.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const base = env.GRAFANA_URL?.replace(/\/$/, "");
if (!base || !env.GRAFANA_TOKEN) throw new Error("GRAFANA_URL and GRAFANA_TOKEN must be set");

export const ALERT_EMAIL = "owner@example.com";
export const FOLDER = { uid: "garden-monitoring", title: "Garden" };
const INFINITY = "yesoreyeram-infinity-datasource";

async function grafana(method, path, body, extra = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.GRAFANA_TOKEN}`, "Content-Type": "application/json", ...extra },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  const json = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  return { status: res.status, ok: res.ok, json };
}

const infinity = (uid, name, url, auth) => ({
  uid, name, type: INFINITY, access: "proxy", url,
  jsonData: { auth_method: auth.method, allowedHosts: [new URL(url).origin] },
  basicAuth: auth.method === "basicAuth",
  basicAuthUser: auth.user ?? "",
  secureJsonData: auth.method === "basicAuth" ? { basicAuthPassword: auth.password } : { bearerToken: auth.token },
});

export function datasources() {
  return [
    {
      uid: "garden-postgres", name: "Garden database", type: "grafana-postgresql-datasource", access: "proxy",
      url: `${GARDEN_POOLER.host}:${GARDEN_POOLER.port}`, user: `grafana_ro.${GARDEN_REF}`, database: GARDEN_POOLER.database,
      jsonData: { database: GARDEN_POOLER.database, sslmode: "require", postgresVersion: 1500, maxOpenConns: 5, maxIdleConns: 2, connMaxLifetime: 14400, timeInterval: "1d" },
      secureJsonData: { password: env.GRAFANA_DB_PASSWORD },
      need: ["GRAFANA_DB_PASSWORD"],
    },
    { ...infinity("garden-langfuse", "Langfuse (garden)", env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com", { method: "basicAuth", user: env.LANGFUSE_PUBLIC_KEY, password: env.LANGFUSE_SECRET_KEY }), need: ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"] },
    { ...infinity("garden-trigger", "Trigger.dev (garden clock)", "https://api.trigger.dev", { method: "bearerToken", token: env.TRIGGER_PROD_SECRET_KEY }), need: ["TRIGGER_PROD_SECRET_KEY"] },
    { ...infinity("garden-openrouter", "OpenRouter (garden AI key)", "https://openrouter.ai", { method: "bearerToken", token: env.GARDEN_API_KEY }), need: ["GARDEN_API_KEY"] },
    // Until the owner pastes a personal key, the datasource exists with no token and
    // its panels say so; rerunning push.mjs after adding the key fills it in.
    // The garden sends to the owner's own PostHog project (US region, "Default project"), not production.
    { ...infinity("garden-posthog", "PostHog (garden project, US)", env.POSTHOG_API_HOST || "https://us.posthog.com", { method: "bearerToken", token: env.POSTHOG_PERSONAL_API_KEY || "missing: set POSTHOG_PERSONAL_API_KEY and rerun push.mjs" }), need: [] },
  ];
}

async function upsertDatasource({ need, ...ds }) {
  const missing = need.filter((k) => !env[k]);
  if (missing.length) return `skipped ${ds.uid}: ${missing.join(", ")} not set`;
  const found = await grafana("GET", `/api/datasources/uid/${ds.uid}`);
  const res = found.ok
    ? await grafana("PUT", `/api/datasources/uid/${ds.uid}`, { ...ds, id: found.json.id, version: found.json.version })
    : await grafana("POST", "/api/datasources", ds);
  if (!res.ok) throw new Error(`datasource ${ds.uid}: ${res.status} ${JSON.stringify(res.json)}`);
  return `${found.ok ? "updated" : "created"} ${ds.uid}`;
}

async function testDatasource(uid) {
  const res = await grafana("GET", `/api/datasources/uid/${uid}/health`);
  return { uid, status: res.json?.status ?? res.status, message: String(res.json?.message ?? "").slice(0, 160) };
}

async function ensureFolder() {
  const found = await grafana("GET", `/api/folders/${FOLDER.uid}`);
  if (found.ok) return;
  const res = await grafana("POST", "/api/folders", FOLDER);
  if (!res.ok) throw new Error(`folder: ${res.status} ${JSON.stringify(res.json)}`);
}

async function pushDashboards() {
  const dir = join(here, "dashboards");
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const dashboard = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const res = await grafana("POST", "/api/dashboards/db", { dashboard: { ...dashboard, id: null, version: undefined }, folderUid: FOLDER.uid, overwrite: true, message: "agents/monitoring/push.mjs" });
    if (!res.ok) throw new Error(`dashboard ${f}: ${res.status} ${JSON.stringify(res.json)}`);
    out.push(`${base}${res.json.url}`);
  }
  return out;
}

export const CONTACT_POINT = {
  uid: "garden-email", name: "Garden: email the owner", type: "email",
  settings: { addresses: ALERT_EMAIL, singleEmail: true, subject: "Garden: an agent is below its minimum two days running" },
  disableResolveMessage: false,
};

// Below on today's window and on yesterday's, each with enough cases: the same
// two-day rule the factory sweep applies (agents/factory/thresholds.mjs). Advice
// measures never alert, because only decides rows are read.
export const ALERT_SQL = `select t.agent, t.measure, t.nick,
  case when t.below and y.below then 1 else 0 end as below_two_days
from agent_daily_metrics t
join agent_daily_metrics y on y.agent = t.agent and y.measure = t.measure and y.day = t.day - 1
where t.day = monitoring_day(now()) and t.decides`;

export const ALERT_RULE = {
  uid: "garden-agent-below-minimum",
  title: "An agent is below its minimum two days running",
  ruleGroup: "garden-agents",
  folderUID: FOLDER.uid,
  noDataState: "OK",
  execErrState: "Error",
  for: "0s",
  condition: "C",
  annotations: {
    summary: "{{ $labels.nick }} is below its minimum on {{ $labels.measure }} two days running.",
    description: "A deep-analysis factory card opens for this agent on the next sweep. See the drill-down dashboard for the failing cases.",
    __dashboardUid__: "garden-agent-detail",
    __panelId__: "3",
  },
  labels: { team: "garden" },
  notification_settings: { receiver: CONTACT_POINT.name },
  data: [
    {
      refId: "A", datasourceUid: "garden-postgres", relativeTimeRange: { from: 172800, to: 0 },
      model: { refId: "A", rawQuery: true, editorMode: "code", format: "table", rawSql: ALERT_SQL, datasource: { type: "grafana-postgresql-datasource", uid: "garden-postgres" } },
    },
    { refId: "B", datasourceUid: "__expr__", relativeTimeRange: { from: 0, to: 0 }, model: { refId: "B", type: "reduce", expression: "A", reducer: "last", datasource: { type: "__expr__", uid: "__expr__" } } },
    { refId: "C", datasourceUid: "__expr__", relativeTimeRange: { from: 0, to: 0 }, model: { refId: "C", type: "threshold", expression: "B", conditions: [{ evaluator: { type: "gt", params: [0] } }], datasource: { type: "__expr__", uid: "__expr__" } } },
  ],
};

async function pushAlerting() {
  const prov = { "X-Disable-Provenance": "true" };
  const cps = await grafana("GET", "/api/v1/provisioning/contact-points");
  const cp = (cps.json ?? []).find((c) => c.uid === CONTACT_POINT.uid);
  const cpRes = cp
    ? await grafana("PUT", `/api/v1/provisioning/contact-points/${CONTACT_POINT.uid}`, CONTACT_POINT, prov)
    : await grafana("POST", "/api/v1/provisioning/contact-points", CONTACT_POINT, prov);
  if (!cpRes.ok) throw new Error(`contact point: ${cpRes.status} ${JSON.stringify(cpRes.json)}`);

  // The group holds just this rule; PUT replaces it whole, creating the rule the first time.
  const group = await grafana("PUT", `/api/v1/provisioning/folder/${FOLDER.uid}/rule-groups/${ALERT_RULE.ruleGroup}`,
    { title: ALERT_RULE.ruleGroup, folderUid: FOLDER.uid, interval: 3600, rules: [ALERT_RULE] }, prov);
  if (!group.ok) throw new Error(`alert rule group: ${group.status} ${JSON.stringify(group.json)}`);
  return [`contact point ${cp ? "updated" : "created"} (${ALERT_EMAIL})`, "alert rule pushed, checked every hour"];
}

async function ruleState() {
  const res = await grafana("GET", "/api/prometheus/grafana/api/v1/rules");
  const rules = (res.json?.data?.groups ?? []).flatMap((g) => g.rules).filter((r) => r.uid === ALERT_RULE.uid || r.name === ALERT_RULE.title);
  return rules.map((r) => ({ state: r.state, health: r.health, lastEvaluation: r.lastEvaluation, alerts: (r.alerts ?? []).length, error: r.lastError || undefined }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  if (!check) {
    for (const ds of datasources()) console.log(await upsertDatasource(ds));
    await ensureFolder();
    for (const url of await pushDashboards()) console.log(`dashboard ${url}`);
    for (const line of await pushAlerting()) console.log(line);
  }
  console.table(await Promise.all(datasources().map((d) => testDatasource(d.uid))));
  console.log("alert rule:", JSON.stringify(await ruleState()));
}

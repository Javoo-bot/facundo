// Customer complaints into the garden as alerts (factory_alerts, source
// 'complaint'), each linked to its order and placed on a general rule, or on
// none (the owner's maybe-product-change list). The sweep turns them into cards by
// CARD_LIFE in general-rules.mjs, like every other alert; this script never
// writes a card.
//
//   node agents/factory/complaint-intake.mjs --file export.csv [--dry-run]   # CSV: id, order, complaint, date
//   node agents/factory/complaint-intake.mjs --file export.json [--dry-run]  # rows like the CSV, or Octocom conversations
//   node agents/factory/complaint-intake.mjs --octocom [--days 2] [--dry-run] # Octocom's API (OCTOCOM_API, OCTOCOM_BASE_URL, OCTOCOM_BUSINESS_SLUG)
//
// Garden only (GARDEN_SUPABASE_URL / GARDEN_SUPABASE_SERVICE_ROLE_KEY); gardenRest
// refuses any other URL. Safe to rerun: an alert's id is the complaint's ref,
// so reading the same days or file again adds nothing (placed once). --dry-run
// with no garden keys still classifies, without linking orders.

import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { parseCsv, complaintFromRow, complaintFromOctocom, isComplaint, classifyComplaint, complaintAlert } from "./complaints.mjs";
import { RULES, MANAGERS } from "./general-rules.mjs";
import { gardenRest, inList } from "../monitoring/garden-rest.mjs";
import { madridDay } from "../monitoring/deep-analysis.mjs";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const dryRun = args.includes("--dry-run");
// The business whose conversations Octocom returns (OCTOCOM_BUSINESS_SLUG).
const OCTOCOM_BUSINESS_SLUG = process.env.OCTOCOM_BUSINESS_SLUG;
const file = opt("--file");
const days = Number(opt("--days") ?? 2);

async function octocomConversations(fromIso, toIso) {
  const base = `${process.env.OCTOCOM_BASE_URL.replace(/\/$/, "")}/rest/v1`;
  const get = async (p, opts = {}) => {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(base + p, { ...opts, headers: { "X-API-Key": process.env.OCTOCOM_API, "content-type": "application/json" }, signal: AbortSignal.timeout(60_000) });
      if (r.status === 429 && attempt < 5) { await new Promise((s) => setTimeout(s, 15_000)); continue; }
      if (!r.ok) throw new Error(`octocom ${r.status} ${p.split("?")[0]}`);
      return r.json();
    }
  };
  const ids = [];
  for (let page = 1; ; page++) {
    const r = await get(`/conversations?businessSlug=${OCTOCOM_BUSINESS_SLUG}&spam=false&limit=200&page=${page}&startDate=${fromIso}&endDate=${toIso}`);
    ids.push(...r.data.map((c) => c.id));
    if (!r.pagination?.hasMore) break;
  }
  const out = [];
  for (let i = 0; i < ids.length; i += 200) {
    const r = await get("/conversations/bulk", { method: "POST", body: JSON.stringify({ ids: ids.slice(i, i + 200) }) });
    out.push(...r.data.filter((c) => c.businessSlug === OCTOCOM_BUSINESS_SLUG));
  }
  return out;
}

async function readComplaints() {
  if (file) {
    const text = readFileSync(file, "utf8");
    if (extname(file).toLowerCase() === ".csv") return parseCsv(text).map((r) => complaintFromRow(r, "csv"));
    const json = JSON.parse(text);
    const list = Array.isArray(json) ? json : json.data ?? [];
    return list.map((r) => (Array.isArray(r.messages) ? complaintFromOctocom(r) : complaintFromRow(r, "json"))).filter(Boolean)
      .filter((c) => c.error || c.source !== "octocom" || isComplaint(c.text));
  }
  if (args.includes("--octocom")) {
    if (!process.env.OCTOCOM_API || !process.env.OCTOCOM_BASE_URL || !OCTOCOM_BUSINESS_SLUG) {
      console.log("octocom source off: OCTOCOM_API / OCTOCOM_BASE_URL / OCTOCOM_BUSINESS_SLUG not set");
      return [];
    }
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 3600_000);
    const conversations = await octocomConversations(from.toISOString(), to.toISOString());
    const complaints = conversations.map(complaintFromOctocom).filter((c) => c && isComplaint(c.text));
    console.log(`octocom: ${conversations.length} conversations in ${days} days, ${complaints.length} complaints`);
    return complaints;
  }
  console.error("usage: complaint-intake.mjs --file <export.csv|export.json> | --octocom [--days N]  [--dry-run]");
  process.exit(2);
}

const db = process.env.GARDEN_SUPABASE_URL || !dryRun ? gardenRest() : null;

// order number -> garden order. Shopify names are '#1234567'; a few rows hold the bare number.
async function linkOrders(numbers) {
  if (!db || !numbers.length) return new Map();
  const names = numbers.flatMap((n) => [`#${n}`, n]);
  const found = new Map();
  for (let i = 0; i < names.length; i += 200) {
    const rows = await db.selectAll(`orders?order_name=in.${inList(names.slice(i, i + 200))}&select=id,order_name,status,escalation_reason`);
    for (const o of rows) found.set(o.order_name.replace(/^#/, ""), o);
  }
  return found;
}

const raw = await readComplaints();
const skipped = raw.filter((c) => c.error);
const complaints = raw.filter((c) => !c.error);
const orders = await linkOrders([...new Set(complaints.map((c) => c.order_number).filter(Boolean))]);
const rows = complaints.map((c) => {
  const order = c.order_number ? orders.get(c.order_number) ?? null : null;
  return complaintAlert(c, order, classifyComplaint(c.text, order), madridDay(new Date(c.received_at)));
});
const ownerName = (ruleId) => MANAGERS[RULES.find((r) => r.id === ruleId)?.owner]?.name;

console.log(`${rows.length} complaints, ${rows.filter((r) => r.ref.order_id).length} linked to a garden order${db ? "" : " (no garden keys: orders not linked)"}${skipped.length ? `, ${skipped.length} rows skipped` : ""}`);
for (const s of skipped) console.log(`  skipped ${s.ref}: ${s.error}`);
if (rows.length) console.table(rows.map((r) => ({ order: r.ref.order_name, rule: r.rule_id ?? "-", owner: r.rule_id ? ownerName(r.rule_id) : "the owner (maybe a product change)", topic: r.ref.topic, match: r.match, why: r.why ?? r.key })));

if (dryRun) console.log("dry run: nothing written");
else if (rows.length) {
  // Placed once: a complaint already there keeps its first placing.
  for (let i = 0; i < rows.length; i += 500) await db.rest("POST", "factory_alerts", rows.slice(i, i + 500), { Prefer: "resolution=ignore-duplicates,return=minimal" });
  console.log(`factory_alerts: ${rows.length} complaint alerts written (any already there kept); the next sweep counts them per general rule`);
}

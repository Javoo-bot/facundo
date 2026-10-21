// Writes docs/agent-factory/garden-reports/<date>.md: the garden's day in plain words for the owner.
// Run score.mjs first; this only reads what it wrote.
//
//   node --env-file=dashboard/.env.local agents/garden/daily-report.mjs [--tone tone.json] [--out dir] [--date YYYY-MM-DD]
//
// Env: the Supabase pair (watch-db.mjs) and, for the cost line, GARDEN_API_KEY (the garden's
// OpenRouter key). --tone is the file tone/geval.py wrote; without it the tone section says so.

import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gardenDb, madridDate, argValue } from './watch-db.mjs';
import { plain } from './score.mjs';

const LOOKBACK_DAYS = 14;
const DAILY_LIMIT_USD = 1;
const MARK = /<!-- garden-report: (\{.*\}) -->/;

const date = argValue('date') ?? madridDate();
const outDir = argValue('out') ?? fileURLToPath(new URL('../../docs/agent-factory/garden-reports/', import.meta.url));
const tonePath = argValue('tone');
const rest = gardenDb();

const scenarios = await rest(
  `garden_scenarios?select=id,day,shopify_order_id,stage_id,branch_id,title,expected_outcome,expected,created_at,garden_scores(scored_on,actual_outcome,passed,notes,detail)` +
  `&created_at=gte.${new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString()}&order=created_at`,
);
const scored = scenarios.flatMap((s) => s.garden_scores.filter((g) => g.scored_on === date).map((g) => ({ ...s, score: g })));
const running = scenarios.filter((s) => s.garden_scores.length === 0);
const failed = scored.filter((s) => !s.score.passed);

const cost = await openRouterCost();
const tone = tonePath && existsSync(tonePath) ? JSON.parse(readFileSync(tonePath, 'utf8')) : null;

const md = [
  `# Garden report, ${longDate(date)}`,
  '',
  `<!-- garden-report: ${JSON.stringify({ date, openrouter_usage_total: cost.total ?? null })} -->`,
  '',
  '## Worth a look',
  '',
  ...worthALook(),
  '',
  '## Invented orders judged today',
  '',
  ...scoredSection(),
  '',
  '## Still running',
  '',
  ...runningSection(),
  '',
  '## Cost',
  '',
  costLine(),
  '',
  '## Tone of the agents\' messages',
  '',
  ...toneSection(),
  '',
].join('\n');

mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${date}.md`);
writeFileSync(file, md);
console.log(`wrote ${file}: ${scored.length} judged (${failed.length} failed), ${running.length} still running`);

function worthALook() {
  const items = [];
  const byCase = new Map();
  for (const s of failed) {
    const k = `${s.stage_id}/${s.branch_id ?? 'happy'}`;
    byCase.set(k, [...(byCase.get(k) ?? []), s]);
  }
  for (const group of [...byCase.values()].sort((a, b) => b.length - a.length)) {
    const s = group[0];
    const times = group.length === 1 ? 'once' : `${group.length} times`;
    items.push(`"${s.title}" went wrong ${times}. We expected that it ${plain(s.expected_outcome)}; instead it ${plain(s.score.actual_outcome)}.`);
  }
  if (cost.sinceLast != null && cost.sinceLast > 0.8 * DAILY_LIMIT_USD) {
    items.push(`The garden's AI spent ${usd(cost.sinceLast)} since the last report, close to its ${usd(DAILY_LIMIT_USD)} a day limit. When it hits the limit the agents stop answering.`);
  }
  const worst = tone?.results?.filter((r) => r.score != null && r.score < 0.6).sort((a, b) => a.score - b.score)[0];
  if (worst) items.push(`A message from the agents read badly (tone ${worst.score.toFixed(1)} of 1): ${worst.reason}`);
  if (!scenarios.length) {
    items.push('No invented orders have been planted yet, so there is nothing to judge. This is expected until the order generator (the "weather") is switched on.');
  }
  if (!items.length) return ['Nothing needs you today.'];
  return items.slice(0, 3).map((t, i) => `${i + 1}. ${t}`);
}

function scoredSection() {
  if (!scored.length) return ['None today.'];
  const lines = [
    `${scored.length} invented ${scored.length === 1 ? 'order was' : 'orders were'} judged: ${scored.length - failed.length} went as expected, ${failed.length} did not.`,
    '',
    '| Order | Case | Expected | What happened | OK |',
    '|---|---|---|---|---|',
    ...scored.map((s) => `| ${s.shopify_order_id} | ${cell(s.title)} | ${cell(plain(s.expected_outcome))} | ${cell(plain(s.score.actual_outcome))} | ${s.score.passed ? 'yes' : '**no**'} |`),
  ];
  if (failed.length) {
    lines.push('', '### What broke', '');
    for (const s of failed) lines.push(`- **${s.shopify_order_id}**, ${s.title}. ${s.score.notes}`);
  }
  return lines;
}

function runningSection() {
  if (!running.length) return ['Nothing is still running.'];
  return [
    `${running.length} invented ${running.length === 1 ? 'order has' : 'orders have'} not finished yet and will be judged on a later day:`,
    '',
    ...running.map((s) => `- ${s.shopify_order_id}, ${s.title} (planted ${madridTime(s.created_at)}, expected it ${plain(s.expected_outcome)})`),
  ];
}

function costLine() {
  if (cost.error) return `Not known today: ${cost.error}.`;
  const since = cost.sinceLast == null
    ? 'This is the first report, so there is no figure since the last one yet.'
    : `Since the last report the garden's AI spent ${usd(cost.sinceLast)}.`;
  return `${since} So far this week: ${usd(cost.weekly)}. Daily limit: ${usd(cost.limit ?? DAILY_LIMIT_USD)}. These figures cover the garden's own AI key only, which the tone check below also uses.`;
}

function toneSection() {
  if (!tone) return ['The tone check did not run today.'];
  if (tone.skipped) return [`The tone check did not run today: ${tone.skipped}.`];
  if (!tone.results.length) return ['The agents sent no messages in the last day, so there was nothing to read.'];
  return [
    `Advice only, it never fails a score. ${tone.results.length} of the agents' messages from the last day were read and given a tone score from 0 to 1 (friendly and short is what we want with florists).`,
    '',
    ...tone.results.map((r) => `- ${r.score == null ? 'not scored' : r.score.toFixed(1)}: "${cell(r.excerpt)}" ${r.reason ?? ''}`.trim()),
  ];
}

async function openRouterCost() {
  const key = process.env.GARDEN_API_KEY;
  if (!key) return { error: 'the garden AI key is not set here' };
  try {
    const res = await fetch('https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${key}` } });
    if (!res.ok) return { error: `the AI provider answered ${res.status}` };
    const { data } = await res.json();
    const prev = previousTotal();
    return { total: data.usage, weekly: data.usage_weekly, limit: data.limit, sinceLast: prev == null ? null : Math.max(0, data.usage - prev) };
  } catch (e) {
    return { error: `the AI provider could not be reached (${e.message})` };
  }
}

function previousTotal() {
  if (!existsSync(outDir)) return null;
  const earlier = readdirSync(outDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f) && f < `${date}.md`).sort().pop();
  if (!earlier) return null;
  const m = readFileSync(join(outDir, earlier), 'utf8').match(MARK);
  return m ? JSON.parse(m[1]).openrouter_usage_total : null;
}

function usd(n) {
  return n == null ? 'unknown' : `$${n.toFixed(n < 0.1 ? 3 : 2)}`;
}
function cell(s) {
  return String(s ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ');
}
function longDate(d) {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));
}
function madridTime(iso) {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' }).format(new Date(iso));
}

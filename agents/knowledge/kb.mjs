// node --env-file=<repo>/.env kb.mjs fetch      sources -> .cache/
// node --env-file=<repo>/.env kb.mjs distill    conversations -> de-identified Q&A entries
// node --env-file=<repo>/.env kb.mjs chunks     prints the documents that would be embedded
// node --env-file=<repo>/.env kb.mjs load       applies the migration, embeds new/changed documents, removes vanished ones
// node --env-file=<repo>/.env kb.mjs search <q> vector search, as the agent would run it
// node --env-file=<repo>/.env kb.mjs verify     the labelled questions through the live search
import { conditionsPage, octocomArticles, octocomConversations, save, load, documents } from './sources.mjs';
import { distill } from './distill.mjs';
import { connect, migrate, sync, search } from './store.mjs';
import { questions } from './questions.mjs';

const MONTH_TO = new Date();
const MONTH_FROM = new Date(MONTH_TO.getTime() - 30 * 86_400_000);

const [cmd] = process.argv.slice(2);
if (cmd === 'fetch') {
  const conditions = await conditionsPage();
  const articles = await octocomArticles();
  const { handedOff, matching } = await octocomConversations({ from: MONTH_FROM.toISOString(), to: MONTH_TO.toISOString() });
  save('conditions.json', conditions);
  save('articles.json', articles);
  save('conversations.json', matching);
  console.log(`conditions sections ${conditions.length}, active articles ${articles.length} (public ${articles.filter((a) => a.isPublic).length}), handed-off conversations ${handedOff}, customer>bot>agent>customer ${matching.length}`);
} else if (cmd === 'distill') {
  const convs = load('conversations.json');
  const out = [];
  for (let i = 0; i < convs.length; i += 4) {
    out.push(...(await Promise.all(convs.slice(i, i + 4).map(distill))));
  }
  save('distilled.json', out);
  const cost = out.reduce((s, e) => s + (e.costUsd ?? 0), 0);
  console.log(`distilled ${out.length}: reusable ${out.filter((e) => e.reusable).length}, PII redactions after the model ${out.reduce((s, e) => s + e.piiRedactions, 0)}, cost $${cost.toFixed(4)}`);
  const langs = {}; out.forEach((e) => (langs[e.customer_language] = (langs[e.customer_language] ?? 0) + 1));
  console.log('customer languages', JSON.stringify(langs));
} else if (cmd === 'chunks') {
  const docs = documents();
  const by = {}; docs.forEach((d) => (by[d.source] = (by[d.source] ?? 0) + 1));
  console.log(JSON.stringify(by), 'chars', docs.reduce((s, d) => s + d.text.length, 0), 'longest', Math.max(...docs.map((d) => d.text.length)));
} else if (cmd === 'load') {
  const c = await connect();
  if (await migrate(c)) console.log('applied migration 20261012100000_knowledge_base.sql');
  const docs = documents();
  const r = await sync(c, docs);
  const counts = (await c.query('select source, count(*)::int n, count(*) filter (where reviewed)::int reviewed from knowledge_chunks group by 1 order by 1')).rows;
  console.log(`embedded ${r.changed}, unchanged ${r.unchanged}, removed ${r.removed};`, counts.map((x) => `${x.source} ${x.n} (reviewed ${x.reviewed})`).join(', '));
  const total = counts.reduce((s, x) => s + x.n, 0);
  if (total !== docs.length) { console.error(`row count ${total} != documents ${docs.length}`); process.exitCode = 1; }
  await c.end();
} else if (cmd === 'search') {
  const c = await connect();
  for (const row of await search(c, process.argv.slice(3).join(' '))) {
    console.log(`sim ${row.similarity.toFixed(3)} [authority ${row.authority}${row.reviewed ? '' : ', unreviewed'}${row.outcome ? ', ' + row.outcome : ''}] ${row.title}  (${row.ref})`);
  }
  await c.end();
} else if (cmd === 'verify') {
  const c = await connect();
  const qs = questions();
  let h1 = 0, h3 = 0;
  for (const [q, refs] of qs) {
    const rows = await search(c, q, 3);
    const rank = rows.findIndex((r) => refs.includes(r.ref)) + 1;
    if (rank === 1) h1++; if (rank) h3++;
    if (!rank) console.log(`MISS  ${q}  -> ${rows.map((r) => r.title).join(' | ')}`);
  }
  console.log(`vector search in Supabase: hit@1 ${h1}/${qs.length}, hit@3 ${h3}/${qs.length}`);
  await c.end();
} else {
  console.error('usage: kb.mjs fetch|distill|chunks|load|search <question>|verify');
  process.exit(1);
}

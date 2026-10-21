// node --env-file=<repo>/.env eval-embeddings.mjs [model ...]
// Embeds every knowledge document and 18 labelled customer questions per model; reports hit@1, hit@3, MRR and cost.
import { documents } from './sources.mjs';
import { questions } from './questions.mjs';

const QUESTIONS = questions();

const MODELS = process.argv.slice(2).length ? process.argv.slice(2) : [
  'qwen/qwen3-embedding-8b', 'qwen/qwen3-embedding-4b', 'baai/bge-m3', 'intfloat/multilingual-e5-large',
  'perplexity/pplx-embed-v1-0.6b', 'nvidia/nemotron-3-embed-1b:free', 'openai/text-embedding-3-small', 'google/gemini-embedding-2',
];

const QUERY_PREFIX = {
  'qwen/qwen3-embedding-8b': 'Instruct: Given a customer support question, retrieve the passage that answers it\nQuery: ',
  'qwen/qwen3-embedding-4b': 'Instruct: Given a customer support question, retrieve the passage that answers it\nQuery: ',
  'intfloat/multilingual-e5-large': 'query: ',
};
const DOC_PREFIX = { 'intfloat/multilingual-e5-large': 'passage: ' };

async function embed(model, input) {
  const r = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, input }),
  });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 160)}`);
  const j = await r.json();
  return { vectors: j.data.sort((a, b) => a.index - b.index).map((d) => d.embedding), tokens: j.usage?.prompt_tokens ?? j.usage?.total_tokens ?? 0, cost: j.usage?.cost ?? null };
}

const cosine = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / Math.sqrt(x * y); };

const docs = documents();
const prices = Object.fromEntries((await (await fetch('https://openrouter.ai/api/v1/embeddings/models')).json()).data.map((m) => [m.id, +m.pricing.prompt]));
for (const [q, refs] of QUESTIONS) if (!refs.length || refs.some((r) => !docs.some((d) => d.ref === r))) throw new Error(`bad label for: ${q}`);

console.log(`${docs.length} documents, ${QUESTIONS.length} questions\n`);
console.log('model'.padEnd(36), 'hit@1'.padStart(6), 'hit@3'.padStart(6), '  MRR', '  dims', ' $/1M tok', '  $ to embed KB');
for (const model of MODELS) {
  try {
    const D = [];
    let tokens = 0;
    for (let i = 0; i < docs.length; i += 32) {
      const r = await embed(model, docs.slice(i, i + 32).map((d) => (DOC_PREFIX[model] ?? '') + d.text));
      D.push(...r.vectors); tokens += r.tokens;
    }
    const Q = (await embed(model, QUESTIONS.map(([q]) => (QUERY_PREFIX[model] ?? '') + q))).vectors;
    let h1 = 0, h3 = 0, mrr = 0;
    QUESTIONS.forEach(([, refs], qi) => {
      const ranked = docs.map((d, i) => [d.ref, cosine(Q[qi], D[i])]).sort((a, b) => b[1] - a[1]).map(([r]) => r);
      const rank = ranked.findIndex((r) => refs.includes(r)) + 1;
      if (rank === 1) h1++; if (rank && rank <= 3) h3++; if (rank) mrr += 1 / rank;
    });
    const n = QUESTIONS.length;
    console.log(model.padEnd(36), `${h1}/${n}`.padStart(6), `${h3}/${n}`.padStart(6), (mrr / n).toFixed(2).padStart(5), String(D[0].length).padStart(6),
      (prices[model] * 1e6).toFixed(3).padStart(9), ('$' + (tokens * prices[model]).toFixed(6)).padStart(15));
  } catch (e) {
    console.log(model.padEnd(36), 'ERROR', e.message);
  }
}

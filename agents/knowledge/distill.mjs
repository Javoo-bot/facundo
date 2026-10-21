// Turns each CX conversation into one de-identified Q&A entry. Raw transcripts never reach the knowledge base:
// a retrieved passage must not carry one customer's details into a reply to another.
const MODEL = 'anthropic/claude-haiku-5.5';

const QUOTE_START = /^(On .+wrote:|El .+escribi[oó]:|Am .+schrieb.*:|Le .+a écrit :|Il giorno .+ha scritto:|-{2,}\s*Original Message|From: |De: |Von: |>)/m;
const clip = (text, n) => (text.length > n ? text.slice(0, n) + ' […]' : text);

export function transcript(c) {
  return (c.messages ?? [])
    .filter((m) => m.sender === 'customer' || m.isSent !== false)
    .map((m) => {
      const body = (m.text ?? '').split(QUOTE_START)[0].trim();
      return `[${m.sender === 'agent' ? 'CX agent' : m.sender}] ${clip(body, 2500)}`;
    })
    .join('\n\n');
}

const TOOL = {
  type: 'function',
  function: {
    name: 'record_entry',
    description: 'Record the reusable support knowledge in this conversation, with every personal detail removed.',
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['reusable', 'not_reusable_reason', 'customer_language', 'topic', 'customer_question', 'cx_answer', 'policy_points', 'outcome'],
      properties: {
        reusable: { type: 'boolean', description: 'False when the answer only makes sense for this one order (e.g. a tracking update) and teaches nothing for other customers.' },
        not_reusable_reason: { type: 'string' },
        customer_language: { type: 'string', description: 'ISO 639-1 code of the language the customer wrote in.' },
        topic: { type: 'string', description: 'A few words, e.g. "late delivery refund request".' },
        customer_question: { type: 'string', description: 'What the customer needed, written generically in English. No names, emails, phones, addresses, order or tracking numbers, dates of this order.' },
        cx_answer: { type: 'string', description: 'How the CX agent answered or resolved it, generically, in English, as guidance another agent could follow. Same exclusions.' },
        policy_points: { type: 'array', items: { type: 'string' }, description: 'Rules the agent stated or applied, e.g. "Refunds are issued as a voucher valid one year".' },
        outcome: { type: 'string', enum: ['resolved', 'unresolved', 'unclear'] },
      },
    },
  },
};

const PII = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\+?\d[\d\s().-]{7,}\d/g, '[number]'],
  [/#\s?\d{4,}/g, '[order]'],
  [/https?:\/\/\S+/g, '[link]'],
];
export function scrub(text) {
  let hits = 0;
  const out = PII.reduce((t, [re, label]) => t.replace(re, () => { hits++; return label; }), text ?? "");
  return { text: out, hits };
}

export async function distill(c) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      tools: [TOOL],
      tool_choice: { type: 'function', function: { name: 'record_entry' } },
      messages: [
        { role: 'system', content: 'You turn Facundo customer-support conversations (a flower delivery company) into reusable knowledge for a support agent. The customer first talked to a bot, then a human CX agent took over. Capture what the human agent did. Never include personal data.' },
        { role: 'user', content: transcript(c) },
      ],
    }),
  });
  if (!r.ok) throw new Error(`openrouter ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const entry = JSON.parse(j.choices[0].message.tool_calls[0].function.arguments);
  let hits = 0;
  for (const k of ['customer_question', 'cx_answer']) { const s = scrub(entry[k]); entry[k] = s.text; hits += s.hits; }
  entry.policy_points = (entry.policy_points ?? []).map((p) => { const s = scrub(p); hits += s.hits; return s.text; });
  return { ...entry, piiRedactions: hits, conversationId: c.id, closedAt: c.closedAt, costUsd: j.usage?.cost ?? null };
}

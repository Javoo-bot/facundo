# Knowledge base

What the support agents can look up when a question is about policy or process
rather than about one order. It lives in the side-project Supabase as
`knowledge_chunks`, searched with `match_knowledge(embedding, k)`.

| Source | Authority | Reviewed |
|---|---|---|
| Octocom articles (`businessSlug=facundo`, active only) | 1, the source of truth | yes |
| fc.example.com conditions of purchase, one row per section | 2 | yes |
| Past Octocom conversations, customer → bot → CX agent → customer, last 30 days, distilled by Haiku 5.5 into de-identified Q&A | 3, examples | no, until CX sets `reviewed` |

When two passages disagree, the lower authority number wins. Raw
conversations never enter the table: each one is rewritten without names,
emails, phones, addresses or order numbers, then checked by code for any
that slipped through. The Octocom id is kept so an entry can be traced.

## Refresh

```bash
npm install
node --env-file=../../.env kb.mjs fetch     # sources into .cache/ (gitignored: raw conversations)
node --env-file=../../.env kb.mjs distill   # about $0.04 for 33 conversations
node --env-file=../../.env kb.mjs load      # embeds only new or changed rows, removes vanished ones
node --env-file=../../.env kb.mjs verify    # 18 labelled questions through the live search
node --env-file=../../.env kb.mjs search "how long does a refund take?"
```

`load` keeps a CX `reviewed = true` across refreshes.

## Why this embedding model

`eval-embeddings.mjs` scores eight OpenRouter models on the labelled
questions in `questions.mjs` (English, Spanish, German, Italian, French).
On 2026-10-12, `perplexity/pplx-embed-v1-0.6b` found the right passage in
the top 3 for 17 of 18 questions at $0.004 per million tokens. Google's
`gemini-embedding-2` got one more first-place hit at 50x the price. Adding
keyword search lowered the top-3 score to 14 or 15 at every weight tried,
so search is vector only. Rerun the eval before switching models.

-- Knowledge base for the support agents: Octocom articles, the published conditions of purchase,
-- and de-identified Q&A distilled from past CX conversations. Loaded by agents/knowledge/kb.mjs.
-- Embeddings: perplexity/pplx-embed-v1-0.6b via OpenRouter (1024 dims), chosen by eval-embeddings.mjs.

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.knowledge_chunks (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source          text NOT NULL CHECK (source IN ('octocom_article', 'conditions_page', 'cx_conversation')),
  -- Octocom is the source of truth (user, 2026-10-12): when passages disagree, the lower number wins.
  authority       smallint NOT NULL CHECK (authority IN (1, 2, 3)),
  ref             text NOT NULL UNIQUE,
  title           text NOT NULL,
  content         text NOT NULL,
  language        text,
  source_version  text,
  outcome         text CHECK (outcome IN ('resolved', 'unresolved', 'unclear')),
  reviewed        boolean NOT NULL DEFAULT false,
  is_public       boolean,
  content_hash    text NOT NULL,
  embedding_model text NOT NULL,
  embedding       extensions.vector(1024) NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_idx ON public.knowledge_chunks USING hnsw (embedding extensions.vector_cosine_ops);

-- No policies: only the service role and the agent runtime's database role read it.
ALTER TABLE public.knowledge_chunks ENABLE ROW LEVEL SECURITY;

-- Vector search, ties broken by authority. Keyword fusion was measured and dropped: on the 18 labelled
-- questions in agents/knowledge/questions.mjs it lowered hit@3 from 17 to 14-15 at every weight tried.
CREATE OR REPLACE FUNCTION public.match_knowledge(query_embedding extensions.vector(1024), match_count int DEFAULT 5)
RETURNS TABLE (ref text, title text, content text, source text, authority smallint, reviewed boolean, outcome text, similarity double precision)
LANGUAGE sql STABLE
SET search_path = public, extensions
AS $$
  SELECT k.ref, k.title, k.content, k.source, k.authority, k.reviewed, k.outcome, 1 - (k.embedding <=> query_embedding) AS similarity
  FROM knowledge_chunks k
  ORDER BY k.embedding <=> query_embedding, k.authority
  LIMIT match_count;
$$;

REVOKE ALL ON FUNCTION public.match_knowledge(extensions.vector, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.knowledge_chunks FROM anon, authenticated;

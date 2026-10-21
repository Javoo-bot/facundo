-- Per-run cost + timing capture for ingest jobs (workstream A).
-- LLM cost is exact (tokens x per-model rate), broken down per call type in
-- llm_cost_by_type; apify_cost_usd is the actor run's actual usage_total_usd.
-- All nullable: a running job has null cost until it finishes; old rows stay null.
alter table ingest_jobs add column if not exists input_tokens     bigint;
alter table ingest_jobs add column if not exists output_tokens    bigint;
alter table ingest_jobs add column if not exists llm_calls        integer;
alter table ingest_jobs add column if not exists llm_cost_usd     numeric;
alter table ingest_jobs add column if not exists llm_cost_by_type jsonb;
alter table ingest_jobs add column if not exists apify_cost_usd   numeric;
alter table ingest_jobs add column if not exists florist_count    integer;

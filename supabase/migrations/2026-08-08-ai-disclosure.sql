-- When we told this florist they are talking to an automated assistant.
--
-- EU AI Act Article 50 has applied since 2 August 2026 across every market this
-- funnel targets. It requires that a person is INFORMED they are interacting
-- with an AI system unless that is obvious from the context — and our replies
-- are signed by a named persona with a personal reply-to address, which points
-- the reader the other way and therefore removes that exemption.
--
-- Stored as a TIMESTAMP rather than a boolean on purpose: for a compliance
-- obligation, "when did we tell them" is the answerable question, and a bare
-- true/false cannot answer it afterwards.
--
-- Written once, by lib/conversations.ts, on the first reply a model actually
-- sends in a thread. Deliberately NOT set for funnel touches: those are
-- hand-written catalog copy translated by people, i.e. a mail merge rather than
-- an AI system interacting with anyone.
alter table conversations
  add column if not exists ai_disclosed_at timestamptz;

comment on column conversations.ai_disclosed_at is
  'When the AI disclosure was first sent in this thread (EU AI Act Art. 50). Set by lib/conversations.ts on the first model-written reply; the disclosure line itself is email.disclosure.proactive in the i18n catalog.';

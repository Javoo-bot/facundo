-- What a Concierge turn was given: the exact prompt, the order facts, the
-- published help lines, the money allow-list and the hash of the rules from
-- agents/thinking/concierge.md. Enough to replay a turn and to tell which
-- version of the rules produced it. Null on rows written before this and on
-- every non-Concierge message.
alter table conversation_messages
  add column if not exists ai_context jsonb;

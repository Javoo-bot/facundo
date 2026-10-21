-- Safety-harness rollout stage. 'test' = send to test targets only; 'step' = operator advances
-- each candidate by hand; 'auto' = software may send on match (built later). Default: test.
alter table app_settings add column if not exists workflow_mode text not null default 'test'
  check (workflow_mode in ('test','step','auto'));

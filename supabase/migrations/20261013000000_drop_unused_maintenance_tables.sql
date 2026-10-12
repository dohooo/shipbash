-- Repository maintenance and its GitHub push webhook no longer exist in the
-- code. Drop the four tables they left behind; dropping a table also removes
-- its indexes, constraints, row-level security, policies and privileges.
-- Activities are no longer started by a webhook, a schedule or the CLI, so the
-- trigger_source check narrows to the three sources the code writes.

set lock_timeout = '5s';

drop table public.project_maintenance_schedule_occurrences;
drop table public.project_maintenance_schedules;
drop table public.repository_change_intents;
drop table public.github_webhook_deliveries;

alter table public.activities drop constraint activities_trigger_source_check;
alter table public.activities add constraint activities_trigger_source_check
  check (trigger_source = any (array['web'::text, 'retry'::text, 'slack'::text]));

reset lock_timeout;

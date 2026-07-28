-- PXM-9: immutable external approval snapshot and sequential approval steps.

alter table v2_approval_requests
  add column if not exists source jsonb not null default '{}'::jsonb,
  add column if not exists external_request_id text,
  add column if not exists content_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists approval_line_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists total_steps int not null default 1;

alter table v2_approval_steps
  add column if not exists assignee text,
  add column if not exists approver_channel text,
  add column if not exists task_payload jsonb not null default '{}'::jsonb;

drop index if exists ux_v2_tasks_token;

create unique index if not exists ux_v2_tasks_legacy_token
  on v2_tasks (token_id)
  where token_id is not null and approval_request_id is null;

create unique index if not exists ux_v2_tasks_approval_step
  on v2_tasks (approval_step_id)
  where approval_step_id is not null;

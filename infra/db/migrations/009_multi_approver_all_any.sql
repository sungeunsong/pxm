-- PXM-10: multiple approval tasks per step with ALL/ANY aggregation.

alter table v2_approval_steps
  add column if not exists task_specs jsonb not null default '[]'::jsonb;

drop index if exists ux_v2_tasks_approval_step;

create unique index if not exists ux_v2_tasks_approval_step_assignee
  on v2_tasks (approval_step_id, assignee)
  where approval_step_id is not null;

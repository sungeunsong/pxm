-- PXM-8: single-approver aggregate foundation for dynamic approvals.

create table if not exists v2_approval_requests (
  id uuid primary key,
  instance_id uuid not null references v2_process_instances(id) on delete cascade,
  token_id uuid not null references v2_tokens(id) on delete cascade,
  node_id text not null,
  status text not null default 'IN_PROGRESS',
  current_step_order int not null default 1,
  version int not null default 0,
  result jsonb,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (token_id)
);

create index if not exists idx_v2_approval_requests_instance
  on v2_approval_requests (instance_id, created_at);

create index if not exists idx_v2_approval_requests_status
  on v2_approval_requests (status, updated_at);

create table if not exists v2_approval_steps (
  id uuid primary key,
  request_id uuid not null references v2_approval_requests(id) on delete cascade,
  step_order int not null,
  mode text not null default 'ALL',
  required_count int not null default 1,
  status text not null default 'OPEN',
  version int not null default 0,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (request_id, step_order)
);

create index if not exists idx_v2_approval_steps_request
  on v2_approval_steps (request_id, step_order);

alter table v2_tasks
  add column if not exists approval_request_id uuid
    references v2_approval_requests(id) on delete cascade,
  add column if not exists approval_step_id uuid
    references v2_approval_steps(id) on delete cascade;

create index if not exists idx_v2_tasks_approval_request
  on v2_tasks (approval_request_id, approval_step_id, status);

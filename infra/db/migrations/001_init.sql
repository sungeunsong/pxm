-- DB truth 핵심: instance / jobs / outbox / tasks

create table if not exists process_instance (
  id uuid primary key,
  template_id uuid not null,
  status text not null, -- CREATED/RUNNING/WAITING/FAILED/COMPLETED
  ctx jsonb not null default '{}'::jsonb,

  lock_owner text,
  lock_until timestamptz,
  heartbeat_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists engine_jobs (
  id bigserial primary key,
  instance_id uuid not null references process_instance(id) on delete cascade,
  type text not null, -- START/RESUME/TIMER/RETRY
  run_at timestamptz not null default now(),
  attempt int not null default 0,
  status text not null default 'READY', -- READY/RUNNING/DONE/FAILED
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_engine_jobs_ready on engine_jobs (status, run_at);

create table if not exists event_outbox (
  id bigserial primary key,
  instance_id uuid not null,
  type text not null, -- NODE_STARTED, NODE_COMPLETED...
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_outbox_instance on event_outbox (instance_id, id);

create table if not exists tasks (
  id uuid primary key,
  instance_id uuid not null references process_instance(id) on delete cascade,
  node_id text not null,
  assignee text not null,
  status text not null, -- OPEN/APPROVED/REJECTED
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

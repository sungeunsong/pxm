-- V2 runtime foundation
-- Goal: align runtime model with BPM design without breaking V1 tables.

-- ============================================================
-- Process definition (normalized)
-- ============================================================

create table if not exists v2_process_definitions (
  id uuid primary key default gen_random_uuid(),
  definition_key text not null,
  version int not null,
  name text not null,
  status text not null default 'ACTIVE', -- ACTIVE/INACTIVE/DRAFT
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (definition_key, version)
);

create index if not exists idx_v2_defs_key_status
  on v2_process_definitions (definition_key, status, version desc);

create table if not exists v2_definition_nodes (
  definition_id uuid not null references v2_process_definitions(id) on delete cascade,
  node_id text not null,
  node_type text not null, -- start/service/gateway/approval/timer/end
  label text,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (definition_id, node_id)
);

create index if not exists idx_v2_nodes_type
  on v2_definition_nodes (definition_id, node_type);

create table if not exists v2_definition_edges (
  id bigserial primary key,
  definition_id uuid not null references v2_process_definitions(id) on delete cascade,
  source_node_id text not null,
  target_node_id text not null,
  condition_expr text,
  is_default boolean not null default false,
  eval_order int not null default 100,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (definition_id, source_node_id, eval_order)
);

create index if not exists idx_v2_edges_source
  on v2_definition_edges (definition_id, source_node_id, eval_order);

create index if not exists idx_v2_edges_target
  on v2_definition_edges (definition_id, target_node_id);

-- ============================================================
-- Runtime root (instance)
-- ============================================================

create table if not exists v2_process_instances (
  id uuid primary key,
  process_definition_id uuid not null references v2_process_definitions(id),
  state text not null, -- CREATED/RUNNING/WAITING/COMPLETED/FAILED/TERMINATED
  is_paused boolean not null default false,
  paused_at timestamptz,
  paused_by text,
  pause_origin_instance_id uuid,
  context jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,

  lock_owner text,
  lock_until timestamptz,
  heartbeat_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_v2_instances_state_created
  on v2_process_instances (state, created_at desc);

-- ============================================================
-- Token model
-- ============================================================

create table if not exists v2_tokens (
  id uuid primary key,
  instance_id uuid not null references v2_process_instances(id) on delete cascade,
  node_id text not null,
  status text not null, -- ACTIVE/WAITING/COMPLETED/CONSUMED/FAILED
  parent_token_id uuid,
  scope_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_v2_tokens_instance_status
  on v2_tokens (instance_id, status, created_at);

create index if not exists idx_v2_tokens_instance_node
  on v2_tokens (instance_id, node_id);

-- ============================================================
-- Unified engine job queue
-- ============================================================

create table if not exists v2_engine_jobs (
  id bigserial primary key,
  instance_id uuid not null references v2_process_instances(id) on delete cascade,
  token_id uuid references v2_tokens(id) on delete set null,
  type text not null, -- START/RESUME/RETRY/TIMER/REMINDER/ESCALATION
  run_at timestamptz not null default now(),
  attempt int not null default 0,
  status text not null default 'QUEUED', -- QUEUED/RUNNING/COMPLETED/FAILED
  payload jsonb not null default '{}'::jsonb,
  lock_owner text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_v2_jobs_queue
  on v2_engine_jobs (status, run_at, id);

create index if not exists idx_v2_jobs_instance
  on v2_engine_jobs (instance_id, id);

-- ============================================================
-- Approval aggregate
-- ============================================================

create table if not exists v2_approval_requests (
  id uuid primary key,
  instance_id uuid not null references v2_process_instances(id) on delete cascade,
  token_id uuid not null references v2_tokens(id) on delete cascade,
  node_id text not null,
  source jsonb not null default '{}'::jsonb,
  external_request_id text,
  content_snapshot jsonb not null default '{}'::jsonb,
  approval_line_snapshot jsonb not null default '{}'::jsonb,
  total_steps int not null default 1,
  status text not null default 'IN_PROGRESS', -- PENDING/IN_PROGRESS/APPROVED/REJECTED/CANCELED
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
  mode text not null default 'ALL', -- ALL/ANY
  required_count int not null default 1,
  assignee text,
  approver_channel text,
  task_payload jsonb not null default '{}'::jsonb,
  task_specs jsonb not null default '[]'::jsonb,
  status text not null default 'OPEN', -- LOCKED/OPEN/APPROVED/REJECTED/CANCELED
  version int not null default 0,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (request_id, step_order)
);

create index if not exists idx_v2_approval_steps_request
  on v2_approval_steps (request_id, step_order);

-- ============================================================
-- User tasks
-- ============================================================

create table if not exists v2_tasks (
  id uuid primary key,
  instance_id uuid not null references v2_process_instances(id) on delete cascade,
  token_id uuid references v2_tokens(id) on delete set null,
  approval_request_id uuid references v2_approval_requests(id) on delete cascade,
  approval_step_id uuid references v2_approval_steps(id) on delete cascade,
  node_id text not null,
  assignee text not null,
  status text not null, -- OPEN/APPROVED/REJECTED/CANCELED
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_v2_tasks_assignee_open
  on v2_tasks (assignee, status, created_at desc);

create index if not exists idx_v2_tasks_instance
  on v2_tasks (instance_id, created_at);

create index if not exists idx_v2_tasks_approval_request
  on v2_tasks (approval_request_id, approval_step_id, status);

create index if not exists idx_v2_tasks_history
  on v2_tasks (status, created_at desc, id desc);

create unique index if not exists ux_v2_tasks_legacy_token
  on v2_tasks (token_id)
  where token_id is not null and approval_request_id is null;

create unique index if not exists ux_v2_tasks_approval_step_assignee
  on v2_tasks (approval_step_id, assignee)
  where approval_step_id is not null;

create unique index if not exists ux_v2_tasks_external_approval_token_hash
  on v2_tasks ((payload->'external_approval'->>'token_hash'))
  where payload->'external_approval'->>'token_hash' is not null;

create index if not exists idx_v2_tasks_external_approval_dispatch
  on v2_tasks (status, (payload->>'approver_channel'), (payload->'external_approval'->>'delivery_status'), created_at);

-- ============================================================
-- Internal execution log (detailed)
-- ============================================================

create table if not exists v2_execution_logs (
  id bigserial primary key,
  instance_id uuid not null references v2_process_instances(id) on delete cascade,
  token_id uuid references v2_tokens(id) on delete set null,
  node_id text,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_v2_exec_logs_instance
  on v2_execution_logs (instance_id, id);

-- ============================================================
-- External event outbox (consumer-facing)
-- ============================================================

create table if not exists v2_event_outbox (
  id bigserial primary key,
  instance_id uuid not null references v2_process_instances(id) on delete cascade,
  token_id uuid references v2_tokens(id) on delete set null,
  node_id text,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_v2_outbox_instance
  on v2_event_outbox (instance_id, id);

create index if not exists idx_v2_outbox_event_type
  on v2_event_outbox (event_type, created_at desc);

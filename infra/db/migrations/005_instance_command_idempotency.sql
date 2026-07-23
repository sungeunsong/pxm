create table if not exists v2_instance_command_idempotency (
  key_hash text primary key,
  request_hash text not null,
  result jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_v2_instance_command_idempotency_expires_at
  on v2_instance_command_idempotency (expires_at);

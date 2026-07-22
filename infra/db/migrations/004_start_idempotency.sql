create table if not exists v2_start_idempotency (
  key_hash text primary key,
  request_hash text not null,
  instance_id uuid not null,
  definition_id uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_v2_start_idempotency_expires_at
  on v2_start_idempotency (expires_at);

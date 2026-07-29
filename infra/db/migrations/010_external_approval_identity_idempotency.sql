-- PXM-11: external approval identity snapshots and business-key idempotency.

alter table v2_approval_requests
  add column if not exists source_provider text,
  add column if not exists external_revision int not null default 1,
  add column if not exists payload_hash text;

update v2_approval_requests
set source_provider = case jsonb_typeof(source)
  when 'object' then coalesce(source ->> 'provider', source ->> 'type')
  when 'string' then source #>> '{}'
  else null
end
where source_provider is null
  and external_request_id is not null;

create unique index if not exists ux_v2_approval_requests_external_key
  on v2_approval_requests (source_provider, external_request_id, external_revision)
  where source_provider is not null and external_request_id is not null;

create table if not exists v2_external_principal_mappings (
  provider text not null,
  subject text not null,
  pxm_user_id text not null,
  display_snapshot jsonb not null default '{}'::jsonb,
  version int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider, subject)
);

create index if not exists idx_v2_external_principal_mappings_pxm_user
  on v2_external_principal_mappings (pxm_user_id);

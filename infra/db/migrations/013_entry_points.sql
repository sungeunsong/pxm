-- PXM-69: 진입점 등록 정보 (AI Tool · 게이트웨이 라우트 공통) + 그룹 namespace.
-- 설계: docs/entry-points-design.md

create table if not exists pxm_entry_points (
  id text primary key,
  kind text not null check (kind in ('tool', 'route')),
  group_id text not null,
  tenant_id text null,
  definition_id text not null,
  pinned_version integer not null,
  input_schema jsonb not null,
  input_schema_source text not null default 'derived',
  output_schema jsonb null,
  output_contract text not null default 'free_form',
  side_effect text not null,
  status text not null,
  description text not null default '',
  tags jsonb not null default '[]'::jsonb,
  resource_digest jsonb null,
  history_policy jsonb not null default '{"body":"none"}'::jsonb,
  tool jsonb null,
  route jsonb null,
  tool_name text null,
  route_method text null,
  route_path text null,
  created_by text null,
  updated_by text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ux_pxm_entry_points_tool_name
  on pxm_entry_points (group_id, tool_name) where kind = 'tool';
create unique index if not exists ux_pxm_entry_points_route
  on pxm_entry_points (route_method, route_path) where kind = 'route';
create index if not exists idx_pxm_entry_points_group_status
  on pxm_entry_points (group_id, status, updated_at desc);
create index if not exists idx_pxm_entry_points_definition
  on pxm_entry_points (definition_id, pinned_version);

-- pxm_groups는 API가 처음 기동할 때 만든다. 이미 있으면 namespace만 더한다.
-- 값은 API 기동 시 그룹 이름에서 채운다(AuthzService.onModuleInit).
do $$
begin
  if to_regclass('public.pxm_groups') is not null then
    execute 'alter table pxm_groups add column if not exists namespace text null';
    execute 'create unique index if not exists ux_pxm_groups_namespace on pxm_groups (namespace) where namespace is not null';
  end if;
end $$;

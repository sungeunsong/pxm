-- PXM-16: administrable external principal mapping registry.
-- Extends the PXM-11 runtime lookup table without changing its provider/subject identity key.

alter table v2_external_principal_mappings
  add column if not exists id text,
  add column if not exists group_id text,
  add column if not exists display_name text,
  add column if not exists email text,
  add column if not exists department text,
  add column if not exists status text not null default 'active',
  add column if not exists created_by text,
  add column if not exists updated_by text;

update v2_external_principal_mappings
set id = 'legacy-' || md5(provider || ':' || subject)
where id is null;

update v2_external_principal_mappings
set display_name = coalesce(display_name, display_snapshot ->> 'name'),
    email = coalesce(email, display_snapshot ->> 'email'),
    department = coalesce(department, display_snapshot ->> 'department');

-- pxm_users is created by the API bootstrap on older installations, so a
-- completely fresh database may not have it while SQL migrations are applied.
do $$
begin
  if to_regclass('public.pxm_users') is not null then
    execute $migration$
      update v2_external_principal_mappings mapping
      set group_id = users.group_ids ->> 0
      from pxm_users users
      where mapping.group_id is null
        and users.id = mapping.pxm_user_id
        and jsonb_array_length(users.group_ids) > 0
    $migration$;
  end if;
end $$;

alter table v2_external_principal_mappings
  alter column id set not null;

create unique index if not exists ux_external_principal_mappings_id
  on v2_external_principal_mappings (id);

create index if not exists idx_external_principal_mappings_group_status
  on v2_external_principal_mappings (group_id, status, updated_at desc);

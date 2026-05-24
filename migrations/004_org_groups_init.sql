-- =====================================================================
-- org-chart · 004 · org_groups — sync org chart cross-workspace
--
-- Pattern: org_group là 1 "tổ chức" độc lập với workspace; nhiều ws có
-- thể follow cùng 1 org_group qua mã share 4 chữ số → cùng thấy data
-- org chart. Owner workspace_id = origin (ws nơi tạo) — KHÔNG unshare
-- origin được; chỉ ws non-origin unshare. Delete: owner only, soft.
--
-- Thứ tự: tất cả CREATE TABLE trước (FK forward-ref OK với deferred FK
-- check), CREATE POLICY ở cuối (policy USING/WITH CHECK reference table
-- khác → phải đợi mọi table tồn tại trước).
--
-- Submit qua Admin Portal Migration Reviewer — auto-duplicate sang dev schema.
-- =====================================================================

-- ---------- TABLES (tạo trước, RLS + policy sau) ----------

create table if not exists app_org_chart.org_groups (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 80),
  slug          text not null,
  description   text check (description is null or char_length(description) <= 500),
  owner_user_id uuid not null references auth.users(id),
  created_by    uuid not null references auth.users(id),
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create unique index if not exists idx_og_slug_unique
  on app_org_chart.org_groups (slug) where deleted_at is null;
create index if not exists idx_og_workspace on app_org_chart.org_groups (workspace_id);
create index if not exists idx_og_owner on app_org_chart.org_groups (owner_user_id);

create table if not exists app_org_chart.org_group_workspaces (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  org_group_id  uuid not null references app_org_chart.org_groups(id) on delete cascade,
  added_by      uuid not null references auth.users(id),
  created_by    uuid not null references auth.users(id),
  created_at    timestamptz not null default now(),
  unique (org_group_id, workspace_id)
);
create index if not exists idx_ogw_workspace on app_org_chart.org_group_workspaces (workspace_id);
create index if not exists idx_ogw_group on app_org_chart.org_group_workspaces (org_group_id);

create table if not exists app_org_chart.org_group_share_codes (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  org_group_id      uuid not null references app_org_chart.org_groups(id) on delete cascade,
  code              text not null check (code ~ '^[0-9]{4}$'),
  expires_at        timestamptz,
  used_at           timestamptz,
  used_by           uuid references auth.users(id),
  used_workspace_id uuid references public.workspaces(id),
  created_by        uuid not null references auth.users(id),
  created_at        timestamptz not null default now()
);
create unique index if not exists idx_og_sharecode_active
  on app_org_chart.org_group_share_codes (code) where used_at is null;
create index if not exists idx_og_sharecode_workspace
  on app_org_chart.org_group_share_codes (workspace_id);
create index if not exists idx_og_sharecode_group
  on app_org_chart.org_group_share_codes (org_group_id);

-- ---------- GRANTS + RLS enable ----------

grant select, insert, update, delete on app_org_chart.org_groups to authenticated;
grant select, insert, update, delete on app_org_chart.org_group_workspaces to authenticated;
grant select, insert, update, delete on app_org_chart.org_group_share_codes to authenticated;

alter table app_org_chart.org_groups enable row level security;
alter table app_org_chart.org_group_workspaces enable row level security;
alter table app_org_chart.org_group_share_codes enable row level security;

-- ---------- POLICIES (sau khi mọi table đã tồn tại) ----------

-- org_groups: SELECT mở cross-ws (member origin ws HOẶC member ws đã subscribe).
drop policy if exists "workspace_isolation" on app_org_chart.org_groups;
create policy "workspace_isolation" on app_org_chart.org_groups
for select using (
  workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
  or id in (
    select org_group_id from app_org_chart.org_group_workspaces
    where workspace_id in (
      select workspace_id from public.workspace_members where user_id = auth.uid()
    )
  )
);

-- org_group_workspaces + share_codes: standard workspace_isolation.
drop policy if exists "workspace_isolation" on app_org_chart.org_group_workspaces;
create policy "workspace_isolation" on app_org_chart.org_group_workspaces
for all using (
  workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
) with check (
  workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
);

drop policy if exists "workspace_isolation" on app_org_chart.org_group_share_codes;
create policy "workspace_isolation" on app_org_chart.org_group_share_codes
for all using (
  workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
) with check (
  workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
);

-- ---------- HELPER ----------

create or replace function app_org_chart.user_can_see_org_group(p_group_id uuid)
returns boolean
language sql stable security definer set search_path = app_org_chart, public as $$
  select exists (
    select 1 from app_org_chart.org_groups g
    where g.id = p_group_id
      and g.deleted_at is null
      and (
        g.workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
        or exists (
          select 1 from app_org_chart.org_group_workspaces gw
          join public.workspace_members wm on wm.workspace_id = gw.workspace_id
          where gw.org_group_id = g.id and wm.user_id = auth.uid()
        )
      )
  );
$$;
grant execute on function app_org_chart.user_can_see_org_group(uuid) to authenticated;

-- ---------- RPC: create_org_group ----------
create or replace function app_org_chart.create_org_group(
  p_workspace_id uuid,
  p_name text,
  p_description text default null
)
returns app_org_chart.org_groups
language plpgsql security definer set search_path = app_org_chart, public as $$
declare
  v_user uuid := auth.uid();
  v_slug text;
  v_suffix text;
  v_row app_org_chart.org_groups;
begin
  if v_user is null then raise exception 'unauthenticated'; end if;
  if p_name is null or btrim(p_name) = '' then raise exception 'name_required'; end if;
  if p_workspace_id is null then raise exception 'workspace_required'; end if;

  if not exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace_id and user_id = v_user
  ) then raise exception 'not_member_of_workspace'; end if;

  v_slug := lower(regexp_replace(btrim(p_name), '[^a-zA-Z0-9]+', '-', 'g'));
  v_slug := substring(v_slug from 1 for 40);
  v_suffix := substring(md5(random()::text || clock_timestamp()::text) from 1 for 4);
  v_slug := v_slug || '-' || v_suffix;

  insert into app_org_chart.org_groups
    (workspace_id, name, slug, description, owner_user_id, created_by)
  values
    (p_workspace_id, btrim(p_name), v_slug, nullif(btrim(p_description), ''), v_user, v_user)
  returning * into v_row;

  insert into app_org_chart.org_group_workspaces
    (workspace_id, org_group_id, added_by, created_by)
  values (p_workspace_id, v_row.id, v_user, v_user);

  return v_row;
end $$;
grant execute on function app_org_chart.create_org_group(uuid, text, text) to authenticated;

-- ---------- RPC: generate_org_group_share_code ----------
create or replace function app_org_chart.generate_org_group_share_code(
  p_workspace_id uuid,
  p_group_id uuid,
  p_expires_hours int default 24
)
returns app_org_chart.org_group_share_codes
language plpgsql security definer set search_path = app_org_chart, public as $$
declare
  v_user uuid := auth.uid();
  v_code text;
  v_row app_org_chart.org_group_share_codes;
  v_attempts int := 0;
begin
  if v_user is null then raise exception 'unauthenticated'; end if;
  if not exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace_id and user_id = v_user
  ) then raise exception 'not_member_of_workspace'; end if;
  if not app_org_chart.user_can_see_org_group(p_group_id) then
    raise exception 'forbidden_not_member';
  end if;

  loop
    v_attempts := v_attempts + 1;
    v_code := lpad((floor(random() * 10000))::int::text, 4, '0');
    if not exists (
      select 1 from app_org_chart.org_group_share_codes
      where code = v_code and used_at is null
    ) then exit; end if;
    if v_attempts > 50 then raise exception 'no_free_code_found'; end if;
  end loop;

  insert into app_org_chart.org_group_share_codes
    (workspace_id, org_group_id, code, expires_at, created_by)
  values
    (p_workspace_id, p_group_id, v_code,
     case when p_expires_hours is null then null
          else now() + (p_expires_hours || ' hours')::interval end,
     v_user)
  returning * into v_row;

  return v_row;
end $$;
grant execute on function app_org_chart.generate_org_group_share_code(uuid, uuid, int) to authenticated;

-- ---------- RPC: redeem_org_group_share_code ----------
create or replace function app_org_chart.redeem_org_group_share_code(
  p_code text,
  p_target_ws_id uuid
)
returns app_org_chart.org_groups
language plpgsql security definer set search_path = app_org_chart, public as $$
declare
  v_user uuid := auth.uid();
  v_sc app_org_chart.org_group_share_codes;
  v_group app_org_chart.org_groups;
  v_role text;
begin
  if v_user is null then raise exception 'unauthenticated'; end if;
  if p_target_ws_id is null then raise exception 'target_ws_required'; end if;

  select role into v_role from public.workspace_members
  where workspace_id = p_target_ws_id and user_id = v_user;
  if v_role is null then raise exception 'not_member_of_target_ws'; end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'forbidden_only_ws_admin_can_subscribe';
  end if;

  select * into v_sc from app_org_chart.org_group_share_codes
  where code = p_code and used_at is null
    and (expires_at is null or expires_at > now())
  limit 1;
  if v_sc is null then raise exception 'INVALID_OR_EXPIRED_CODE'; end if;

  select * into v_group from app_org_chart.org_groups
  where id = v_sc.org_group_id and deleted_at is null;
  if v_group is null then raise exception 'group_deleted'; end if;

  insert into app_org_chart.org_group_workspaces
    (workspace_id, org_group_id, added_by, created_by)
  values (p_target_ws_id, v_group.id, v_user, v_user)
  on conflict (org_group_id, workspace_id) do nothing;

  update app_org_chart.org_group_share_codes
  set used_at = now(), used_by = v_user, used_workspace_id = p_target_ws_id
  where id = v_sc.id;

  return v_group;
end $$;
grant execute on function app_org_chart.redeem_org_group_share_code(text, uuid) to authenticated;

-- ---------- RPC: unshare_org_group_from_workspace ----------
create or replace function app_org_chart.unshare_org_group_from_workspace(
  p_group_id uuid,
  p_ws_id uuid
)
returns void
language plpgsql security definer set search_path = app_org_chart, public as $$
declare
  v_user uuid := auth.uid();
  v_role text;
  v_group app_org_chart.org_groups;
begin
  if v_user is null then raise exception 'unauthenticated'; end if;
  select role into v_role from public.workspace_members
  where workspace_id = p_ws_id and user_id = v_user;
  if v_role not in ('owner', 'admin') then
    raise exception 'forbidden_only_ws_admin_can_unshare';
  end if;

  select * into v_group from app_org_chart.org_groups
  where id = p_group_id and deleted_at is null;
  if v_group is null then return; end if;
  if v_group.workspace_id = p_ws_id then
    raise exception 'cannot_unshare_origin_workspace';
  end if;

  delete from app_org_chart.org_group_workspaces
  where org_group_id = p_group_id and workspace_id = p_ws_id;
end $$;
grant execute on function app_org_chart.unshare_org_group_from_workspace(uuid, uuid) to authenticated;

-- ---------- RPC: update_org_group (owner only) ----------
create or replace function app_org_chart.update_org_group(
  p_group_id uuid,
  p_name text default null,
  p_description text default null
)
returns app_org_chart.org_groups
language plpgsql security definer set search_path = app_org_chart, public as $$
declare
  v_user uuid := auth.uid();
  v_row app_org_chart.org_groups;
begin
  if v_user is null then raise exception 'unauthenticated'; end if;
  if not exists (
    select 1 from app_org_chart.org_groups
    where id = p_group_id and owner_user_id = v_user and deleted_at is null
  ) then raise exception 'forbidden_not_owner'; end if;

  update app_org_chart.org_groups set
    name = coalesce(nullif(btrim(p_name), ''), name),
    description = case when p_description is null then description
                       else nullif(btrim(p_description), '') end
  where id = p_group_id
  returning * into v_row;
  return v_row;
end $$;
grant execute on function app_org_chart.update_org_group(uuid, text, text) to authenticated;

-- ---------- RPC: delete_org_group_soft (owner only) ----------
create or replace function app_org_chart.delete_org_group_soft(
  p_group_id uuid,
  p_confirm_slug text
)
returns void
language plpgsql security definer set search_path = app_org_chart, public as $$
declare
  v_user uuid := auth.uid();
  v_group app_org_chart.org_groups;
begin
  if v_user is null then raise exception 'unauthenticated'; end if;
  select * into v_group from app_org_chart.org_groups
  where id = p_group_id and deleted_at is null;
  if v_group is null then return; end if;
  if v_group.owner_user_id <> v_user then raise exception 'forbidden_not_owner'; end if;
  if v_group.slug <> p_confirm_slug then raise exception 'slug_mismatch'; end if;

  update app_org_chart.org_groups set deleted_at = now() where id = p_group_id;
end $$;
grant execute on function app_org_chart.delete_org_group_soft(uuid, text) to authenticated;

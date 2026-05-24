-- =====================================================================
-- org-chart · 004 · org_groups — sync org chart cross-workspace
--
-- Pattern y lunch app's location_groups (mig 006-007). org_group là 1
-- "tổ chức" độc lập với workspace; nhiều ws có thể follow cùng 1 org_group
-- qua mã share 4 chữ số → cùng thấy data org chart.
--
-- Quy tắc (chốt 2026-05-24):
--   - Tạo org_group: bất kỳ user nào (sẽ là owner). Auto-share với
--     workspace caller chọn (initial_workspace_id).
--   - Share: gen mã 4 chữ số (24h expire mặc định) → ws khác nhập → ws đó
--     subscribe → user trong ws đó thấy data org_group.
--   - Visibility: passive — mọi user ở ws đã subscribe đều thấy.
--   - Owner ws KHÔNG thể unshare ws gốc (origin ws); chỉ ws non-origin
--     unshare được. Origin = workspace owner-org_group đã tạo lần đầu.
--   - Delete org_group: soft (deleted_at). Chỉ owner_user_id.
--
-- ⚠️ APPLY 2 LẦN:
--   1. Paste as-is (prod schema app_org_chart).
--   2. Replace mọi 'app_org_chart' → 'app_org_chart_dev' rồi paste lần 2.
-- =====================================================================

-- ---------- 1. org_groups ----------
create table if not exists app_org_chart.org_groups (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (char_length(name) between 1 and 80),
  slug            text not null,                  -- auto-gen từ name + suffix random
  description     text check (description is null or char_length(description) <= 500),
  owner_user_id   uuid not null references auth.users(id),
  -- origin ws: ws đầu tiên tạo group này. KHÔNG unshare được ws này.
  origin_workspace_id uuid references public.workspaces(id) on delete set null,
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
create unique index if not exists idx_og_slug_unique
  on app_org_chart.org_groups (slug) where deleted_at is null;
create index if not exists idx_og_owner on app_org_chart.org_groups (owner_user_id);

grant select, insert, update, delete on app_org_chart.org_groups to authenticated;
alter table app_org_chart.org_groups enable row level security;

-- ---------- 2. org_group_workspaces (m:n share) ----------
create table if not exists app_org_chart.org_group_workspaces (
  org_group_id  uuid not null references app_org_chart.org_groups(id) on delete cascade,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  added_by      uuid not null references auth.users(id),
  added_at      timestamptz not null default now(),
  primary key (org_group_id, workspace_id)
);
create index if not exists idx_ogw_ws on app_org_chart.org_group_workspaces (workspace_id);

grant select, insert, delete on app_org_chart.org_group_workspaces to authenticated;
alter table app_org_chart.org_group_workspaces enable row level security;

-- ---------- 3. org_group_share_codes (mã 4 số) ----------
create table if not exists app_org_chart.org_group_share_codes (
  id                uuid primary key default gen_random_uuid(),
  org_group_id      uuid not null references app_org_chart.org_groups(id) on delete cascade,
  code              text not null check (code ~ '^[0-9]{4}$'),
  created_by        uuid not null references auth.users(id),
  created_at        timestamptz not null default now(),
  expires_at        timestamptz,
  used_at           timestamptz,
  used_by           uuid references auth.users(id),
  used_workspace_id uuid references public.workspaces(id)
);
create unique index if not exists idx_og_sharecode_active
  on app_org_chart.org_group_share_codes (code) where used_at is null;
create index if not exists idx_og_sharecode_group
  on app_org_chart.org_group_share_codes (org_group_id);

grant select, insert, update on app_org_chart.org_group_share_codes to authenticated;
alter table app_org_chart.org_group_share_codes enable row level security;

-- ---------- 4. RLS ----------
-- org_groups: user thấy group nếu là member của ANY ws đã subscribe group đó
-- HOẶC là owner của group.
drop policy if exists "user_can_see_org_group" on app_org_chart.org_groups;
create policy "user_can_see_org_group" on app_org_chart.org_groups
for select using (
  owner_user_id = auth.uid()
  or id in (
    select org_group_id from app_org_chart.org_group_workspaces
    where workspace_id in (
      select workspace_id from public.workspace_members where user_id = auth.uid()
    )
  )
);
-- INSERT/UPDATE/DELETE: chặn trực tiếp, chỉ qua RPC SECURITY DEFINER.
drop policy if exists "og_no_direct_write" on app_org_chart.org_groups;
create policy "og_no_direct_write" on app_org_chart.org_groups
for all using (false) with check (false);

-- org_group_workspaces: user thấy nếu là member của ws trong row đó.
drop policy if exists "ogw_select_member" on app_org_chart.org_group_workspaces;
create policy "ogw_select_member" on app_org_chart.org_group_workspaces
for select using (
  workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
);

-- share_codes: user thấy code của group họ có thể thấy (owner ws đã share).
drop policy if exists "ogsc_select_visible" on app_org_chart.org_group_share_codes;
create policy "ogsc_select_visible" on app_org_chart.org_group_share_codes
for select using (
  org_group_id in (select id from app_org_chart.org_groups)  -- inherit từ org_groups select policy
);

-- ---------- 5. Helper: user có thể thấy org_group này không? ----------
create or replace function app_org_chart.user_can_see_org_group(p_group_id uuid)
returns boolean
language sql stable security definer set search_path = app_org_chart, public as $$
  select exists (
    select 1 from app_org_chart.org_groups g
    where g.id = p_group_id
      and g.deleted_at is null
      and (
        g.owner_user_id = auth.uid()
        or exists (
          select 1 from app_org_chart.org_group_workspaces gw
          join public.workspace_members wm on wm.workspace_id = gw.workspace_id
          where gw.org_group_id = g.id and wm.user_id = auth.uid()
        )
      )
  );
$$;
grant execute on function app_org_chart.user_can_see_org_group(uuid) to authenticated;

-- ---------- 6. RPC: create_org_group ----------
create or replace function app_org_chart.create_org_group(
  p_name text,
  p_description text default null,
  p_initial_workspace_id uuid default null   -- ws đầu tiên auto-share (= origin)
)
returns app_org_chart.org_groups
language plpgsql security definer set search_path = app_org_chart, public as $$
declare
  v_user uuid := auth.uid();
  v_slug text;
  v_suffix text;
  v_row app_org_chart.org_groups;
  v_ws uuid := p_initial_workspace_id;
begin
  if v_user is null then raise exception 'unauthenticated'; end if;
  if p_name is null or btrim(p_name) = '' then raise exception 'name_required'; end if;

  -- Slug: lowercase, dash, suffix random nếu trùng. Đơn giản hoá: lowercase
  -- chữ cái + số, replace space → dash, max 40 char, + suffix 4 hex.
  v_slug := lower(regexp_replace(btrim(p_name), '[^a-zA-Z0-9]+', '-', 'g'));
  v_slug := substring(v_slug from 1 for 40);
  v_suffix := substring(md5(random()::text || clock_timestamp()::text) from 1 for 4);
  v_slug := v_slug || '-' || v_suffix;

  -- Verify caller là member của ws (nếu truyền).
  if v_ws is not null then
    if not exists (
      select 1 from public.workspace_members
      where workspace_id = v_ws and user_id = v_user
    ) then raise exception 'not_member_of_initial_workspace'; end if;
  end if;

  insert into app_org_chart.org_groups
    (name, slug, description, owner_user_id, origin_workspace_id)
  values
    (btrim(p_name), v_slug, nullif(btrim(p_description), ''), v_user, v_ws)
  returning * into v_row;

  -- Auto-share với origin ws.
  if v_ws is not null then
    insert into app_org_chart.org_group_workspaces (org_group_id, workspace_id, added_by)
    values (v_row.id, v_ws, v_user);
  end if;

  return v_row;
end $$;
grant execute on function app_org_chart.create_org_group(text, text, uuid) to authenticated;

-- ---------- 7. RPC: generate_org_group_share_code ----------
-- Owner group HOẶC bất kỳ user trong ws đã share đều gen được mã.
create or replace function app_org_chart.generate_org_group_share_code(
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
  if not app_org_chart.user_can_see_org_group(p_group_id) then
    raise exception 'forbidden_not_member';
  end if;

  -- Gen 4 chữ số unique trong các code chưa used. Retry tối đa 50 lần
  -- (10000 combinations, collision rate thấp).
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
    (org_group_id, code, created_by, expires_at)
  values
    (p_group_id, v_code, v_user,
     case when p_expires_hours is null then null
          else now() + (p_expires_hours || ' hours')::interval end)
  returning * into v_row;

  return v_row;
end $$;
grant execute on function app_org_chart.generate_org_group_share_code(uuid, int) to authenticated;

-- ---------- 8. RPC: redeem_org_group_share_code ----------
-- Caller phải là owner/admin của target ws (chỉ admin mới share workspace data).
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

  -- Verify caller là owner/admin của target ws.
  select role into v_role from public.workspace_members
  where workspace_id = p_target_ws_id and user_id = v_user;
  if v_role is null then raise exception 'not_member_of_target_ws'; end if;
  if v_role not in ('owner', 'admin') then
    raise exception 'forbidden_only_ws_admin_can_subscribe';
  end if;

  -- Lookup code chưa expire + chưa used.
  select * into v_sc from app_org_chart.org_group_share_codes
  where code = p_code and used_at is null
    and (expires_at is null or expires_at > now())
  limit 1;
  if v_sc is null then raise exception 'INVALID_OR_EXPIRED_CODE'; end if;

  select * into v_group from app_org_chart.org_groups
  where id = v_sc.org_group_id and deleted_at is null;
  if v_group is null then raise exception 'group_deleted'; end if;

  -- Idempotent: nếu ws đã subscribe rồi → vẫn mark code used, không raise.
  insert into app_org_chart.org_group_workspaces (org_group_id, workspace_id, added_by)
  values (v_group.id, p_target_ws_id, v_user)
  on conflict (org_group_id, workspace_id) do nothing;

  update app_org_chart.org_group_share_codes
  set used_at = now(), used_by = v_user, used_workspace_id = p_target_ws_id
  where id = v_sc.id;

  return v_group;
end $$;
grant execute on function app_org_chart.redeem_org_group_share_code(text, uuid) to authenticated;

-- ---------- 9. RPC: unshare_org_group_from_workspace ----------
-- Caller phải là ws_admin. CHẶN unshare origin ws (ws gốc nơi tạo group).
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

  -- CHẶN unshare origin ws (origin = ws nơi tạo group lần đầu, mất origin
  -- nghĩa là không ai sửa data được nữa). User phải xoá hẳn group nếu muốn dừng.
  select * into v_group from app_org_chart.org_groups
  where id = p_group_id and deleted_at is null;
  if v_group is null then return; end if;
  if v_group.origin_workspace_id = p_ws_id then
    raise exception 'cannot_unshare_origin_workspace';
  end if;

  delete from app_org_chart.org_group_workspaces
  where org_group_id = p_group_id and workspace_id = p_ws_id;
end $$;
grant execute on function app_org_chart.unshare_org_group_from_workspace(uuid, uuid) to authenticated;

-- ---------- 10. RPC: update_org_group (owner only) ----------
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

-- ---------- 11. RPC: delete_org_group_soft (owner only) ----------
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

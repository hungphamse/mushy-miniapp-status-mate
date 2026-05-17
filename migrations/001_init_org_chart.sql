-- =====================================================================
-- org-chart · 001 · init (Sub-1)
--
-- Slug "org-chart" → schema "app_org_chart" (dash → underscore).
-- Schema + grants + default privileges đã được Admin Portal auto-tạo khi
-- register app. Migration chỉ lo tables / index / RLS / RPC.
--
-- Sub-1 scope: squads (cây) + positions (vai trò cấp workspace) +
-- squad_members + admin CRUD + gán lead. membership_requests (member tự
-- request) ở Sub-2 — KHÔNG nằm trong file này.
--
-- Mô hình quyền:
--   - SELECT: mọi member workspace (ai cũng xem được cây — M1).
--   - WRITE : KHÔNG grant trực tiếp cho authenticated → mọi mutation đi
--             qua RPC SECURITY DEFINER (tự check ws-admin / lead). RLS
--             policy "workspace_isolation" vẫn có (đúng convention +
--             chặn cross-workspace ở tầng SELECT).
--   - Helper core dùng lại: public.is_workspace_admin(ws),
--     public.is_workspace_member(ws) (000_core / mig 004).
--
-- ⚠️ Chỉ ref "app_org_chart" — Reviewer tự duplicate sang schema sandbox.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. squads — cây org chart
-- ---------------------------------------------------------------------
create table if not exists app_org_chart.squads (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  parent_id     uuid references app_org_chart.squads(id) on delete set null,
  slug          text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name          text not null check (char_length(name) between 1 and 80),
  intro         text check (intro is null or char_length(intro) <= 4000),
  lead_user_id  uuid references auth.users(id),
  status        text not null default 'active' check (status in ('active','archived')),
  created_by    uuid not null references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  archived_at   timestamptz,
  unique (workspace_id, slug)
);
create index if not exists idx_squads_ws        on app_org_chart.squads (workspace_id);
create index if not exists idx_squads_ws_parent on app_org_chart.squads (workspace_id, parent_id);

-- ---------------------------------------------------------------------
-- 2. positions — vai trò chức năng cấp workspace (admin CRUD)
--    "Other" KHÔNG là row — UI nhập tự do, lưu thẳng vào squad_members.position
-- ---------------------------------------------------------------------
create table if not exists app_org_chart.positions (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 40),
  is_system     boolean not null default false,
  sort_order    int not null default 0,
  created_by    uuid not null references auth.users(id),
  created_at    timestamptz not null default now(),
  unique (workspace_id, name)
);
create index if not exists idx_positions_ws on app_org_chart.positions (workspace_id);

-- ---------------------------------------------------------------------
-- 3. squad_members — thành viên + position + allocation
--    1 row active (left_at null) / user / squad. Không xoá row khi rời —
--    set left_at (movement = logs).
-- ---------------------------------------------------------------------
create table if not exists app_org_chart.squad_members (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  squad_id      uuid not null references app_org_chart.squads(id) on delete cascade,
  user_id       uuid not null references auth.users(id),
  kind          text not null default 'member' check (kind in ('lead','member')),
  position      text not null check (char_length(position) between 1 and 40),
  allocation    int  not null default 0 check (allocation between 0 and 100),
  joined_at     timestamptz not null default now(),
  left_at       timestamptz,
  created_by    uuid not null references auth.users(id),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_sm_ws       on app_org_chart.squad_members (workspace_id);
create index if not exists idx_sm_ws_squad on app_org_chart.squad_members (workspace_id, squad_id);
create unique index if not exists uq_sm_active
  on app_org_chart.squad_members (squad_id, user_id) where left_at is null;

-- ---------------------------------------------------------------------
-- 4. updated_at trigger
-- ---------------------------------------------------------------------
create or replace function app_org_chart.set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists trg_squads_updated_at on app_org_chart.squads;
create trigger trg_squads_updated_at before update on app_org_chart.squads
  for each row execute function app_org_chart.set_updated_at();

drop trigger if exists trg_sm_updated_at on app_org_chart.squad_members;
create trigger trg_sm_updated_at before update on app_org_chart.squad_members
  for each row execute function app_org_chart.set_updated_at();

-- ---------------------------------------------------------------------
-- 5. RLS — SELECT mở cho member workspace; WRITE chặn (chỉ RPC definer)
-- ---------------------------------------------------------------------
grant select on app_org_chart.squads        to authenticated;
grant select on app_org_chart.positions     to authenticated;
grant select on app_org_chart.squad_members to authenticated;

alter table app_org_chart.squads        enable row level security;
alter table app_org_chart.positions     enable row level security;
alter table app_org_chart.squad_members enable row level security;

drop policy if exists "workspace_isolation" on app_org_chart.squads;
create policy "workspace_isolation" on app_org_chart.squads
for all using (
  workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
) with check (
  workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
);

drop policy if exists "workspace_isolation" on app_org_chart.positions;
create policy "workspace_isolation" on app_org_chart.positions
for all using (
  workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
) with check (
  workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
);

drop policy if exists "workspace_isolation" on app_org_chart.squad_members;
create policy "workspace_isolation" on app_org_chart.squad_members
for all using (
  workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
) with check (
  workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
);

-- ---------------------------------------------------------------------
-- 6. RPC (SECURITY DEFINER) — tự check quyền bằng auth.uid()
--    search_path khoá vào app_org_chart, public (an toàn injection).
-- ---------------------------------------------------------------------

-- 6.1 Guard nội bộ — workspace admin?
create or replace function app_org_chart._require_ws_admin(p_ws uuid)
returns void language plpgsql security definer set search_path = app_org_chart, public as $$
begin
  if not public.is_workspace_admin(p_ws) then
    raise exception 'Chỉ admin/owner workspace mới được thao tác (org-chart)';
  end if;
end $$;

-- 6.2 Lazy seed positions mặc định (idempotent) — gọi khi admin mở tab Positions
create or replace function app_org_chart.seed_default_positions(p_ws uuid)
returns void language plpgsql security definer set search_path = app_org_chart, public as $$
declare v_names text[] := array['Product','Tech','Design','QC','Ops']; n text; i int := 0;
begin
  perform app_org_chart._require_ws_admin(p_ws);
  if exists (select 1 from app_org_chart.positions where workspace_id = p_ws) then
    return;
  end if;
  foreach n in array v_names loop
    insert into app_org_chart.positions (workspace_id, name, is_system, sort_order, created_by)
    values (p_ws, n, true, i, auth.uid())
    on conflict (workspace_id, name) do nothing;
    i := i + 1;
  end loop;
end $$;

-- 6.3 create / update / archive squad
create or replace function app_org_chart.create_squad(
  p_ws uuid, p_name text, p_slug text, p_parent uuid default null, p_intro text default null
) returns uuid language plpgsql security definer set search_path = app_org_chart, public as $$
declare v_id uuid;
begin
  perform app_org_chart._require_ws_admin(p_ws);
  if p_parent is not null and not exists (
    select 1 from app_org_chart.squads where id = p_parent and workspace_id = p_ws
  ) then raise exception 'parent squad không thuộc workspace này'; end if;
  insert into app_org_chart.squads (workspace_id, parent_id, slug, name, intro, created_by)
  values (p_ws, p_parent, lower(p_slug), p_name, nullif(btrim(p_intro),''), auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- update: admin = full; squad lead = chỉ intro
create or replace function app_org_chart.update_squad(
  p_id uuid, p_name text default null, p_intro text default null,
  p_parent uuid default null, p_status text default null
) returns void language plpgsql security definer set search_path = app_org_chart, public as $$
declare s record; v_is_admin boolean; v_is_lead boolean;
begin
  select * into s from app_org_chart.squads where id = p_id;
  if s is null then raise exception 'squad không tồn tại'; end if;
  v_is_admin := public.is_workspace_admin(s.workspace_id);
  v_is_lead  := (s.lead_user_id = auth.uid());
  if not (v_is_admin or v_is_lead) then
    raise exception 'Chỉ admin workspace hoặc squad lead mới sửa được';
  end if;
  if v_is_admin then
    if p_parent is not null and p_parent = p_id then
      raise exception 'squad không thể là parent của chính nó';
    end if;
    update app_org_chart.squads set
      name      = coalesce(nullif(btrim(p_name),''), name),
      intro     = case when p_intro is null then intro else nullif(btrim(p_intro),'') end,
      parent_id = case when p_parent is null then parent_id else p_parent end,
      status    = coalesce(p_status, status),
      archived_at = case when p_status = 'archived' then now()
                         when p_status = 'active'   then null
                         else archived_at end
    where id = p_id;
  else
    -- lead: chỉ intro
    update app_org_chart.squads
      set intro = case when p_intro is null then intro else nullif(btrim(p_intro),'') end
    where id = p_id;
  end if;
end $$;

-- 6.4 gán squad lead (admin only). Lead cũ → kind='member' giữ allocation
--     (quyết định đã chốt). Lead mới: upsert row active kind='lead'.
create or replace function app_org_chart.assign_squad_lead(
  p_squad uuid, p_user uuid, p_position text default 'Lead'
) returns void language plpgsql security definer set search_path = app_org_chart, public as $$
declare s record;
begin
  select * into s from app_org_chart.squads where id = p_squad;
  if s is null then raise exception 'squad không tồn tại'; end if;
  perform app_org_chart._require_ws_admin(s.workspace_id);

  -- demote mọi lead row active của squad → member (giữ allocation/position)
  update app_org_chart.squad_members
     set kind = 'member'
   where squad_id = p_squad and kind = 'lead' and left_at is null
     and user_id <> p_user;

  -- upsert target thành lead (active)
  if exists (
    select 1 from app_org_chart.squad_members
    where squad_id = p_squad and user_id = p_user and left_at is null
  ) then
    update app_org_chart.squad_members
       set kind = 'lead'
     where squad_id = p_squad and user_id = p_user and left_at is null;
  else
    insert into app_org_chart.squad_members
      (workspace_id, squad_id, user_id, kind, position, allocation, created_by)
    values (s.workspace_id, p_squad, p_user, 'lead',
            coalesce(nullif(btrim(p_position),''),'Lead'), 0, auth.uid());
  end if;

  update app_org_chart.squads set lead_user_id = p_user where id = p_squad;
end $$;

-- 6.5 positions create / delete (admin only)
create or replace function app_org_chart.create_position(p_ws uuid, p_name text)
returns uuid language plpgsql security definer set search_path = app_org_chart, public as $$
declare v_id uuid;
begin
  perform app_org_chart._require_ws_admin(p_ws);
  insert into app_org_chart.positions (workspace_id, name, created_by,
    sort_order)
  values (p_ws, btrim(p_name), auth.uid(),
    coalesce((select max(sort_order)+1 from app_org_chart.positions where workspace_id = p_ws), 0))
  returning id into v_id;
  return v_id;
end $$;

create or replace function app_org_chart.delete_position(p_id uuid)
returns void language plpgsql security definer set search_path = app_org_chart, public as $$
declare p record;
begin
  select * into p from app_org_chart.positions where id = p_id;
  if p is null then return; end if;
  perform app_org_chart._require_ws_admin(p.workspace_id);
  -- KHÔNG cascade vào squad_members.position (đó là text, lịch sử giữ nguyên)
  delete from app_org_chart.positions where id = p_id;
end $$;

-- 6.6 admin set/remove member (Sub-1 để có data demo; Sub-2 thêm self-request)
create or replace function app_org_chart.admin_set_member(
  p_squad uuid, p_user uuid, p_position text, p_allocation int, p_kind text default 'member'
) returns void language plpgsql security definer set search_path = app_org_chart, public as $$
declare s record;
begin
  select * into s from app_org_chart.squads where id = p_squad;
  if s is null then raise exception 'squad không tồn tại'; end if;
  perform app_org_chart._require_ws_admin(s.workspace_id);
  if p_kind not in ('lead','member') then raise exception 'kind không hợp lệ'; end if;
  if not exists (
    select 1 from public.workspace_members
    where workspace_id = s.workspace_id and user_id = p_user
  ) then raise exception 'user không phải member của workspace'; end if;

  if exists (
    select 1 from app_org_chart.squad_members
    where squad_id = p_squad and user_id = p_user and left_at is null
  ) then
    update app_org_chart.squad_members
       set position = btrim(p_position), allocation = p_allocation, kind = p_kind
     where squad_id = p_squad and user_id = p_user and left_at is null;
  else
    insert into app_org_chart.squad_members
      (workspace_id, squad_id, user_id, kind, position, allocation, created_by)
    values (s.workspace_id, p_squad, p_user, p_kind, btrim(p_position),
            p_allocation, auth.uid());
  end if;
end $$;

create or replace function app_org_chart.remove_member(p_squad uuid, p_user uuid)
returns void language plpgsql security definer set search_path = app_org_chart, public as $$
declare s record;
begin
  select * into s from app_org_chart.squads where id = p_squad;
  if s is null then return; end if;
  if not (public.is_workspace_admin(s.workspace_id) or s.lead_user_id = auth.uid()) then
    raise exception 'Chỉ admin workspace hoặc squad lead mới gỡ được member';
  end if;
  update app_org_chart.squad_members
     set left_at = now()
   where squad_id = p_squad and user_id = p_user and left_at is null;
  if s.lead_user_id = p_user then
    update app_org_chart.squads set lead_user_id = null where id = p_squad;
  end if;
end $$;

-- 6.7 member tự chỉnh allocation + position của mình (M4)
create or replace function app_org_chart.set_my_allocation(
  p_squad uuid, p_allocation int, p_position text
) returns void language plpgsql security definer set search_path = app_org_chart, public as $$
begin
  if p_allocation < 0 or p_allocation > 100 then
    raise exception 'allocation phải trong 0..100';
  end if;
  update app_org_chart.squad_members
     set allocation = p_allocation, position = btrim(p_position)
   where squad_id = p_squad and user_id = auth.uid() and left_at is null;
  if not found then raise exception 'Bạn không phải member active của squad này'; end if;
end $$;

-- ---------------------------------------------------------------------
-- 7. GRANT EXECUTE cho authenticated (RPC tự check quyền bên trong)
-- ---------------------------------------------------------------------
grant execute on function app_org_chart.seed_default_positions(uuid)               to authenticated;
grant execute on function app_org_chart.create_squad(uuid,text,text,uuid,text)     to authenticated;
grant execute on function app_org_chart.update_squad(uuid,text,text,uuid,text)     to authenticated;
grant execute on function app_org_chart.assign_squad_lead(uuid,uuid,text)          to authenticated;
grant execute on function app_org_chart.create_position(uuid,text)                 to authenticated;
grant execute on function app_org_chart.delete_position(uuid)                      to authenticated;
grant execute on function app_org_chart.admin_set_member(uuid,uuid,text,int,text)  to authenticated;
grant execute on function app_org_chart.remove_member(uuid,uuid)                   to authenticated;
grant execute on function app_org_chart.set_my_allocation(uuid,int,text)           to authenticated;

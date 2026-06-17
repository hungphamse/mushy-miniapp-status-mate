-- =====================================================================
-- org-chart · 007 · Rewrite RPCs sang group-scoped
--
-- Sau mig 006 backfill, mọi data row đã có org_group_id. Mig 007 rewrite
-- toàn bộ RPCs từ workspace-scoped → group-scoped:
--   - Permission check: is_org_group_editor (admin/owner ws subscribed)
--     thay is_workspace_admin(p_ws).
--   - INSERT statements populate workspace_id từ group.workspace_id
--     (origin) — col vẫn NOT NULL theo convention nhưng logic dùng group.
--   - Param p_ws → p_group_id ở mọi RPC create/seed.
--
-- BREAKING: code app PR3 phải deploy đồng bộ — gọi RPC với p_group_id
-- thay p_ws. Trước PR3, RPC cũ KHÔNG còn tồn tại (drop trong mig này).
--
-- RPCs rewrite:
--   helpers: is_org_group_editor, is_org_group_member, _require_group_editor
--   data:    seed_default_positions, create_squad, update_squad,
--            assign_squad_lead, create_position, delete_position,
--            admin_set_member, remove_member, set_my_allocation
--   requests: request_membership, decide_membership, cancel_my_request (no change)
-- =====================================================================

-- ---------- HELPERS ----------

-- User là admin/owner của ANY ws đã subscribe group? (editor permission)
create or replace function app_status_mate.is_org_group_editor(p_group_id uuid)
returns boolean
language sql stable security definer set search_path = app_status_mate as $$
  select exists (
    select 1
    from app_status_mate.org_group_workspaces gw
    join public.workspace_members wm
      on wm.workspace_id = gw.workspace_id
    where gw.org_group_id = p_group_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin')
  );
$$;
grant execute on function app_status_mate.is_org_group_editor(uuid) to authenticated;

-- User là member của ANY ws đã subscribe group? (basic visibility)
create or replace function app_status_mate.is_org_group_member(p_group_id uuid)
returns boolean
language sql stable security definer set search_path = app_status_mate as $$
  select exists (
    select 1
    from app_status_mate.org_group_workspaces gw
    join public.workspace_members wm
      on wm.workspace_id = gw.workspace_id
    where gw.org_group_id = p_group_id
      and wm.user_id = auth.uid()
  );
$$;
grant execute on function app_status_mate.is_org_group_member(uuid) to authenticated;

-- Guard nội bộ.
create or replace function app_status_mate._require_group_editor(p_group_id uuid)
returns void language plpgsql security definer set search_path = app_status_mate as $$
begin
  if not app_status_mate.is_org_group_editor(p_group_id) then
    raise exception 'Chỉ admin/owner workspace đã subscribe org_group mới được thao tác';
  end if;
end $$;

-- Lookup origin workspace_id của group (dùng cho INSERT workspace_id NOT NULL).
create or replace function app_status_mate._group_origin_ws(p_group_id uuid)
returns uuid
language sql stable security definer set search_path = app_status_mate as $$
  select workspace_id from app_status_mate.org_groups where id = p_group_id;
$$;

-- ---------- DROP RPCs cũ ----------
-- Cần drop trước khi create or replace vì signature đổi (param khác).

drop function if exists app_status_mate.seed_default_positions(uuid);
drop function if exists app_status_mate.create_squad(uuid, text, text, uuid, text);
drop function if exists app_status_mate.update_squad(uuid, text, text, uuid, text);
drop function if exists app_status_mate.assign_squad_lead(uuid, uuid, text);
drop function if exists app_status_mate.create_position(uuid, text);
drop function if exists app_status_mate.delete_position(uuid);
drop function if exists app_status_mate.admin_set_member(uuid, uuid, text, int, text);
drop function if exists app_status_mate.remove_member(uuid, uuid);
drop function if exists app_status_mate.set_my_allocation(uuid, int, text);
drop function if exists app_status_mate.request_membership(uuid, text, text, int, text);
drop function if exists app_status_mate.decide_membership(uuid, boolean);
drop function if exists app_status_mate.cancel_my_request(uuid);
drop function if exists app_status_mate._require_ws_admin(uuid);

-- ---------- seed_default_positions ----------
create or replace function app_status_mate.seed_default_positions(p_group_id uuid)
returns void language plpgsql security definer set search_path = app_status_mate as $$
declare
  v_names text[] := array['Product','Tech','Design','QC','Ops'];
  n text; i int := 0;
  v_ws uuid;
begin
  perform app_status_mate._require_group_editor(p_group_id);
  v_ws := app_status_mate._group_origin_ws(p_group_id);
  if exists (select 1 from app_status_mate.positions where org_group_id = p_group_id) then
    return;
  end if;
  foreach n in array v_names loop
    insert into app_status_mate.positions
      (workspace_id, org_group_id, name, is_system, sort_order, created_by)
    values (v_ws, p_group_id, n, true, i, auth.uid())
    on conflict do nothing;
    i := i + 1;
  end loop;
end $$;
grant execute on function app_status_mate.seed_default_positions(uuid) to authenticated;

-- ---------- create_squad ----------
create or replace function app_status_mate.create_squad(
  p_group_id uuid, p_name text, p_slug text,
  p_parent uuid default null, p_intro text default null
) returns uuid
language plpgsql security definer set search_path = app_status_mate as $$
declare v_id uuid; v_ws uuid;
begin
  perform app_status_mate._require_group_editor(p_group_id);
  v_ws := app_status_mate._group_origin_ws(p_group_id);
  if p_parent is not null and not exists (
    select 1 from app_status_mate.squads where id = p_parent and org_group_id = p_group_id
  ) then raise exception 'parent squad không thuộc org_group này'; end if;
  insert into app_status_mate.squads
    (workspace_id, org_group_id, parent_id, slug, name, intro, created_by)
  values (v_ws, p_group_id, p_parent, lower(p_slug), p_name,
          nullif(btrim(p_intro), ''), auth.uid())
  returning id into v_id;
  return v_id;
end $$;
grant execute on function app_status_mate.create_squad(uuid, text, text, uuid, text) to authenticated;

-- ---------- update_squad ----------
create or replace function app_status_mate.update_squad(
  p_id uuid, p_name text default null, p_intro text default null,
  p_parent uuid default null, p_status text default null
) returns void
language plpgsql security definer set search_path = app_status_mate as $$
declare s record; v_is_editor boolean; v_is_lead boolean;
begin
  select * into s from app_status_mate.squads where id = p_id;
  if s is null then raise exception 'squad không tồn tại'; end if;
  v_is_editor := app_status_mate.is_org_group_editor(s.org_group_id);
  v_is_lead := (s.lead_user_id = auth.uid());
  if not (v_is_editor or v_is_lead) then
    raise exception 'Chỉ admin workspace subscribed hoặc squad lead mới sửa được';
  end if;
  if v_is_editor then
    if p_parent is not null and p_parent = p_id then
      raise exception 'squad không thể là parent của chính nó';
    end if;
    if p_parent is not null and not exists (
      select 1 from app_status_mate.squads where id = p_parent and org_group_id = s.org_group_id
    ) then raise exception 'parent squad không thuộc cùng org_group'; end if;
    update app_status_mate.squads set
      name = coalesce(nullif(btrim(p_name), ''), name),
      intro = case when p_intro is null then intro else nullif(btrim(p_intro), '') end,
      parent_id = case when p_parent is null then parent_id else p_parent end,
      status = coalesce(p_status, status),
      archived_at = case when p_status = 'archived' then now()
                         when p_status = 'active' then null
                         else archived_at end
    where id = p_id;
  else
    update app_status_mate.squads
      set intro = case when p_intro is null then intro else nullif(btrim(p_intro), '') end
    where id = p_id;
  end if;
end $$;
grant execute on function app_status_mate.update_squad(uuid, text, text, uuid, text) to authenticated;

-- ---------- assign_squad_lead ----------
create or replace function app_status_mate.assign_squad_lead(
  p_squad uuid, p_user uuid, p_position text default 'Lead'
) returns void
language plpgsql security definer set search_path = app_status_mate as $$
declare s record; v_ws uuid;
begin
  select * into s from app_status_mate.squads where id = p_squad;
  if s is null then raise exception 'squad không tồn tại'; end if;
  perform app_status_mate._require_group_editor(s.org_group_id);
  v_ws := app_status_mate._group_origin_ws(s.org_group_id);

  -- Verify p_user là member của ANY ws đã subscribe group.
  if not exists (
    select 1 from app_status_mate.org_group_workspaces gw
    join public.workspace_members wm on wm.workspace_id = gw.workspace_id
    where gw.org_group_id = s.org_group_id and wm.user_id = p_user
  ) then raise exception 'user không phải member của ws nào đã subscribe org_group'; end if;

  update app_status_mate.squad_members
    set kind = 'member'
  where squad_id = p_squad and kind = 'lead' and left_at is null
    and user_id <> p_user;

  if exists (
    select 1 from app_status_mate.squad_members
    where squad_id = p_squad and user_id = p_user and left_at is null
  ) then
    update app_status_mate.squad_members
      set kind = 'lead'
    where squad_id = p_squad and user_id = p_user and left_at is null;
  else
    insert into app_status_mate.squad_members
      (workspace_id, org_group_id, squad_id, user_id, kind, position, allocation, created_by)
    values (v_ws, s.org_group_id, p_squad, p_user, 'lead',
            coalesce(nullif(btrim(p_position), ''), 'Lead'), 0, auth.uid());
  end if;

  update app_status_mate.squads set lead_user_id = p_user where id = p_squad;
end $$;
grant execute on function app_status_mate.assign_squad_lead(uuid, uuid, text) to authenticated;

-- ---------- create_position ----------
create or replace function app_status_mate.create_position(p_group_id uuid, p_name text)
returns uuid
language plpgsql security definer set search_path = app_status_mate as $$
declare v_id uuid; v_ws uuid;
begin
  perform app_status_mate._require_group_editor(p_group_id);
  v_ws := app_status_mate._group_origin_ws(p_group_id);
  insert into app_status_mate.positions
    (workspace_id, org_group_id, name, created_by, sort_order)
  values (v_ws, p_group_id, btrim(p_name), auth.uid(),
    coalesce((select max(sort_order) + 1 from app_status_mate.positions where org_group_id = p_group_id), 0))
  returning id into v_id;
  return v_id;
end $$;
grant execute on function app_status_mate.create_position(uuid, text) to authenticated;

-- ---------- delete_position ----------
create or replace function app_status_mate.delete_position(p_id uuid)
returns void
language plpgsql security definer set search_path = app_status_mate as $$
declare p record;
begin
  select * into p from app_status_mate.positions where id = p_id;
  if p is null then return; end if;
  perform app_status_mate._require_group_editor(p.org_group_id);
  delete from app_status_mate.positions where id = p_id;
end $$;
grant execute on function app_status_mate.delete_position(uuid) to authenticated;

-- ---------- admin_set_member ----------
create or replace function app_status_mate.admin_set_member(
  p_squad uuid, p_user uuid, p_position text, p_allocation int, p_kind text default 'member'
) returns void
language plpgsql security definer set search_path = app_status_mate as $$
declare s record; v_ws uuid;
begin
  select * into s from app_status_mate.squads where id = p_squad;
  if s is null then raise exception 'squad không tồn tại'; end if;
  perform app_status_mate._require_group_editor(s.org_group_id);
  v_ws := app_status_mate._group_origin_ws(s.org_group_id);

  if p_kind not in ('lead', 'member') then raise exception 'kind không hợp lệ'; end if;

  if not exists (
    select 1 from app_status_mate.org_group_workspaces gw
    join public.workspace_members wm on wm.workspace_id = gw.workspace_id
    where gw.org_group_id = s.org_group_id and wm.user_id = p_user
  ) then raise exception 'user không phải member của ws nào đã subscribe org_group'; end if;

  if exists (
    select 1 from app_status_mate.squad_members
    where squad_id = p_squad and user_id = p_user and left_at is null
  ) then
    update app_status_mate.squad_members
      set position = btrim(p_position), allocation = p_allocation, kind = p_kind
    where squad_id = p_squad and user_id = p_user and left_at is null;
  else
    insert into app_status_mate.squad_members
      (workspace_id, org_group_id, squad_id, user_id, kind, position, allocation, created_by)
    values (v_ws, s.org_group_id, p_squad, p_user, p_kind, btrim(p_position),
            p_allocation, auth.uid());
  end if;
end $$;
grant execute on function app_status_mate.admin_set_member(uuid, uuid, text, int, text) to authenticated;

-- ---------- remove_member ----------
create or replace function app_status_mate.remove_member(p_squad uuid, p_user uuid)
returns void
language plpgsql security definer set search_path = app_status_mate as $$
declare s record;
begin
  select * into s from app_status_mate.squads where id = p_squad;
  if s is null then return; end if;
  if not (app_status_mate.is_org_group_editor(s.org_group_id) or s.lead_user_id = auth.uid()) then
    raise exception 'Chỉ admin workspace subscribed hoặc squad lead mới gỡ được';
  end if;
  update app_status_mate.squad_members
    set left_at = now()
  where squad_id = p_squad and user_id = p_user and left_at is null;
  if s.lead_user_id = p_user then
    update app_status_mate.squads set lead_user_id = null where id = p_squad;
  end if;
end $$;
grant execute on function app_status_mate.remove_member(uuid, uuid) to authenticated;

-- ---------- set_my_allocation (member tự edit) ----------
create or replace function app_status_mate.set_my_allocation(
  p_squad uuid, p_allocation int, p_position text
) returns void
language plpgsql security definer set search_path = app_status_mate as $$
begin
  if p_allocation < 0 or p_allocation > 100 then
    raise exception 'allocation phải trong 0..100';
  end if;
  update app_status_mate.squad_members
    set allocation = p_allocation, position = btrim(p_position)
  where squad_id = p_squad and user_id = auth.uid() and left_at is null;
  if not found then raise exception 'Bạn không phải member active của squad này'; end if;
end $$;
grant execute on function app_status_mate.set_my_allocation(uuid, int, text) to authenticated;

-- ---------- request_membership (member self-request) ----------
create or replace function app_status_mate.request_membership(
  p_squad uuid, p_type text, p_position text default null,
  p_allocation int default null, p_message text default null
) returns uuid
language plpgsql security definer set search_path = app_status_mate as $$
declare s record; v_active boolean; v_id uuid; v_ws uuid;
begin
  if p_type not in ('join', 'leave') then raise exception 'type không hợp lệ'; end if;
  select * into s from app_status_mate.squads where id = p_squad;
  if s is null then raise exception 'squad không tồn tại'; end if;
  if s.status <> 'active' then raise exception 'squad đã lưu trữ'; end if;
  if not app_status_mate.is_org_group_member(s.org_group_id) then
    raise exception 'Bạn không thuộc workspace nào subscribed org_group này';
  end if;

  v_ws := app_status_mate._group_origin_ws(s.org_group_id);

  select exists (
    select 1 from app_status_mate.squad_members
    where squad_id = p_squad and user_id = auth.uid() and left_at is null
  ) into v_active;

  if p_type = 'join' then
    if v_active then raise exception 'Bạn đã ở trong squad này rồi'; end if;
    if p_position is null or btrim(p_position) = '' then
      raise exception 'Chọn vai trò khi đăng ký vào';
    end if;
    if p_allocation is null or p_allocation < 0 or p_allocation > 100 then
      raise exception 'Allocation phải trong 0..100';
    end if;
  else
    if not v_active then raise exception 'Bạn không ở trong squad này'; end if;
  end if;

  if exists (
    select 1 from app_status_mate.membership_requests
    where squad_id = p_squad and user_id = auth.uid() and status = 'pending'
  ) then raise exception 'Bạn đã có yêu cầu đang chờ duyệt cho squad này'; end if;

  insert into app_status_mate.membership_requests
    (workspace_id, org_group_id, squad_id, user_id, type, req_position, req_allocation,
     message, created_by)
  values (v_ws, s.org_group_id, p_squad, auth.uid(), p_type,
          case when p_type = 'join' then btrim(p_position) end,
          case when p_type = 'join' then p_allocation end,
          nullif(btrim(p_message), ''), auth.uid())
  returning id into v_id;
  return v_id;
end $$;
grant execute on function app_status_mate.request_membership(uuid, text, text, int, text) to authenticated;

-- ---------- decide_membership (lead/editor duyệt) ----------
create or replace function app_status_mate.decide_membership(
  p_req uuid, p_approve boolean
) returns void
language plpgsql security definer set search_path = app_status_mate as $$
declare r record; s record; v_ws uuid;
begin
  select * into r from app_status_mate.membership_requests where id = p_req;
  if r is null then raise exception 'Yêu cầu không tồn tại'; end if;
  if r.status <> 'pending' then raise exception 'Yêu cầu đã được xử lý'; end if;

  select * into s from app_status_mate.squads where id = r.squad_id;
  if s is null then raise exception 'squad không tồn tại'; end if;
  if not (app_status_mate.is_org_group_editor(s.org_group_id) or s.lead_user_id = auth.uid()) then
    raise exception 'Chỉ squad lead hoặc admin ws subscribed mới duyệt được';
  end if;
  v_ws := app_status_mate._group_origin_ws(s.org_group_id);

  update app_status_mate.membership_requests
    set status = case when p_approve then 'approved' else 'rejected' end,
        decided_by = auth.uid(), decided_at = now()
  where id = p_req;

  if not p_approve then return; end if;

  if r.type = 'join' then
    if not exists (
      select 1 from app_status_mate.squad_members
      where squad_id = r.squad_id and user_id = r.user_id and left_at is null
    ) then
      insert into app_status_mate.squad_members
        (workspace_id, org_group_id, squad_id, user_id, kind, position, allocation, created_by)
      values (v_ws, s.org_group_id, r.squad_id, r.user_id, 'member',
              coalesce(r.req_position, 'Member'), coalesce(r.req_allocation, 0), auth.uid());
    end if;
  else
    update app_status_mate.squad_members
      set left_at = now()
    where squad_id = r.squad_id and user_id = r.user_id and left_at is null;
    if s.lead_user_id = r.user_id then
      update app_status_mate.squads set lead_user_id = null where id = r.squad_id;
    end if;
  end if;
end $$;
grant execute on function app_status_mate.decide_membership(uuid, boolean) to authenticated;

-- ---------- cancel_my_request (self cancel) ----------
create or replace function app_status_mate.cancel_my_request(p_req uuid)
returns void
language plpgsql security definer set search_path = app_status_mate as $$
begin
  update app_status_mate.membership_requests
    set status = 'cancelled', decided_at = now()
  where id = p_req and user_id = auth.uid() and status = 'pending';
  if not found then raise exception 'Không huỷ được (không phải của bạn hoặc đã xử lý)'; end if;
end $$;
grant execute on function app_status_mate.cancel_my_request(uuid) to authenticated;

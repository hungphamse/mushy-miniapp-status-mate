-- =====================================================================
-- org-chart · 002 · Sub-2 — member tự xin vào / xin rời squad
--
-- Sub-1: admin gán member trực tiếp. Sub-2: member tự request, SQUAD LEAD
-- (hoặc workspace admin) duyệt. Bảng membership_requests + RPC.
--
-- Quyền:
--   - request_membership : member workspace (tự xin cho chính mình)
--   - decide_membership  : squad lead (squads.lead_user_id) HOẶC ws admin
--   - cancel_my_request  : chính người xin (khi còn pending)
-- WRITE chặn trực tiếp (grant select-only) — chỉ RPC SECURITY DEFINER.
--
-- ⚠️ Chỉ ref "app_org_chart" — Reviewer tự duplicate sang schema sandbox.
-- =====================================================================

create table if not exists app_org_chart.membership_requests (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  squad_id       uuid not null references app_org_chart.squads(id) on delete cascade,
  user_id        uuid not null references auth.users(id),
  type           text not null check (type in ('join','leave')),
  req_position   text check (req_position is null or char_length(req_position) between 1 and 40),
  req_allocation int  check (req_allocation is null or req_allocation between 0 and 100),
  message        text check (message is null or char_length(message) <= 500),
  status         text not null default 'pending'
                   check (status in ('pending','approved','rejected','cancelled')),
  decided_by     uuid references auth.users(id),
  decided_at     timestamptz,
  created_by     uuid not null references auth.users(id),
  created_at     timestamptz not null default now()
);
create index if not exists idx_mr_ws        on app_org_chart.membership_requests (workspace_id);
create index if not exists idx_mr_ws_squad  on app_org_chart.membership_requests (workspace_id, squad_id);
create unique index if not exists uq_mr_pending
  on app_org_chart.membership_requests (squad_id, user_id) where status = 'pending';

grant select on app_org_chart.membership_requests to authenticated;
alter table app_org_chart.membership_requests enable row level security;

drop policy if exists "workspace_isolation" on app_org_chart.membership_requests;
create policy "workspace_isolation" on app_org_chart.membership_requests
for all using (
  workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
) with check (
  workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
);

-- ---------------------------------------------------------------------
-- RPC
-- ---------------------------------------------------------------------

-- Member tự xin vào / xin rời 1 squad (cho chính mình).
create or replace function app_org_chart.request_membership(
  p_squad uuid, p_type text, p_position text default null,
  p_allocation int default null, p_message text default null
) returns uuid language plpgsql security definer
set search_path = app_org_chart, public as $$
declare s record; v_active boolean; v_id uuid;
begin
  if p_type not in ('join','leave') then raise exception 'type không hợp lệ'; end if;
  select * into s from app_org_chart.squads where id = p_squad;
  if s is null then raise exception 'squad không tồn tại'; end if;
  if s.status <> 'active' then raise exception 'squad đã lưu trữ'; end if;
  if not public.is_workspace_member(s.workspace_id) then
    raise exception 'Bạn không thuộc workspace này';
  end if;

  select exists (
    select 1 from app_org_chart.squad_members
    where squad_id = p_squad and user_id = auth.uid() and left_at is null
  ) into v_active;

  if p_type = 'join' then
    if v_active then raise exception 'Bạn đã ở trong squad này rồi'; end if;
    if p_position is null or btrim(p_position) = '' then
      raise exception 'Chọn vai trò khi xin vào';
    end if;
    if p_allocation is null or p_allocation < 0 or p_allocation > 100 then
      raise exception 'Allocation phải trong 0..100';
    end if;
  else -- leave
    if not v_active then raise exception 'Bạn không ở trong squad này'; end if;
  end if;

  -- 1 pending / người / squad (uq_mr_pending). Có pending rồi → báo.
  if exists (
    select 1 from app_org_chart.membership_requests
    where squad_id = p_squad and user_id = auth.uid() and status = 'pending'
  ) then
    raise exception 'Bạn đã có yêu cầu đang chờ duyệt cho squad này';
  end if;

  insert into app_org_chart.membership_requests
    (workspace_id, squad_id, user_id, type, req_position, req_allocation,
     message, created_by)
  values (s.workspace_id, p_squad, auth.uid(), p_type,
          case when p_type='join' then btrim(p_position) end,
          case when p_type='join' then p_allocation end,
          nullif(btrim(p_message),''), auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Squad lead / ws admin duyệt. approve=true → áp dụng; false → reject.
create or replace function app_org_chart.decide_membership(
  p_req uuid, p_approve boolean
) returns void language plpgsql security definer
set search_path = app_org_chart, public as $$
declare r record; s record;
begin
  select * into r from app_org_chart.membership_requests where id = p_req;
  if r is null then raise exception 'Yêu cầu không tồn tại'; end if;
  if r.status <> 'pending' then raise exception 'Yêu cầu đã được xử lý'; end if;

  select * into s from app_org_chart.squads where id = r.squad_id;
  if s is null then raise exception 'squad không tồn tại'; end if;
  if not (public.is_workspace_admin(s.workspace_id) or s.lead_user_id = auth.uid()) then
    raise exception 'Chỉ squad lead hoặc admin workspace mới duyệt được';
  end if;

  update app_org_chart.membership_requests
     set status = case when p_approve then 'approved' else 'rejected' end,
         decided_by = auth.uid(), decided_at = now()
   where id = p_req;

  if not p_approve then return; end if;

  if r.type = 'join' then
    -- Idempotent với uq_sm_active: nếu đã active thì thôi.
    if not exists (
      select 1 from app_org_chart.squad_members
      where squad_id = r.squad_id and user_id = r.user_id and left_at is null
    ) then
      insert into app_org_chart.squad_members
        (workspace_id, squad_id, user_id, kind, position, allocation, created_by)
      values (r.workspace_id, r.squad_id, r.user_id, 'member',
              coalesce(r.req_position,'Member'), coalesce(r.req_allocation,0), auth.uid());
    end if;
  else -- leave
    update app_org_chart.squad_members
       set left_at = now()
     where squad_id = r.squad_id and user_id = r.user_id and left_at is null;
    -- Nếu là lead mà rời → gỡ lead_user_id
    if s.lead_user_id = r.user_id then
      update app_org_chart.squads set lead_user_id = null where id = r.squad_id;
    end if;
  end if;
end $$;

-- Người xin tự huỷ yêu cầu pending của mình.
create or replace function app_org_chart.cancel_my_request(p_req uuid)
returns void language plpgsql security definer
set search_path = app_org_chart, public as $$
begin
  update app_org_chart.membership_requests
     set status = 'cancelled', decided_at = now()
   where id = p_req and user_id = auth.uid() and status = 'pending';
  if not found then raise exception 'Không huỷ được (không phải của bạn hoặc đã xử lý)'; end if;
end $$;

grant execute on function app_org_chart.request_membership(uuid,text,text,int,text) to authenticated;
grant execute on function app_org_chart.decide_membership(uuid,boolean)             to authenticated;
grant execute on function app_org_chart.cancel_my_request(uuid)                     to authenticated;

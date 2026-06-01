-- =====================================================================
-- status-mate · 011 · Status-Mate (member_statuses)
--
-- Status per user per org_group. Default (no row) = Available.
-- Writes go through RPC SECURITY DEFINER; direct writes are blocked.
-- =====================================================================

-- @realtime
create table if not exists app_status_mate.member_statuses (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  org_group_id  uuid not null references app_status_mate.org_groups(id) on delete cascade,
  user_id       uuid not null references auth.users(id),
  status        text not null check (status in ('available','busy','focus')),
  message       text check (message is null or char_length(message) <= 200),
  status_until  timestamptz,
  created_by    uuid not null references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (org_group_id, user_id)
);
create index if not exists idx_ms_group on app_status_mate.member_statuses (org_group_id);
create index if not exists idx_ms_user on app_status_mate.member_statuses (user_id);
create index if not exists idx_ms_group_status on app_status_mate.member_statuses (org_group_id, status);

-- updated_at trigger
drop trigger if exists trg_member_statuses_updated_at on app_status_mate.member_statuses;
create trigger trg_member_statuses_updated_at before update on app_status_mate.member_statuses
  for each row execute function app_status_mate.set_updated_at();

-- RLS: workspace members or org_group followers can read
grant select on app_status_mate.member_statuses to authenticated;
alter table app_status_mate.member_statuses enable row level security;

drop policy if exists "org_group_isolation" on app_status_mate.member_statuses;
drop policy if exists "workspace_isolation" on app_status_mate.member_statuses;
create policy "workspace_isolation" on app_status_mate.member_statuses
for select using (
  workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
  or (
    org_group_id is not null
    and app_status_mate.user_can_see_org_group(org_group_id)
  )
);

-- RPC: set my status
create or replace function app_status_mate.set_my_status(
  p_group_id uuid,
  p_status text,
  p_message text default null,
  p_until timestamptz default null
) returns void
language plpgsql security definer set search_path = app_status_mate as $$
declare
  v_ws uuid;
  v_until timestamptz;
begin
  if not app_status_mate.is_org_group_member(p_group_id) then
    raise exception 'Bạn không thuộc org group này';
  end if;
  if p_status not in ('available','busy','focus') then
    raise exception 'Status không hợp lệ';
  end if;
  if p_message is not null and char_length(p_message) > 200 then
    raise exception 'Message quá dài (<= 200 ký tự)';
  end if;

  v_ws := app_status_mate._group_origin_ws(p_group_id);
  v_until := p_until;
  if v_until is not null and v_until <= now() then
    v_until := null;
  end if;

  insert into app_status_mate.member_statuses
    (workspace_id, org_group_id, user_id, status, message, status_until, created_by)
  values
    (v_ws, p_group_id, auth.uid(), p_status, nullif(btrim(p_message), ''), v_until, auth.uid())
  on conflict (org_group_id, user_id)
  do update set
    status = excluded.status,
    message = excluded.message,
    status_until = excluded.status_until,
    updated_at = now();
end $$;

grant execute on function app_status_mate.set_my_status(uuid, text, text, timestamptz) to authenticated;

-- RPC: clear my status
create or replace function app_status_mate.clear_my_status(p_group_id uuid)
returns void
language plpgsql security definer set search_path = app_status_mate as $$
begin
  if not app_status_mate.is_org_group_member(p_group_id) then
    raise exception 'Bạn không thuộc org group này';
  end if;
  delete from app_status_mate.member_statuses
    where org_group_id = p_group_id and user_id = auth.uid();
end $$;

grant execute on function app_status_mate.clear_my_status(uuid) to authenticated;

-- =====================================================================
-- status-mate · 013 · Meeting rooms and status lifecycle
--
-- Tables:
--   - meeting_rooms: room metadata and lifecycle state
--   - meeting_participants: room membership and whether a status override was applied
--   - status_event_log: audit trail for room actions and status changes
--
-- RPCs:
--   - create/start/end room
--   - add participants
--   - apply in_meeting to one member or the whole room
--   - restore the previous status snapshot when a room ends
--
-- This migration only defines schema and RPCs. The client UI can call them later.
-- Write only app_status_mate.* here; the Admin Portal applies this to the
-- production schema and mirrors it to the matching dev schema automatically.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Meeting rooms
-- ---------------------------------------------------------------------
create table if not exists app_status_mate.meeting_rooms (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  org_group_id      uuid not null references app_status_mate.org_groups(id) on delete cascade,
  title             text not null check (char_length(title) between 1 and 120),
  host_user_id      uuid not null references auth.users(id),
  status            text not null default 'scheduled'
                      check (status in ('scheduled', 'active', 'ended')),
  planned_end_at    timestamptz,
  started_at        timestamptz,
  ended_at          timestamptz,
  ended_by_user_id   uuid references auth.users(id),
  created_by        uuid not null references auth.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_mr_ws on app_status_mate.meeting_rooms (workspace_id);
create index if not exists idx_mr_group on app_status_mate.meeting_rooms (org_group_id);
create index if not exists idx_mr_host on app_status_mate.meeting_rooms (host_user_id);
create index if not exists idx_mr_status on app_status_mate.meeting_rooms (org_group_id, status);

drop trigger if exists trg_mr_updated_at on app_status_mate.meeting_rooms;
create trigger trg_mr_updated_at before update on app_status_mate.meeting_rooms
  for each row execute function app_status_mate.set_updated_at();

-- ---------------------------------------------------------------------
-- 2. Meeting participants
-- ---------------------------------------------------------------------
create table if not exists app_status_mate.meeting_participants (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references public.workspaces(id) on delete cascade,
  org_group_id          uuid not null references app_status_mate.org_groups(id) on delete cascade,
  room_id               uuid not null references app_status_mate.meeting_rooms(id) on delete cascade,
  user_id               uuid not null references auth.users(id),
  role                  text not null default 'member'
                           check (role in ('host', 'co_host', 'member')),
  joined_at             timestamptz not null default now(),
  left_at               timestamptz,
  meeting_status_applied boolean not null default false,
  created_by            uuid not null references auth.users(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (room_id, user_id)
);
create index if not exists idx_mp_ws on app_status_mate.meeting_participants (workspace_id);
create index if not exists idx_mp_group on app_status_mate.meeting_participants (org_group_id);
create index if not exists idx_mp_room on app_status_mate.meeting_participants (room_id);
create index if not exists idx_mp_room_active on app_status_mate.meeting_participants (room_id, left_at);
create index if not exists idx_mp_user on app_status_mate.meeting_participants (user_id);

drop trigger if exists trg_mp_updated_at on app_status_mate.meeting_participants;
create trigger trg_mp_updated_at before update on app_status_mate.meeting_participants
  for each row execute function app_status_mate.set_updated_at();

-- ---------------------------------------------------------------------
-- 3. Status event log
-- ---------------------------------------------------------------------
create table if not exists app_status_mate.status_event_log (
  event_id             uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references public.workspaces(id) on delete cascade,
  org_group_id          uuid not null references app_status_mate.org_groups(id) on delete cascade,
  room_id               uuid references app_status_mate.meeting_rooms(id) on delete set null,
  user_id               uuid not null references auth.users(id),
  action                text not null check (
                          action in (
                            'set_status',
                            'override_status',
                            'auto_reset',
                            'meeting_create',
                            'meeting_start',
                            'meeting_end',
                            'meeting_apply',
                            'meeting_restore'
                          )
                        ),
  from_status           text,
  to_status             text not null,
  triggered_by_user_id  uuid references auth.users(id),
  details               jsonb not null default '{}'::jsonb,
  created_by            uuid not null references auth.users(id),
  created_at            timestamptz not null default now()
);
create index if not exists idx_sel_ws_created
  on app_status_mate.status_event_log (workspace_id, created_at desc);
create index if not exists idx_sel_group_created
  on app_status_mate.status_event_log (org_group_id, created_at desc);
create index if not exists idx_sel_room_created
  on app_status_mate.status_event_log (room_id, created_at desc);
create index if not exists idx_sel_user_created
  on app_status_mate.status_event_log (user_id, created_at desc);

-- ---------------------------------------------------------------------
-- 4. Permissions + RLS
-- ---------------------------------------------------------------------
grant select, insert, update, delete on app_status_mate.meeting_rooms to authenticated;
grant select, insert, update, delete on app_status_mate.meeting_participants to authenticated;
grant select, insert, update, delete on app_status_mate.status_event_log to authenticated;

alter table app_status_mate.meeting_rooms enable row level security;
alter table app_status_mate.meeting_participants enable row level security;
alter table app_status_mate.status_event_log enable row level security;

drop policy if exists "workspace_isolation" on app_status_mate.meeting_rooms;
create policy "workspace_isolation" on app_status_mate.meeting_rooms
for all using (
  workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
  or app_status_mate.user_can_see_org_group(org_group_id)
) with check (
  workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
  or app_status_mate.user_can_see_org_group(org_group_id)
);

drop policy if exists "workspace_isolation" on app_status_mate.meeting_participants;
create policy "workspace_isolation" on app_status_mate.meeting_participants
for all using (
  workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
  or app_status_mate.user_can_see_org_group(org_group_id)
) with check (
  workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
  or app_status_mate.user_can_see_org_group(org_group_id)
);

drop policy if exists "workspace_isolation" on app_status_mate.status_event_log;
create policy "workspace_isolation" on app_status_mate.status_event_log
for all using (
  workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
  or app_status_mate.user_can_see_org_group(org_group_id)
) with check (
  workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
  or app_status_mate.user_can_see_org_group(org_group_id)
);

-- ---------------------------------------------------------------------
-- 5. Extend member_statuses for meeting linkage
-- ---------------------------------------------------------------------
alter table app_status_mate.member_statuses
  add column if not exists meeting_room_id uuid
    references app_status_mate.meeting_rooms(id) on delete set null;

create index if not exists idx_ms_meeting_room
  on app_status_mate.member_statuses (meeting_room_id);

-- ---------------------------------------------------------------------
-- 6. Internal helpers for snapshots and meeting overrides
-- ---------------------------------------------------------------------
create or replace function app_status_mate._append_status_event(
  p_workspace_id uuid,
  p_group_id uuid,
  p_room_id uuid,
  p_user_id uuid,
  p_action text,
  p_from_status text,
  p_to_status text,
  p_triggered_by_user_id uuid default null,
  p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = app_status_mate, public
as $$
begin
  insert into app_status_mate.status_event_log
    (workspace_id, org_group_id, room_id, user_id, action,
     from_status, to_status, triggered_by_user_id, details, created_by)
  values
    (p_workspace_id, p_group_id, p_room_id, p_user_id, p_action,
     p_from_status, p_to_status, p_triggered_by_user_id,
     coalesce(p_details, '{}'::jsonb), coalesce(auth.uid(), p_triggered_by_user_id, p_user_id));
end $$;

create or replace function app_status_mate._meeting_room_can_manage(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = app_status_mate, public
as $$
  select exists (
    select 1
    from app_status_mate.meeting_rooms r
    where r.id = p_room_id
      and (
        r.host_user_id = auth.uid()
        or public.is_workspace_admin(r.workspace_id)
        or exists (
          select 1
          from app_status_mate.meeting_participants mp
          where mp.room_id = r.id
            and mp.user_id = auth.uid()
            and mp.role = 'co_host'
            and mp.left_at is null
        )
      )
  );
$$;
grant execute on function app_status_mate._meeting_room_can_manage(uuid) to authenticated;

create or replace function app_status_mate._meeting_participant_role(
  p_room_id uuid,
  p_user_id uuid
)
returns text
language sql
stable
security definer
set search_path = app_status_mate, public
as $$
  select case
    when exists (
      select 1 from app_status_mate.meeting_rooms r
      where r.id = p_room_id and r.host_user_id = p_user_id
    ) then 'host'
    when exists (
      select 1 from app_status_mate.meeting_participants mp
      where mp.room_id = p_room_id
        and mp.user_id = p_user_id
        and mp.role = 'co_host'
        and mp.left_at is null
    ) then 'co_host'
    else 'member'
  end;
$$;
grant execute on function app_status_mate._meeting_participant_role(uuid, uuid) to authenticated;

create or replace function app_status_mate._user_can_see_org_group_for_user(
  p_group_id uuid,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = app_status_mate, public
as $$
  select exists (
    select 1
    from app_status_mate.org_groups g
    where g.id = p_group_id
      and g.deleted_at is null
      and (
        g.workspace_id in (
          select workspace_id
          from public.workspace_members
          where user_id = p_user_id
        )
        or exists (
          select 1
          from app_status_mate.org_group_workspaces gw
          join public.workspace_members wm on wm.workspace_id = gw.workspace_id
          where gw.org_group_id = g.id
            and wm.user_id = p_user_id
        )
      )
  );
$$;
grant execute on function app_status_mate._user_can_see_org_group_for_user(uuid, uuid) to authenticated;

create or replace function app_status_mate._member_status_snapshot(
  p_group_id uuid,
  p_user_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = app_status_mate, public
as $$
  select case
    when ms.id is null then null
    else jsonb_build_object(
      'status', ms.status,
      'message', ms.message,
      'status_until', ms.status_until,
      'reason', ms.reason,
      'source', ms.source,
      'set_by_user_id', ms.set_by_user_id,
      'custom_reason_text', ms.custom_reason_text,
      'meeting_room_id', ms.meeting_room_id,
      'previous_status', ms.previous_status,
      'updated_at', ms.updated_at
    )
  end
  from app_status_mate.member_statuses ms
  where ms.org_group_id = p_group_id
    and ms.user_id = p_user_id
  limit 1;
$$;
grant execute on function app_status_mate._member_status_snapshot(uuid, uuid) to authenticated;

create or replace function app_status_mate._restore_member_status_snapshot(
  p_group_id uuid,
  p_user_id uuid,
  p_snapshot jsonb
)
returns void
language plpgsql
security definer
set search_path = app_status_mate, public
as $$
begin
  if p_snapshot is null then
    delete from app_status_mate.member_statuses
    where org_group_id = p_group_id
      and user_id = p_user_id;
    return;
  end if;

  insert into app_status_mate.member_statuses
    (
      workspace_id, org_group_id, user_id,
      status, message, status_until,
      reason, source, set_by_user_id, custom_reason_text,
      previous_status, meeting_room_id,
      created_by
    )
  values
    (
      (select workspace_id from app_status_mate.org_groups where id = p_group_id),
      p_group_id,
      p_user_id,
      coalesce(p_snapshot->>'status', 'available'),
      nullif(p_snapshot->>'message', ''),
      nullif(p_snapshot->>'status_until', '')::timestamptz,
      nullif(p_snapshot->>'reason', ''),
      coalesce(nullif(p_snapshot->>'source', ''), 'self'),
      nullif(p_snapshot->>'set_by_user_id', '')::uuid,
      nullif(p_snapshot->>'custom_reason_text', ''),
      p_snapshot->'previous_status',
      nullif(p_snapshot->>'meeting_room_id', '')::uuid,
      coalesce(auth.uid(), p_user_id)
    )
  on conflict (org_group_id, user_id)
  do update set
    status             = excluded.status,
    message            = excluded.message,
    status_until       = excluded.status_until,
    reason             = excluded.reason,
    source             = excluded.source,
    set_by_user_id     = excluded.set_by_user_id,
    custom_reason_text = excluded.custom_reason_text,
    previous_status    = null,
    meeting_room_id    = excluded.meeting_room_id,
    updated_at         = now();
end $$;
grant execute on function app_status_mate._restore_member_status_snapshot(uuid, uuid, jsonb) to authenticated;

create or replace function app_status_mate._apply_meeting_status(
  p_room_id uuid,
  p_user_id uuid,
  p_status text,
  p_message text,
  p_until timestamptz,
  p_source text,
  p_action text
)
returns void
language plpgsql
security definer
set search_path = app_status_mate, public
as $$
declare
  v_room record;
  v_current record;
  v_snapshot jsonb;
  v_reason text := 'meeting_room';
  v_final_until timestamptz;
begin
  select * into v_room
  from app_status_mate.meeting_rooms
  where id = p_room_id;
  if v_room is null then
    raise exception 'meeting room không tồn tại';
  end if;
  if not app_status_mate._meeting_room_can_manage(p_room_id) then
    raise exception 'Bạn không có quyền thao tác meeting room này';
  end if;
  if v_room.status <> 'active' then
    raise exception 'meeting room chưa active';
  end if;
  if not app_status_mate._user_can_see_org_group_for_user(v_room.org_group_id, p_user_id) then
    raise exception 'user không thuộc org group này';
  end if;
  if p_status <> 'in_meeting' then
    raise exception 'Host chỉ được set in_meeting';
  end if;
  if p_source not in ('host', 'meeting_sync') then
    raise exception 'source không hợp lệ';
  end if;

  v_final_until := coalesce(p_until, v_room.planned_end_at);
  if v_final_until is null then
    raise exception 'Host-set phải có thời hạn';
  end if;

  select * into v_current
  from app_status_mate.member_statuses
  where org_group_id = v_room.org_group_id
    and user_id = p_user_id;

  if v_current.id is not null then
    if v_current.source in ('host', 'meeting_sync') and v_current.previous_status is not null then
      v_snapshot := v_current.previous_status;
    else
      v_snapshot := app_status_mate._member_status_snapshot(v_room.org_group_id, p_user_id);
    end if;
  end if;

  insert into app_status_mate.member_statuses
    (
      workspace_id, org_group_id, user_id,
      status, message, status_until,
      reason, source, set_by_user_id, custom_reason_text,
      previous_status, meeting_room_id,
      created_by
    )
  values
    (
      v_room.workspace_id,
      v_room.org_group_id,
      p_user_id,
      p_status,
      nullif(btrim(coalesce(p_message, '')), ''),
      v_final_until,
      v_reason,
      p_source,
      auth.uid(),
      null,
      v_snapshot,
      p_room_id,
      auth.uid()
    )
  on conflict (org_group_id, user_id)
  do update set
    status             = excluded.status,
    message            = excluded.message,
    status_until       = excluded.status_until,
    reason             = excluded.reason,
    source             = excluded.source,
    set_by_user_id     = excluded.set_by_user_id,
    custom_reason_text = excluded.custom_reason_text,
    previous_status    = coalesce(app_status_mate.member_statuses.previous_status, excluded.previous_status),
    meeting_room_id    = excluded.meeting_room_id,
    updated_at         = now();

  insert into app_status_mate.meeting_participants
    (
      workspace_id, org_group_id, room_id, user_id, role,
      joined_at, left_at, meeting_status_applied, created_by
    )
  values
    (
      v_room.workspace_id,
      v_room.org_group_id,
      p_room_id,
      p_user_id,
      app_status_mate._meeting_participant_role(p_room_id, p_user_id),
      coalesce((select joined_at from app_status_mate.meeting_participants
                where room_id = p_room_id and user_id = p_user_id), now()),
      null,
      true,
      auth.uid()
    )
  on conflict (room_id, user_id)
  do update set
    role                  = excluded.role,
    left_at               = null,
    meeting_status_applied = true,
    updated_at            = now();

  perform app_status_mate._append_status_event(
    v_room.workspace_id,
    v_room.org_group_id,
    p_room_id,
    p_user_id,
    p_action,
    coalesce(v_current.status, 'available'),
    p_status,
    auth.uid(),
    jsonb_build_object(
      'source', p_source,
      'reason', v_reason,
      'until', v_final_until
    )
  );
end $$;
grant execute on function app_status_mate._apply_meeting_status(uuid, uuid, text, text, timestamptz, text, text) to authenticated;

create or replace function app_status_mate._restore_meeting_participant(
  p_room_id uuid,
  p_user_id uuid,
  p_action text default 'meeting_restore'
)
returns void
language plpgsql
security definer
set search_path = app_status_mate, public
as $$
declare
  v_room record;
  v_current record;
  v_snapshot jsonb;
begin
  select * into v_room
  from app_status_mate.meeting_rooms
  where id = p_room_id;
  if v_room is null then
    raise exception 'meeting room không tồn tại';
  end if;

  if not app_status_mate._meeting_room_can_manage(p_room_id) then
    raise exception 'Bạn không có quyền thao tác meeting room này';
  end if;

  select * into v_current
  from app_status_mate.member_statuses
  where org_group_id = v_room.org_group_id
    and user_id = p_user_id;

  if v_current.id is null then
    return;
  end if;

  if v_current.source not in ('host', 'meeting_sync') then
    return;
  end if;

  v_snapshot := v_current.previous_status;

  if v_snapshot is null then
    delete from app_status_mate.member_statuses
    where org_group_id = v_room.org_group_id
      and user_id = p_user_id
      and source in ('host', 'meeting_sync');
  else
    perform app_status_mate._restore_member_status_snapshot(
      v_room.org_group_id,
      p_user_id,
      v_snapshot
    );
  end if;

  update app_status_mate.meeting_participants
     set meeting_status_applied = false,
         updated_at = now()
   where room_id = p_room_id
     and user_id = p_user_id;

  perform app_status_mate._append_status_event(
    v_room.workspace_id,
    v_room.org_group_id,
    p_room_id,
    p_user_id,
    p_action,
    v_current.status,
    coalesce((v_snapshot->>'status'), 'available'),
    auth.uid(),
    jsonb_build_object(
      'source', v_current.source
    )
  );
end $$;
grant execute on function app_status_mate._restore_meeting_participant(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 7. Public RPCs for the room lifecycle
-- ---------------------------------------------------------------------
create or replace function app_status_mate.create_meeting_room(
  p_group_id uuid,
  p_title text,
  p_planned_end_at timestamptz default null,
  p_co_host_user_ids uuid[] default '{}'::uuid[]
)
returns app_status_mate.meeting_rooms
language plpgsql
security definer
set search_path = app_status_mate, public
as $$
declare
  v_room app_status_mate.meeting_rooms;
  v_ws uuid;
  v_user uuid := auth.uid();
  v_cohost uuid;
begin
  if v_user is null then
    raise exception 'unauthenticated';
  end if;
  if not app_status_mate.user_can_see_org_group(p_group_id) then
    raise exception 'Bạn không thuộc org group này';
  end if;
  if p_title is null or btrim(p_title) = '' then
    raise exception 'title_required';
  end if;

  v_ws := app_status_mate._group_origin_ws(p_group_id);

  insert into app_status_mate.meeting_rooms
    (workspace_id, org_group_id, title, host_user_id, status, planned_end_at, created_by)
  values
    (v_ws, p_group_id, btrim(p_title), v_user, 'scheduled', p_planned_end_at, v_user)
  returning * into v_room;

  insert into app_status_mate.meeting_participants
    (workspace_id, org_group_id, room_id, user_id, role, created_by)
  values
    (v_ws, p_group_id, v_room.id, v_user, 'host', v_user)
  on conflict (room_id, user_id) do update set
    role = 'host',
    left_at = null,
    meeting_status_applied = false,
    updated_at = now();

  foreach v_cohost in array coalesce(p_co_host_user_ids, '{}'::uuid[]) loop
    if v_cohost is null or v_cohost = v_user then
      continue;
    end if;
    if not app_status_mate._user_can_see_org_group_for_user(p_group_id, v_cohost) then
      raise exception 'co_host không thuộc org group này';
    end if;
    insert into app_status_mate.meeting_participants
      (workspace_id, org_group_id, room_id, user_id, role, created_by)
    values
      (v_ws, p_group_id, v_room.id, v_cohost, 'co_host', v_user)
    on conflict (room_id, user_id) do update set
      role = 'co_host',
      left_at = null,
      meeting_status_applied = false,
      updated_at = now();
  end loop;

  perform app_status_mate._append_status_event(
    v_ws,
    p_group_id,
    v_room.id,
    v_user,
    'meeting_create',
    null,
    'scheduled',
    v_user,
    jsonb_build_object(
      'title', btrim(p_title),
      'planned_end_at', p_planned_end_at
    )
  );

  return v_room;
end $$;
grant execute on function app_status_mate.create_meeting_room(uuid, text, timestamptz, uuid[]) to authenticated;

create or replace function app_status_mate.add_meeting_participants(
  p_room_id uuid,
  p_user_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = app_status_mate, public
as $$
declare
  v_room record;
  v_user uuid;
begin
  select * into v_room
  from app_status_mate.meeting_rooms
  where id = p_room_id;
  if v_room is null then
    raise exception 'meeting room không tồn tại';
  end if;
  if not app_status_mate._meeting_room_can_manage(p_room_id) then
    raise exception 'Bạn không có quyền thao tác meeting room này';
  end if;
  if p_user_ids is null then
    return;
  end if;

  foreach v_user in array p_user_ids loop
    if v_user is null or not app_status_mate._user_can_see_org_group_for_user(v_room.org_group_id, v_user) then
      continue;
    end if;
    insert into app_status_mate.meeting_participants
      (workspace_id, org_group_id, room_id, user_id, role, created_by)
    values
      (v_room.workspace_id, v_room.org_group_id, p_room_id, v_user,
       app_status_mate._meeting_participant_role(p_room_id, v_user), auth.uid())
    on conflict (room_id, user_id) do update set
      role = excluded.role,
      left_at = null,
      meeting_status_applied = false,
      updated_at = now();
  end loop;
end $$;
grant execute on function app_status_mate.add_meeting_participants(uuid, uuid[]) to authenticated;

create or replace function app_status_mate.start_meeting_room(
  p_room_id uuid
)
returns void
language plpgsql
security definer
set search_path = app_status_mate, public
as $$
declare
  v_room record;
begin
  select * into v_room
  from app_status_mate.meeting_rooms
  where id = p_room_id;
  if v_room is null then
    raise exception 'meeting room không tồn tại';
  end if;
  if not app_status_mate._meeting_room_can_manage(p_room_id) then
    raise exception 'Bạn không có quyền thao tác meeting room này';
  end if;

  update app_status_mate.meeting_rooms
     set status = 'active',
         started_at = coalesce(started_at, now()),
         ended_at = null,
         ended_by_user_id = null
   where id = p_room_id;

  perform app_status_mate._append_status_event(
    v_room.workspace_id,
    v_room.org_group_id,
    p_room_id,
    v_room.host_user_id,
    'meeting_start',
    null,
    'active',
    auth.uid(),
    '{}'::jsonb
  );
end $$;
grant execute on function app_status_mate.start_meeting_room(uuid) to authenticated;

create or replace function app_status_mate.set_status_for_member(
  p_room_id uuid,
  p_user_id uuid,
  p_status text default 'in_meeting',
  p_message text default null,
  p_until timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = app_status_mate, public
as $$
begin
  perform app_status_mate._apply_meeting_status(
    p_room_id,
    p_user_id,
    p_status,
    p_message,
    p_until,
    'host',
    'meeting_apply'
  );
end $$;
grant execute on function app_status_mate.set_status_for_member(uuid, uuid, text, text, timestamptz) to authenticated;

create or replace function app_status_mate.apply_meeting_mode(
  p_room_id uuid,
  p_user_ids uuid[] default null,
  p_until timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = app_status_mate, public
as $$
declare
  v_room record;
  v_user uuid;
begin
  select * into v_room
  from app_status_mate.meeting_rooms
  where id = p_room_id;
  if v_room is null then
    raise exception 'meeting room không tồn tại';
  end if;
  if not app_status_mate._meeting_room_can_manage(p_room_id) then
    raise exception 'Bạn không có quyền thao tác meeting room này';
  end if;
  if v_room.status <> 'active' then
    raise exception 'meeting room chưa active';
  end if;

  if p_user_ids is null then
    for v_user in
      select mp.user_id
      from app_status_mate.meeting_participants mp
      where mp.room_id = p_room_id
        and mp.left_at is null
    loop
      perform app_status_mate._apply_meeting_status(
        p_room_id,
        v_user,
        'in_meeting',
        null,
        p_until,
        'meeting_sync',
        'meeting_apply'
      );
    end loop;
  else
    foreach v_user in array p_user_ids loop
      if v_user is null then
        continue;
      end if;
      perform app_status_mate._apply_meeting_status(
        p_room_id,
        v_user,
        'in_meeting',
        null,
        p_until,
        'meeting_sync',
        'meeting_apply'
      );
    end loop;
  end if;
end $$;
grant execute on function app_status_mate.apply_meeting_mode(uuid, uuid[], timestamptz) to authenticated;

create or replace function app_status_mate.restore_meeting_status_for_room(
  p_room_id uuid,
  p_user_ids uuid[] default null
)
returns void
language plpgsql
security definer
set search_path = app_status_mate, public
as $$
declare
  v_room record;
  v_user uuid;
begin
  select * into v_room
  from app_status_mate.meeting_rooms
  where id = p_room_id;
  if v_room is null then
    raise exception 'meeting room không tồn tại';
  end if;
  if not app_status_mate._meeting_room_can_manage(p_room_id) then
    raise exception 'Bạn không có quyền thao tác meeting room này';
  end if;

  if p_user_ids is null then
    for v_user in
      select mp.user_id
      from app_status_mate.meeting_participants mp
      where mp.room_id = p_room_id
        and mp.left_at is null
    loop
      perform app_status_mate._restore_meeting_participant(p_room_id, v_user);
    end loop;
  else
    foreach v_user in array p_user_ids loop
      if v_user is null then
        continue;
      end if;
      perform app_status_mate._restore_meeting_participant(p_room_id, v_user);
    end loop;
  end if;
end $$;
grant execute on function app_status_mate.restore_meeting_status_for_room(uuid, uuid[]) to authenticated;

create or replace function app_status_mate.end_meeting_room(
  p_room_id uuid,
  p_restore boolean default true
)
returns void
language plpgsql
security definer
set search_path = app_status_mate, public
as $$
declare
  v_room record;
begin
  select * into v_room
  from app_status_mate.meeting_rooms
  where id = p_room_id;
  if v_room is null then
    raise exception 'meeting room không tồn tại';
  end if;
  if not app_status_mate._meeting_room_can_manage(p_room_id) then
    raise exception 'Bạn không có quyền thao tác meeting room này';
  end if;

  update app_status_mate.meeting_rooms
     set status = 'ended',
         ended_at = now(),
         ended_by_user_id = auth.uid()
   where id = p_room_id;

  perform app_status_mate._append_status_event(
    v_room.workspace_id,
    v_room.org_group_id,
    p_room_id,
    v_room.host_user_id,
    'meeting_end',
    null,
    'ended',
    auth.uid(),
    jsonb_build_object('restore', p_restore)
  );

  if p_restore then
    perform app_status_mate.restore_meeting_status_for_room(p_room_id);
  end if;
end $$;
grant execute on function app_status_mate.end_meeting_room(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- 8. Keep self-set status RPCs compatible with meeting overrides
-- ---------------------------------------------------------------------
create or replace function app_status_mate.set_my_status(
  p_group_id            uuid,
  p_status              text,
  p_message             text         default null,
  p_until               timestamptz  default null,
  p_reason              text         default null,
  p_custom_reason_text  text         default null
)
returns void
language plpgsql
security definer
set search_path = app_status_mate
as $$
declare
  v_ws     uuid;
  v_until  timestamptz;
  v_reason text;
  v_custom text;
  v_prev   record;
  v_action text;
begin
  if not app_status_mate.is_org_group_member(p_group_id) then
    raise exception 'Bạn không thuộc org group này';
  end if;

  if p_status not in ('available','busy','focus','in_meeting','do_not_disturb') then
    raise exception 'Status không hợp lệ: %', p_status;
  end if;

  if p_message is not null and char_length(p_message) > 200 then
    raise exception 'Message quá dài (tối đa 200 ký tự)';
  end if;

  select * into v_prev
  from app_status_mate.member_statuses
  where org_group_id = p_group_id
    and user_id = auth.uid();

  v_ws := app_status_mate._group_origin_ws(p_group_id);

  v_until := p_until;
  if v_until is not null and v_until <= now() then
    v_until := null;
  end if;

  v_reason := p_reason;
  if v_reason is null then
    case p_status
      when 'available'      then v_reason := null;
      when 'focus'          then v_reason := 'manual_focus';
      when 'busy'           then v_reason := 'manual_busy';
      when 'in_meeting'     then v_reason := 'meeting_room';
      when 'do_not_disturb' then v_reason := 'manual_focus';
      else                       v_reason := null;
    end case;
  end if;

  if v_reason is not null
    and v_reason not in ('manual_focus','manual_busy','meeting_room','deadline','break','custom')
  then
    raise exception 'Reason không hợp lệ: %', v_reason;
  end if;

  v_custom := null;
  if v_reason = 'custom' then
    v_custom := nullif(btrim(coalesce(p_custom_reason_text, '')), '');
    if v_custom is not null and char_length(v_custom) > 60 then
      raise exception 'Custom reason quá dài (tối đa 60 ký tự)';
    end if;
  end if;

  if v_prev.id is not null and v_prev.source in ('host', 'meeting_sync') then
    v_action := 'override_status';
  else
    v_action := 'set_status';
  end if;

  insert into app_status_mate.member_statuses
    (workspace_id, org_group_id, user_id,
     status, message, status_until,
     reason, source, set_by_user_id, custom_reason_text,
     previous_status, meeting_room_id,
     created_by)
  values
    (v_ws, p_group_id, auth.uid(),
     p_status,
     nullif(btrim(coalesce(p_message, '')), ''),
     v_until,
     v_reason, 'self', auth.uid(), v_custom,
     null, null,
     auth.uid())
  on conflict (org_group_id, user_id)
  do update set
    status             = excluded.status,
    message            = excluded.message,
    status_until       = excluded.status_until,
    reason             = excluded.reason,
    source             = 'self',
    set_by_user_id     = auth.uid(),
    custom_reason_text = excluded.custom_reason_text,
    previous_status    = null,
    meeting_room_id    = null,
    updated_at         = now();

  perform app_status_mate._append_status_event(
    v_ws,
    p_group_id,
    null,
    auth.uid(),
    v_action,
    coalesce(v_prev.status, 'available'),
    p_status,
    auth.uid(),
    jsonb_build_object(
      'reason', v_reason,
      'until', v_until
    )
  );
end $$;
grant execute on function app_status_mate.set_my_status(uuid, text, text, timestamptz, text, text) to authenticated;

create or replace function app_status_mate.clear_my_status(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = app_status_mate
as $$
declare
  v_prev record;
  v_ws uuid;
begin
  if not app_status_mate.is_org_group_member(p_group_id) then
    raise exception 'Bạn không thuộc org group này';
  end if;

  select * into v_prev
  from app_status_mate.member_statuses
  where org_group_id = p_group_id
    and user_id = auth.uid();

  if v_prev.id is null then
    return;
  end if;

  v_ws := app_status_mate._group_origin_ws(p_group_id);

  delete from app_status_mate.member_statuses
    where org_group_id = p_group_id and user_id = auth.uid();

  perform app_status_mate._append_status_event(
    v_ws,
    p_group_id,
    null,
    auth.uid(),
    case when v_prev.source in ('host', 'meeting_sync') then 'override_status' else 'auto_reset' end,
    v_prev.status,
    'available',
    auth.uid(),
    jsonb_build_object(
      'source', v_prev.source
    )
  );
end $$;
grant execute on function app_status_mate.clear_my_status(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 9. Index for member-status queries with room linkage
-- ---------------------------------------------------------------------
create index if not exists idx_ms_group_user_meeting
  on app_status_mate.member_statuses (org_group_id, user_id, meeting_room_id);

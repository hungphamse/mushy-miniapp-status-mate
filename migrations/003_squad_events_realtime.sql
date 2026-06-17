-- =====================================================================
-- org-chart · 003 · Sub-3 — squad_events (movement = logs) + realtime
--
-- "Khuyến khích movement thì có logs" (sếp Huy). Mọi thay đổi cấu trúc
-- (tạo/sửa/lưu-trữ squad, gán lead, join/leave, đổi allocation, request
-- ra/vào duyệt…) → 1 row append-only squad_events. Dùng TRIGGER (bắt mọi
-- mutation, kể cả tương lai) thay vì sửa lại từng RPC.
--
-- Realtime: marker @realtime → Reviewer tự append publication + replica
-- identity full. Client subscribe squad_events (filter workspace_id) →
-- mọi thay đổi đẩy event → org chart tự reload (không cần bấm ↻).
--
-- ⚠️ Chỉ ref "app_status_mate" — Reviewer tự duplicate sang schema sandbox.
-- =====================================================================

-- @realtime
create table if not exists app_status_mate.squad_events (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  squad_id      uuid not null references app_status_mate.squads(id) on delete cascade,
  actor_id      uuid references auth.users(id),   -- người gây ra (auth.uid())
  subject_id    uuid references auth.users(id),   -- người bị tác động
  type          text not null,                    -- xem danh sách dưới
  payload       jsonb not null default '{}',
  created_by    uuid not null references auth.users(id),
  created_at    timestamptz not null default now()
);
create index if not exists idx_se_ws_created
  on app_status_mate.squad_events (workspace_id, created_at desc);
create index if not exists idx_se_squad
  on app_status_mate.squad_events (workspace_id, squad_id);

grant select on app_status_mate.squad_events to authenticated;
alter table app_status_mate.squad_events enable row level security;

drop policy if exists "workspace_isolation" on app_status_mate.squad_events;
create policy "workspace_isolation" on app_status_mate.squad_events
for all using (
  workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
) with check (
  workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
);

-- ---------------------------------------------------------------------
-- Helper insert (security definer — trigger chạy như owner, bypass RLS).
-- ---------------------------------------------------------------------
create or replace function app_status_mate._ev(
  p_ws uuid, p_squad uuid, p_subject uuid, p_type text, p_payload jsonb
) returns void language plpgsql security definer
set search_path = app_status_mate, public as $$
begin
  insert into app_status_mate.squad_events
    (workspace_id, squad_id, actor_id, subject_id, type, payload, created_by)
  values (p_ws, p_squad, auth.uid(), p_subject, p_type,
          coalesce(p_payload, '{}'::jsonb), coalesce(auth.uid(), p_subject));
end $$;

-- ---------------------------------------------------------------------
-- Trigger: squads
-- ---------------------------------------------------------------------
create or replace function app_status_mate._trg_squads()
returns trigger language plpgsql security definer
set search_path = app_status_mate, public as $$
begin
  if TG_OP = 'INSERT' then
    perform app_status_mate._ev(NEW.workspace_id, NEW.id, null,
      'squad_created', jsonb_build_object('name', NEW.name, 'slug', NEW.slug));
    return NEW;
  end if;
  -- UPDATE — phát nhiều event nếu nhiều thứ đổi
  if NEW.status is distinct from OLD.status then
    perform app_status_mate._ev(NEW.workspace_id, NEW.id, null,
      case when NEW.status = 'archived' then 'squad_archived' else 'squad_restored' end,
      '{}'::jsonb);
  end if;
  if NEW.lead_user_id is distinct from OLD.lead_user_id then
    perform app_status_mate._ev(NEW.workspace_id, NEW.id, NEW.lead_user_id,
      'lead_changed', jsonb_build_object('lead_user_id', NEW.lead_user_id));
  end if;
  if NEW.intro is distinct from OLD.intro then
    perform app_status_mate._ev(NEW.workspace_id, NEW.id, null, 'intro_updated', '{}'::jsonb);
  end if;
  if NEW.name is distinct from OLD.name then
    perform app_status_mate._ev(NEW.workspace_id, NEW.id, null,
      'squad_renamed', jsonb_build_object('name', NEW.name));
  end if;
  return NEW;
end $$;

drop trigger if exists trg_ev_squads on app_status_mate.squads;
create trigger trg_ev_squads
  after insert or update on app_status_mate.squads
  for each row execute function app_status_mate._trg_squads();

-- ---------------------------------------------------------------------
-- Trigger: squad_members
-- ---------------------------------------------------------------------
create or replace function app_status_mate._trg_members()
returns trigger language plpgsql security definer
set search_path = app_status_mate, public as $$
begin
  if TG_OP = 'INSERT' then
    perform app_status_mate._ev(NEW.workspace_id, NEW.squad_id, NEW.user_id,
      case when NEW.kind = 'lead' then 'lead_assigned' else 'member_joined' end,
      jsonb_build_object('position', NEW.position, 'allocation', NEW.allocation,
                         'kind', NEW.kind));
    return NEW;
  end if;
  -- UPDATE
  if OLD.left_at is null and NEW.left_at is not null then
    perform app_status_mate._ev(NEW.workspace_id, NEW.squad_id, NEW.user_id,
      'member_left', '{}'::jsonb);
  elsif NEW.kind is distinct from OLD.kind then
    perform app_status_mate._ev(NEW.workspace_id, NEW.squad_id, NEW.user_id,
      'role_changed', jsonb_build_object('from', OLD.kind, 'to', NEW.kind));
  elsif NEW.allocation is distinct from OLD.allocation
     or NEW.position is distinct from OLD.position then
    perform app_status_mate._ev(NEW.workspace_id, NEW.squad_id, NEW.user_id,
      'allocation_changed',
      jsonb_build_object('position', NEW.position, 'allocation', NEW.allocation,
                         'old_allocation', OLD.allocation));
  end if;
  return NEW;
end $$;

drop trigger if exists trg_ev_members on app_status_mate.squad_members;
create trigger trg_ev_members
  after insert or update on app_status_mate.squad_members
  for each row execute function app_status_mate._trg_members();

-- ---------------------------------------------------------------------
-- Trigger: membership_requests (mig 002)
-- ---------------------------------------------------------------------
create or replace function app_status_mate._trg_requests()
returns trigger language plpgsql security definer
set search_path = app_status_mate, public as $$
begin
  if TG_OP = 'INSERT' then
    perform app_status_mate._ev(NEW.workspace_id, NEW.squad_id, NEW.user_id,
      'request_created',
      jsonb_build_object('req_type', NEW.type, 'position', NEW.req_position,
                         'allocation', NEW.req_allocation));
    return NEW;
  end if;
  if OLD.status = 'pending' and NEW.status is distinct from OLD.status then
    perform app_status_mate._ev(NEW.workspace_id, NEW.squad_id, NEW.user_id,
      'request_' || NEW.status,             -- request_approved/rejected/cancelled
      jsonb_build_object('req_type', NEW.type));
  end if;
  return NEW;
end $$;

drop trigger if exists trg_ev_requests on app_status_mate.membership_requests;
create trigger trg_ev_requests
  after insert or update on app_status_mate.membership_requests
  for each row execute function app_status_mate._trg_requests();

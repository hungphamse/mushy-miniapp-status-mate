-- =====================================================================
-- org-chart · 006 · Backfill data hiện tại sang org_groups model
--
-- Mỗi ws đang có data (≥1 squad / position / squad_member) → tạo 1
-- org_group với workspace_id = ws đó (origin). Sau đó populate
-- org_group_id ở tất cả 5 data tables.
--
-- Idempotent — chạy lại an toàn:
--   - Bước 1: chỉ tạo org_group cho ws CHƯA có org_group nào (check
--     workspace_id NOT IN existing org_groups.workspace_id).
--   - Bước 2: chỉ update rows có org_group_id IS NULL.
--   - Bước 3: chỉ insert org_group_workspaces khi chưa có (ON CONFLICT).
--
-- Sau mig 006, mọi row hiện tại có org_group_id NOT NULL. Mig 007 sẽ
-- rewrite RPCs sang group-scoped (breaking — code app PR3 deploy đồng bộ).
-- =====================================================================

-- ---------- 1. Tạo org_group cho mỗi ws có data ----------
-- Detect "ws có data" = ws đã tiến hành init (positions seeded hoặc có squad).
-- Skip ws đã có org_group với workspace_id = chính ws đó (đã backfill lần trước).

insert into app_status_mate.org_groups
  (workspace_id, name, slug, description, owner_user_id, created_by)
select
  w.id as workspace_id,
  w.name as name,
  -- slug: ws.slug + suffix random (tránh trung với org_group tạo sau).
  -- 4 hex từ md5(ws.id) — deterministic per ws, idempotent re-run.
  lower(regexp_replace(w.slug, '[^a-zA-Z0-9]+', '-', 'g'))
    || '-' || substring(md5(w.id::text) for 4) as slug,
  'Auto-migrated từ workspace data (mig 006)' as description,
  -- owner: workspace.created_by (nếu còn tồn tại), fallback user đầu tiên có squad
  -- trong ws. Nếu cả 2 thiếu → bỏ qua ws này (không tạo group).
  coalesce(
    w.created_by,
    (select created_by from app_status_mate.squads where workspace_id = w.id limit 1)
  ) as owner_user_id,
  coalesce(
    w.created_by,
    (select created_by from app_status_mate.squads where workspace_id = w.id limit 1)
  ) as created_by
from public.workspaces w
where w.deleted_at is null
  and (
    exists (select 1 from app_status_mate.squads where workspace_id = w.id)
    or exists (select 1 from app_status_mate.positions where workspace_id = w.id)
    or exists (select 1 from app_status_mate.squad_members where workspace_id = w.id)
  )
  -- Skip ws đã có org_group origin = w.id (idempotent).
  and not exists (
    select 1 from app_status_mate.org_groups where workspace_id = w.id
  )
  -- Skip ws không có owner (không xác định được).
  and coalesce(
    w.created_by,
    (select created_by from app_status_mate.squads where workspace_id = w.id limit 1)
  ) is not null;

-- ---------- 2. Auto-share org_group với ws origin ----------
insert into app_status_mate.org_group_workspaces
  (workspace_id, org_group_id, added_by, created_by)
select
  g.workspace_id,
  g.id as org_group_id,
  g.owner_user_id as added_by,
  g.owner_user_id as created_by
from app_status_mate.org_groups g
where not exists (
  select 1 from app_status_mate.org_group_workspaces
  where org_group_id = g.id and workspace_id = g.workspace_id
);

-- ---------- 3. Populate org_group_id cho 5 data tables ----------
-- Map: workspace_id → org_group_id (1:1 sau backfill — có đúng 1 group origin
-- per ws). Nếu ws không có group (không được tạo do thiếu owner) → row giữ
-- org_group_id NULL. Mig 007 RPC sẽ raise nếu encounter NULL.

update app_status_mate.squads s
set org_group_id = g.id
from app_status_mate.org_groups g
where s.workspace_id = g.workspace_id
  and s.org_group_id is null;

update app_status_mate.positions p
set org_group_id = g.id
from app_status_mate.org_groups g
where p.workspace_id = g.workspace_id
  and p.org_group_id is null;

update app_status_mate.squad_members sm
set org_group_id = g.id
from app_status_mate.org_groups g
where sm.workspace_id = g.workspace_id
  and sm.org_group_id is null;

update app_status_mate.membership_requests mr
set org_group_id = g.id
from app_status_mate.org_groups g
where mr.workspace_id = g.workspace_id
  and mr.org_group_id is null;

update app_status_mate.squad_events se
set org_group_id = g.id
from app_status_mate.org_groups g
where se.workspace_id = g.workspace_id
  and se.org_group_id is null;

-- ---------- 4. Audit log ----------
-- Báo cáo backfill stats vào NOTICE (xem Reviewer output).
do $$
declare
  v_groups_count int;
  v_squads_orphan int;
  v_positions_orphan int;
  v_members_orphan int;
begin
  select count(*) into v_groups_count from app_status_mate.org_groups;
  select count(*) into v_squads_orphan from app_status_mate.squads where org_group_id is null;
  select count(*) into v_positions_orphan from app_status_mate.positions where org_group_id is null;
  select count(*) into v_members_orphan from app_status_mate.squad_members where org_group_id is null;
  raise notice 'mig 006 backfill: % org_groups created. Orphan rows (org_group_id NULL): squads=%, positions=%, members=%.',
    v_groups_count, v_squads_orphan, v_positions_orphan, v_members_orphan;
end $$;

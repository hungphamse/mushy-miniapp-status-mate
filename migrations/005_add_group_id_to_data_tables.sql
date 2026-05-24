-- =====================================================================
-- org-chart · 005 · Add org_group_id (NULLABLE) vào data tables
--
-- Backward-compat step: thêm cột org_group_id song song với workspace_id
-- hiện tại. Code app vẫn dùng workspace_id (chưa đổi gì). Mig 006 sẽ
-- backfill org_group_id; mig 007 sẽ rewrite RPCs sang group-scoped.
--
-- Tách 2 mig vì:
--   - Mig 005 (this): chỉ ADD COLUMN nullable + FK + index. Zero risk —
--     không đụng data, không đụng query, không đụng RLS.
--   - Mig 006: backfill (mỗi ws có data → tạo 1 org_group + populate
--     org_group_id rows).
--   - Mig 007: rewrite RPCs để check group permission (BREAKING — code
--     mới phải deploy đồng bộ).
--
-- Submit qua Admin Portal Migration Reviewer — auto-duplicate sang dev schema.
-- =====================================================================

-- ---------- squads ----------
alter table app_org_chart.squads
  add column if not exists org_group_id uuid references app_org_chart.org_groups(id) on delete cascade;
create index if not exists idx_squads_group on app_org_chart.squads (org_group_id);

-- ---------- positions ----------
alter table app_org_chart.positions
  add column if not exists org_group_id uuid references app_org_chart.org_groups(id) on delete cascade;
create index if not exists idx_positions_group on app_org_chart.positions (org_group_id);

-- ---------- squad_members ----------
alter table app_org_chart.squad_members
  add column if not exists org_group_id uuid references app_org_chart.org_groups(id) on delete cascade;
create index if not exists idx_sm_group on app_org_chart.squad_members (org_group_id);

-- ---------- membership_requests ----------
alter table app_org_chart.membership_requests
  add column if not exists org_group_id uuid references app_org_chart.org_groups(id) on delete cascade;
create index if not exists idx_mr_group on app_org_chart.membership_requests (org_group_id);

-- ---------- squad_events ----------
alter table app_org_chart.squad_events
  add column if not exists org_group_id uuid references app_org_chart.org_groups(id) on delete cascade;
create index if not exists idx_se_group on app_org_chart.squad_events (org_group_id);

-- KHÔNG đụng RLS / RPC trong mig này — code app vẫn dùng workspace_id.
-- Mig 006 (backfill) + mig 007 (rewrite RPCs) sẽ switch sang group-based.

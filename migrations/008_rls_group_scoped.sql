-- =====================================================================
-- org-chart · 008 · RLS switch sang group-scoped
--
-- Mig 001/002 dùng "workspace_isolation" — user thấy row nếu là member
-- của workspace_id row đó. Sau khi sync (mig 004-007), user W2 (follower
-- subscribe group của W1) phải thấy squads/members có workspace_id = W1.
-- Workspace-scoped policy chặn → cần rewrite.
--
-- Logic mới: user thấy row nếu org_group_id của row visible với user
-- (qua org_group_workspaces join). Helper user_can_see_org_group (mig 004)
-- đã có sẵn.
--
-- WRITE vẫn chặn trực tiếp (chỉ qua RPC SECURITY DEFINER) — tương tự
-- pattern cũ.
-- =====================================================================

-- ---------- squads ----------
drop policy if exists "workspace_isolation" on app_org_chart.squads;
create policy "org_group_isolation" on app_org_chart.squads
for select using (
  org_group_id is not null
  and app_org_chart.user_can_see_org_group(org_group_id)
);

-- ---------- positions ----------
drop policy if exists "workspace_isolation" on app_org_chart.positions;
create policy "org_group_isolation" on app_org_chart.positions
for select using (
  org_group_id is not null
  and app_org_chart.user_can_see_org_group(org_group_id)
);

-- ---------- squad_members ----------
drop policy if exists "workspace_isolation" on app_org_chart.squad_members;
create policy "org_group_isolation" on app_org_chart.squad_members
for select using (
  org_group_id is not null
  and app_org_chart.user_can_see_org_group(org_group_id)
);

-- ---------- membership_requests ----------
drop policy if exists "workspace_isolation" on app_org_chart.membership_requests;
create policy "org_group_isolation" on app_org_chart.membership_requests
for select using (
  org_group_id is not null
  and app_org_chart.user_can_see_org_group(org_group_id)
);

-- ---------- squad_events ----------
drop policy if exists "workspace_isolation" on app_org_chart.squad_events;
create policy "org_group_isolation" on app_org_chart.squad_events
for select using (
  org_group_id is not null
  and app_org_chart.user_can_see_org_group(org_group_id)
);

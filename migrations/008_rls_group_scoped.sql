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
drop policy if exists "org_group_isolation" on app_status_mate.squads;
drop policy if exists "workspace_isolation" on app_status_mate.squads;
create policy "workspace_isolation" on app_status_mate.squads
for select using (
  workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
  or (
    org_group_id is not null
    and app_status_mate.user_can_see_org_group(org_group_id)
  )
);

-- ---------- positions ----------
drop policy if exists "org_group_isolation" on app_status_mate.positions;
drop policy if exists "workspace_isolation" on app_status_mate.positions;
create policy "workspace_isolation" on app_status_mate.positions
for select using (
  workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
  or (
    org_group_id is not null
    and app_status_mate.user_can_see_org_group(org_group_id)
  )
);

-- ---------- squad_members ----------
drop policy if exists "org_group_isolation" on app_status_mate.squad_members;
drop policy if exists "workspace_isolation" on app_status_mate.squad_members;
create policy "workspace_isolation" on app_status_mate.squad_members
for select using (
  workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
  or (
    org_group_id is not null
    and app_status_mate.user_can_see_org_group(org_group_id)
  )
);

-- ---------- membership_requests ----------
drop policy if exists "org_group_isolation" on app_status_mate.membership_requests;
drop policy if exists "workspace_isolation" on app_status_mate.membership_requests;
create policy "workspace_isolation" on app_status_mate.membership_requests
for select using (
  workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
  or (
    org_group_id is not null
    and app_status_mate.user_can_see_org_group(org_group_id)
  )
);

-- ---------- squad_events ----------
drop policy if exists "org_group_isolation" on app_status_mate.squad_events;
drop policy if exists "workspace_isolation" on app_status_mate.squad_events;
create policy "workspace_isolation" on app_status_mate.squad_events
for select using (
  workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
  or (
    org_group_id is not null
    and app_status_mate.user_can_see_org_group(org_group_id)
  )
);

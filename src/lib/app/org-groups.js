// Org-group helpers — wrapper RPCs mig 004 + 007.
// Org-group là entity độc lập với workspace; nhiều ws có thể subscribe
// cùng 1 group qua mã share 4 chữ số → cùng thấy data org chart.
// Origin ws (org_groups.workspace_id) KHÔNG unshare được.

import { db, dbPublic } from '../supabase.js';
import { getContext } from '../context.js';

// List org_groups visible cho current user (qua RLS: member origin ws
// HOẶC member ws đã subscribe). Trả [{id, workspace_id, name, slug,
// description, owner_user_id, created_at}].
export async function listOrgGroups() {
  const { data, error } = await db
    .from('org_groups')
    .select('id, workspace_id, name, slug, description, owner_user_id, created_at')
    .is('deleted_at', null)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

// List ws đang subscribe 1 group (cho UI "Workspace đã share").
// 2 step: cross-schema FK (app_*.org_group_workspaces → public.workspaces)
// không có trong PostgREST schema cache → không embed được.
export async function listWorkspacesForGroup(groupId) {
  const { data: rows, error } = await db
    .from('org_group_workspaces')
    .select('workspace_id, created_at')
    .eq('org_group_id', groupId);
  if (error) throw error;
  if (!rows?.length) return [];

  const wsIds = rows.map((r) => r.workspace_id);
  const { data: ws, error: wsErr } = await dbPublic
    .from('workspaces')
    .select('id, name, slug')
    .in('id', wsIds);
  if (wsErr) throw wsErr;

  const byId = new Map((ws || []).map((w) => [w.id, w]));
  return rows.map((r) => {
    const w = byId.get(r.workspace_id);
    return {
      workspace_id: r.workspace_id,
      name: w?.name,
      slug: w?.slug,
      added_at: r.created_at,
    };
  });
}

// Tạo org_group mới. Auto-share với ws hiện tại (origin).
export async function createOrgGroup({ name, description = null }) {
  const ctx = getContext();
  const { data, error } = await db.rpc('create_org_group', {
    p_workspace_id: ctx.workspaceId,
    p_name: name,
    p_description: description,
  });
  if (error) throw error;
  return data;
}

// Update name/description (owner only).
export async function updateOrgGroup(groupId, patch = {}) {
  const { data, error } = await db.rpc('update_org_group', {
    p_group_id: groupId,
    p_name: patch.name ?? null,
    p_description: patch.description ?? null,
  });
  if (error) throw error;
  return data;
}

// Soft delete (owner only, slug confirm).
export async function deleteOrgGroup(groupId, confirmSlug) {
  const { error } = await db.rpc('delete_org_group_soft', {
    p_group_id: groupId,
    p_confirm_slug: confirmSlug,
  });
  if (error) throw error;
}

// Gen mã share 4 chữ số. Mặc định 24h expire. Bất kỳ user thấy group đều
// gen được (RPC check user_can_see_org_group).
export async function generateShareCode(groupId, expiresHours = 24) {
  const ctx = getContext();
  const { data, error } = await db.rpc('generate_org_group_share_code', {
    p_workspace_id: ctx.workspaceId,
    p_group_id: groupId,
    p_expires_hours: expiresHours,
  });
  if (error) throw error;
  return data;  // { id, code, expires_at, ... }
}

// Redeem mã: subscribe current ws vào group đó. Caller phải owner/admin ws.
export async function redeemShareCode(code, targetWsId = null) {
  const ctx = getContext();
  const { data, error } = await db.rpc('redeem_org_group_share_code', {
    p_code: code,
    p_target_ws_id: targetWsId ?? ctx.workspaceId,
  });
  if (error) throw error;
  return data;  // org_group row
}

// Unshare ws khỏi group (caller phải owner/admin ws). Chặn nếu ws là origin.
export async function unshareFromWorkspace(groupId, wsId = null) {
  const ctx = getContext();
  const { error } = await db.rpc('unshare_org_group_from_workspace', {
    p_group_id: groupId,
    p_ws_id: wsId ?? ctx.workspaceId,
  });
  if (error) throw error;
}

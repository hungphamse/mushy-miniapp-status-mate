// Batch lookup members + profiles của workspace.
//
// Tận dụng RLS workspace-mate visibility (superapp migration 004): mọi member
// SELECT được public.workspace_members + public.user_profiles của workspace-mate.
// Trước đó self-only RLS ép mini-app fallback hash-color — KHÔNG dùng nữa.
//
// Usage:
//   import { listMembers, getProfiles } from './lib/members.js';
//   const members = await listMembers(ctx.workspaceId);
//   // [{ user_id, role, display_name, avatar_url }, ...]
//
//   // Hoặc chỉ cần profile cho 1 subset user_ids đã biết (vd voters list):
//   const profileMap = await getProfiles([uid1, uid2, uid3]);
//   // { uid1: { user_id, display_name, avatar_url }, ... }

import { dbPublic } from './supabase.js';

export async function listMembers(workspaceId) {
  if (!workspaceId) return [];

  const { data: rows, error: mErr } = await dbPublic
    .from('workspace_members')
    .select('user_id, role')
    .eq('workspace_id', workspaceId);
  if (mErr) throw mErr;
  if (!rows?.length) return [];

  const profileMap = await getProfiles(rows.map((r) => r.user_id));
  return rows.map((r) => ({
    user_id: r.user_id,
    role: r.role,
    display_name: profileMap[r.user_id]?.display_name ?? null,
    avatar_url: profileMap[r.user_id]?.avatar_url ?? null,
  }));
}

export async function getProfiles(userIds) {
  if (!userIds?.length) return {};
  const { data, error } = await dbPublic
    .from('user_profiles')
    .select('user_id, display_name, avatar_url')
    .in('user_id', userIds);
  if (error) throw error;
  return Object.fromEntries((data || []).map((p) => [p.user_id, p]));
}

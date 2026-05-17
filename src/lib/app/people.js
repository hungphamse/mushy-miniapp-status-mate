// People lookup cho org-chart — app-specific (đặt trong src/lib/app/ để
// KHÔNG bị sync-template --delete xoá; shared members.js chỉ select
// display_name/avatar_url, org-chart cần thêm full_name/work_phone — mig
// 020 thêm cột + RLS workspace-mate (mig 004). job_title đã chuyển
// per-company (mig 021) → KHÔNG đọc từ user_profiles nữa.

import { dbPublic } from '../supabase.js';

// → [{ user_id, ws_role, display_name, full_name, work_phone, avatar_url }]
export async function listWorkspacePeople(workspaceId) {
  if (!workspaceId) return [];
  const { data: members, error: mErr } = await dbPublic
    .from('workspace_members')
    .select('user_id, role')
    .eq('workspace_id', workspaceId);
  if (mErr) throw mErr;
  if (!members?.length) return [];

  const ids = members.map((m) => m.user_id);
  const { data: profiles, error: pErr } = await dbPublic
    .from('user_profiles')
    .select('user_id, display_name, full_name, work_phone, avatar_url')
    .in('user_id', ids);
  if (pErr) throw pErr;

  const pmap = Object.fromEntries((profiles || []).map((p) => [p.user_id, p]));
  return members.map((m) => {
    const p = pmap[m.user_id] || {};
    return {
      user_id: m.user_id,
      ws_role: m.role,
      display_name: p.display_name ?? null,
      full_name: p.full_name ?? null,
      work_phone: p.work_phone ?? null,
      avatar_url: p.avatar_url ?? null,
    };
  });
}

// Tên ưu tiên hiển thị: full_name (thật) → display_name (nickname) → fallback.
export function personLabel(p) {
  if (!p) return 'Ẩn danh';
  return (p.full_name && p.full_name.trim())
    || (p.display_name && p.display_name.trim())
    || 'Chưa đặt tên';
}

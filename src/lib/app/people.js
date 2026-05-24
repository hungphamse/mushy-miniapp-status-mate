// People lookup cho org-chart — app-specific (đặt trong src/lib/app/ để
// KHÔNG bị sync-template --delete xoá; shared members.js chỉ select
// full_name/avatar_url, org-chart cần thêm work_phone + emails + companies).
//
// Sau mig 006+007 (sync org-group): query members của TẤT CẢ ws subscribed
// vào group (qua org_group_workspaces), không chỉ 1 ws. User có thể là
// member nhiều ws sub vào cùng group → dedupe theo user_id.

import { db, dbPublic } from '../supabase.js';

// listGroupPeople(groupId)
// → [{ user_id, ws_role, full_name, work_phone, work_email, personal_email,
//      job_title, avatar_url, companies }]
//
// ws_role = role cao nhất tìm thấy ở bất kỳ ws subscribed (owner > admin > member).
export async function listGroupPeople(groupId) {
  if (!groupId) return [];

  // 1. Lấy danh sách ws subscribed group.
  const { data: gw, error: gwErr } = await db
    .from('org_group_workspaces')
    .select('workspace_id')
    .eq('org_group_id', groupId);
  if (gwErr) throw gwErr;
  const wsIds = (gw || []).map((r) => r.workspace_id);
  if (wsIds.length === 0) return [];

  // 2. workspace_members của các ws đó.
  const { data: members, error: mErr } = await dbPublic
    .from('workspace_members')
    .select('user_id, role')
    .in('workspace_id', wsIds);
  if (mErr) throw mErr;
  if (!members?.length) return [];

  // Dedupe user_id, giữ role cao nhất.
  const ROLE_RANK = { owner: 3, admin: 2, member: 1 };
  const userRole = new Map();
  for (const m of members) {
    const prev = userRole.get(m.user_id);
    if (!prev || (ROLE_RANK[m.role] || 0) > (ROLE_RANK[prev] || 0)) {
      userRole.set(m.user_id, m.role);
    }
  }
  const ids = Array.from(userRole.keys());

  // 3. Profiles.
  const { data: profiles, error: pErr } = await dbPublic
    .from('user_profiles')
    .select('user_id, full_name, work_phone, avatar_url, work_email, personal_email')
    .in('user_id', ids);
  if (pErr) throw pErr;
  const pmap = Object.fromEntries((profiles || []).map((p) => [p.user_id, p]));

  // 4. job_title per-company + companies user thuộc (logo).
  // Dùng RPC app_org_chart.get_users_companies (mig 009 SECURITY DEFINER)
  // để bypass RLS public.company_members — RLS chỉ cho user thấy member
  // cùng company → follower ws (user khác company) trả empty → không logo.
  // RPC expose company info công khai (id, name, logo_url, job_title) cho
  // bất kỳ authenticated — acceptable vì cross-ws sharing đã expose info này.
  const jtMap = {};
  const companiesMap = {};
  try {
    const { data: cm } = await db.rpc('get_users_companies', { p_user_ids: ids });
    const companyById = new Map();
    for (const r of cm || []) {
      const jt = r.job_title && r.job_title.trim();
      if (jt && !jtMap[r.user_id]) jtMap[r.user_id] = jt;
      if (r.company_id) {
        companyById.set(r.company_id, {
          id: r.company_id,
          name: r.company_name,
          logo_url: r.logo_url || null,
        });
        if (!companiesMap[r.user_id]) companiesMap[r.user_id] = [];
        if (!companiesMap[r.user_id].some((c) => c.id === r.company_id)) {
          companiesMap[r.user_id].push(companyById.get(r.company_id));
        }
      }
    }
  } catch { /* RPC chưa apply hoặc lỗi — skip */ }

  return ids.map((uid) => {
    const p = pmap[uid] || {};
    return {
      user_id: uid,
      ws_role: userRole.get(uid),
      full_name: p.full_name ?? null,
      work_phone: p.work_phone ?? null,
      work_email: p.work_email ?? null,
      personal_email: p.personal_email ?? null,
      job_title: jtMap[uid] ?? null,
      avatar_url: p.avatar_url ?? null,
      companies: companiesMap[uid] || [],
    };
  });
}

// Backward-compat: giữ tên cũ cho code chưa update.
// TODO: caller migrate sang listGroupPeople(groupId) rồi xoá hàm này.
export async function listWorkspacePeople() {
  console.warn('[people.js] listWorkspacePeople() deprecated — dùng listGroupPeople(groupId).');
  return [];
}

// Tên hiển thị: full_name (thật) → fallback. Biệt danh đã bỏ (mig 023).
export function personLabel(p) {
  if (!p) return 'Ẩn danh';
  return (p.full_name && p.full_name.trim()) || 'Chưa đặt tên';
}

// Email hiển thị ưu tiên work_email; fallback personal_email.
export function personEmail(p) {
  if (!p) return null;
  const work = (p.work_email || '').trim();
  if (work) return work;
  const personal = (p.personal_email || '').trim();
  return personal || null;
}

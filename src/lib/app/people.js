// People lookup cho org-chart — app-specific (đặt trong src/lib/app/ để
// KHÔNG bị sync-template --delete xoá; shared members.js chỉ select
// full_name/avatar_url, org-chart cần thêm work_phone — mig 020 thêm cột
// + RLS workspace-mate (mig 004). Biệt danh display_name đã bỏ (mig 023).
// job_title đã chuyển
// per-company (mig 021) → đọc từ company_members (RLS members_select_
// same_company cho thấy member cùng công ty). org-chart workspace-scoped
// nên không biết companyId — gom mọi company_members caller thấy được,
// map user_id → job_title (lấy giá trị non-null đầu tiên; đủ để hiển thị).

import { dbPublic } from '../supabase.js';

// → [{ user_id, ws_role, full_name, work_phone, job_title, avatar_url }]
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
    .select('user_id, full_name, work_phone, avatar_url, work_email, personal_email')
    .in('user_id', ids);
  if (pErr) throw pErr;

  const pmap = Object.fromEntries((profiles || []).map((p) => [p.user_id, p]));

  // job_title per-company (mig 021). Resilient: nếu 021 chưa apply / RLS
  // không cho → bỏ qua, vẫn render list (không vỡ org chart).
  const jtMap = {};
  try {
    const { data: cm } = await dbPublic
      .from('company_members')
      .select('user_id, job_title')
      .in('user_id', ids);
    for (const r of cm || []) {
      const jt = r.job_title && r.job_title.trim();
      if (jt && !jtMap[r.user_id]) jtMap[r.user_id] = jt;
    }
  } catch { /* 021 chưa apply hoặc RLS chặn — skip job_title */ }

  return members.map((m) => {
    const p = pmap[m.user_id] || {};
    return {
      user_id: m.user_id,
      ws_role: m.role,
      full_name: p.full_name ?? null,
      work_phone: p.work_phone ?? null,
      work_email: p.work_email ?? null,
      personal_email: p.personal_email ?? null,
      job_title: jtMap[m.user_id] ?? null,
      avatar_url: p.avatar_url ?? null,
    };
  });
}

// Tên hiển thị: full_name (thật) → fallback. Biệt danh đã bỏ (mig 023).
export function personLabel(p) {
  if (!p) return 'Ẩn danh';
  return (p.full_name && p.full_name.trim()) || 'Chưa đặt tên';
}

// Email hiển thị ưu tiên work_email; fallback personal_email.
// Trả null nếu không có cả 2.
export function personEmail(p) {
  if (!p) return null;
  const work = (p.work_email || '').trim();
  if (work) return work;
  const personal = (p.personal_email || '').trim();
  return personal || null;
}

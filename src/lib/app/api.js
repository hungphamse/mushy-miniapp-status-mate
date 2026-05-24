// org-chart data access — app-specific (src/lib/app/ né sync --delete).
// Sau mig 006+007 (sync org-group), mọi query scope theo org_group_id
// thay vì workspace_id. RLS check membership qua join org_group_workspaces.

import { db } from '../supabase.js';

export async function fetchOrgChart(groupId) {
  if (!groupId) return { squads: [], members: [], positions: [], requests: [], events: [] };
  const [squadsR, membersR, positionsR, reqR, evR] = await Promise.all([
    db.from('squads').select('*').eq('org_group_id', groupId),
    db.from('squad_members').select('*').eq('org_group_id', groupId).is('left_at', null),
    db.from('positions').select('*').eq('org_group_id', groupId).order('sort_order', { ascending: true }),
    db.from('membership_requests').select('*').eq('org_group_id', groupId).eq('status', 'pending'),
    db.from('squad_events').select('*').eq('org_group_id', groupId)
      .order('created_at', { ascending: false }).limit(40),
  ]);
  if (squadsR.error) throw squadsR.error;
  if (membersR.error) throw membersR.error;
  if (positionsR.error) throw positionsR.error;
  return {
    squads: squadsR.data || [],
    members: membersR.data || [],
    positions: positionsR.data || [],
    requests: reqR.error ? [] : (reqR.data || []),
    events: evR.error ? [] : (evR.data || []),
  };
}

const call = async (fn, args) => {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw error;
  return data;
};

export const api = {
  seedPositions: (p_group_id) => call('seed_default_positions', { p_group_id }),
  createSquad: (p_group_id, p_name, p_slug, p_parent, p_intro) =>
    call('create_squad', { p_group_id, p_name, p_slug, p_parent: p_parent || null, p_intro: p_intro || null }),
  updateSquad: (p_id, patch) =>
    call('update_squad', {
      p_id,
      p_name: patch.name ?? null,
      p_intro: patch.intro ?? null,
      p_parent: patch.parent ?? null,
      p_status: patch.status ?? null,
    }),
  assignLead: (p_squad, p_user, p_position) =>
    call('assign_squad_lead', { p_squad, p_user, p_position: p_position || 'Lead' }),
  createPosition: (p_group_id, p_name) => call('create_position', { p_group_id, p_name }),
  deletePosition: (p_id) => call('delete_position', { p_id }),
  adminSetMember: (p_squad, p_user, p_position, p_allocation, p_kind = 'member') =>
    call('admin_set_member', { p_squad, p_user, p_position, p_allocation, p_kind }),
  removeMember: (p_squad, p_user) => call('remove_member', { p_squad, p_user }),
  setMyAllocation: (p_squad, p_allocation, p_position) =>
    call('set_my_allocation', { p_squad, p_allocation, p_position }),
  requestMembership: (p_squad, p_type, p_position, p_allocation, p_message) =>
    call('request_membership', {
      p_squad, p_type,
      p_position: p_position || null,
      p_allocation: p_allocation == null ? null : p_allocation,
      p_message: p_message || null,
    }),
  decideMembership: (p_req, p_approve) =>
    call('decide_membership', { p_req, p_approve }),
  cancelMyRequest: (p_req) => call('cancel_my_request', { p_req }),
};

// slug từ tên: bỏ dấu, lowercase, gạch nối. Min 2 ký tự (regex squad.slug).
export function slugify(name) {
  const s = (name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'd')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.length >= 2 ? s.slice(0, 40) : (s + 'sq').slice(0, 40);
}

// Tổng allocation theo user (mọi squad active). userId → total %.
export function allocationTotals(members) {
  const m = {};
  for (const r of members) m[r.user_id] = (m[r.user_id] || 0) + (r.allocation || 0);
  return m;
}

// 'ok' | 'over' | 'under' theo tổng allocation (chỉ xét user có ≥1 squad).
export function allocStatus(total) {
  if (total > 100) return 'over';
  if (total < 100) return 'under';
  return 'ok';
}

// squad_events → 1 dòng tiếng Việt. nameOf(uid)→tên, squadName(id)→tên squad.
export function describeEvent(ev, nameOf, squadName) {
  const who = ev.subject_id ? nameOf(ev.subject_id) : '';
  const actor = ev.actor_id ? nameOf(ev.actor_id) : 'Ai đó';
  const sq = squadName(ev.squad_id) || 'squad';
  const p = ev.payload || {};
  switch (ev.type) {
    case 'squad_created':   return `${actor} tạo squad “${p.name || sq}”`;
    case 'squad_renamed':   return `${actor} đổi tên squad thành “${p.name || sq}”`;
    case 'squad_archived':  return `${actor} lưu trữ squad “${sq}”`;
    case 'squad_restored':  return `${actor} khôi phục squad “${sq}”`;
    case 'intro_updated':   return `${actor} cập nhật giới thiệu “${sq}”`;
    case 'lead_changed':
    case 'lead_assigned':   return `${who || 'Ai đó'} được gán làm lead “${sq}”`;
    case 'member_joined':   return `${who} vào squad “${sq}” (${p.position || '—'} · ${p.allocation ?? 0}%)`;
    case 'member_left':     return `${who} rời squad “${sq}”`;
    case 'role_changed':    return `${who} đổi vai trò ${p.from}→${p.to} ở “${sq}”`;
    case 'allocation_changed':
      return `${who} chỉnh allocation “${sq}” → ${p.allocation ?? 0}% (${p.position || '—'})`;
    case 'request_created':
      return `${who} đăng ký ${p.req_type === 'leave' ? 'rời' : 'vào'} “${sq}”`;
    case 'request_approved':
      return `${actor} duyệt yêu cầu ${p.req_type === 'leave' ? 'rời' : 'vào'} “${sq}” của ${who}`;
    case 'request_rejected':
      return `${actor} từ chối yêu cầu của ${who} ở “${sq}”`;
    case 'request_cancelled':
      return `${who} huỷ yêu cầu ở “${sq}”`;
    default: return `${actor}: ${ev.type} · ${sq}`;
  }
}

// 'x phút/giờ/ngày trước' gọn.
export function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'vừa xong';
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
  return `${Math.floor(s / 86400)} ngày trước`;
}

// SĐT VN hiển thị 0xx yyy zzzz (3-3-4, 2 space). Gọi tel: vẫn dùng raw.
export function formatVNPhone(raw) {
  const s = String(raw ?? '').trim();
  const d = s.replace(/\D/g, '');
  if (d.length === 10 && d.startsWith('0')) {
    return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
  }
  return s;
}

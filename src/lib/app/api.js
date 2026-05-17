// org-chart data access — app-specific (src/lib/app/ né sync --delete).
// Mọi query scope .eq('workspace_id', ws) (RLS không chặn cross-workspace
// cùng user — CLAUDE.md §3.4). Mutation đi qua RPC SECURITY DEFINER.

import { db } from '../supabase.js';

export async function fetchOrgChart(ws) {
  const [squadsR, membersR, positionsR] = await Promise.all([
    db.from('squads').select('*').eq('workspace_id', ws),
    db.from('squad_members').select('*').eq('workspace_id', ws).is('left_at', null),
    db.from('positions').select('*').eq('workspace_id', ws).order('sort_order', { ascending: true }),
  ]);
  if (squadsR.error) throw squadsR.error;
  if (membersR.error) throw membersR.error;
  if (positionsR.error) throw positionsR.error;
  return {
    squads: squadsR.data || [],
    members: membersR.data || [],
    positions: positionsR.data || [],
  };
}

const call = async (fn, args) => {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw error;
  return data;
};

export const api = {
  seedPositions: (p_ws) => call('seed_default_positions', { p_ws }),
  createSquad: (p_ws, p_name, p_slug, p_parent, p_intro) =>
    call('create_squad', { p_ws, p_name, p_slug, p_parent: p_parent || null, p_intro: p_intro || null }),
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
  createPosition: (p_ws, p_name) => call('create_position', { p_ws, p_name }),
  deletePosition: (p_id) => call('delete_position', { p_id }),
  adminSetMember: (p_squad, p_user, p_position, p_allocation, p_kind = 'member') =>
    call('admin_set_member', { p_squad, p_user, p_position, p_allocation, p_kind }),
  removeMember: (p_squad, p_user) => call('remove_member', { p_squad, p_user }),
  setMyAllocation: (p_squad, p_allocation, p_position) =>
    call('set_my_allocation', { p_squad, p_allocation, p_position }),
};

// slug từ tên: bỏ dấu, lowercase, gạch nối. Min 2 ký tự (regex squad.slug).
export function slugify(name) {
  const s = (name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
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

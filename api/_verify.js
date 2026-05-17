// Helper dùng chung cho các Vercel Function:
// verify JWT từ Authorization header, trả về { userId, workspaceId, role, token }.
//
// KHÔNG dùng service_role — anon key + user JWT đủ:
//   - auth.getUser(token) verify signature qua /auth/v1/user (anon được phép).
//   - RLS trên workspace_members cho user đọc membership của chính họ.
//
// → Mini-app dev KHÔNG bao giờ cần SUPABASE_SERVICE_ROLE_KEY. Privileged ops
//   (push, cross-user query) đi qua superapp's mini-proxy gateway — xem
//   src/lib/mushy-api.js.
//
// Dùng:
//   import { verifyRequest } from './_verify.js';
//   export default async function handler(req, res) {
//     const ctx = await verifyRequest(req);
//     if (!ctx) return res.status(401).json({ error: 'unauthorized' });
//     ...
//   }

import { createClient } from '@supabase/supabase-js';
// JSON import attribute — Vercel bundler traces ESM imports, đảm bảo
// mushy.config.json được include vào deployment. Node 20.10+/22 hỗ trợ `with`.
import config from '../mushy.config.json' with { type: 'json' };

const SUPABASE_URL = config.supabase.url;
const ANON_KEY = config.supabase.anonKey;

export async function verifyRequest(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const workspaceId = req.headers['x-workspace-id'];
  if (!token || !workspaceId) return null;

  const client = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: u, error } = await client.auth.getUser(token);
  if (error || !u?.user) return null;

  const { data: member } = await client
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', u.user.id)
    .maybeSingle();
  if (!member) return null;

  return { userId: u.user.id, workspaceId, role: member.role, token };
}

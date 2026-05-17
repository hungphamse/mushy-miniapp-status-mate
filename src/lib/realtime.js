// Supabase Realtime (Postgres Changes + Broadcast).
//
// subscribeToTable('tasks', workspaceId, (payload) => { ... })
//   → trả về hàm unsubscribe. NHỚ gọi khi unmount component.
//
// subscribeBroadcast('job_completed', workspaceId, handler)
//   → cho queue/job pattern.
//
// ⚠️ DDL yêu cầu cho table dùng realtime — viết trong migration:
//   alter publication supabase_realtime add table app_{slug}.{table};
//   alter table app_{slug}.{table} replica identity full;
//
//   Lý do:
//   - PUBLICATION: nếu không add, Postgres không emit WAL event → mini-app
//     không nhận update nào cả.
//   - REPLICA IDENTITY FULL: mặc định DELETE chỉ emit primary key. Filter
//     `workspace_id=eq.X` cần cột workspace_id trong payload → cần FULL
//     để Postgres emit toàn bộ row (cả cũ lẫn mới). Nếu thiếu, DELETE events
//     bị drop ở client-side filter.
//
// ⚠️ Auth realtime ≠ REST: Realtime dùng WebSocket riêng, không share
// global.headers. supabase.js đã gọi realtime.setAuth(token) lúc tạo client.
// Token JWT expire sau ~1h → realtime channel bị disconnect khi token hết hạn.
// Pattern handle: nghe sự kiện token refresh (qua bridge.REFRESH_TOKEN), gọi
// lại setAuth + re-subscribe channel. Hiện tại template chưa auto-handle.

import { getSupabase } from './supabase.js';
import { getContext } from './context.js';
import config from '../../mushy.config.json';

const slug = config.slug;
// __VERCEL_ENV__ build-time constant (vite.config.js define) — đồng bộ với
// src/lib/supabase.js. Trước đây dùng import.meta.env.VITE_APP_ENV nhưng
// vite.config.js KHÔNG define VITE_APP_ENV → undefined → fallback 'prod' →
// realtime sub schema PROD trên local/preview → silent bug (REST query dev,
// realtime nhận event prod khác workspace).
// eslint-disable-next-line no-undef
const vercelEnv = typeof __VERCEL_ENV__ !== 'undefined' ? __VERCEL_ENV__ : 'development';
const schemaSlug = slug.replace(/-/g, '_');
const schema = vercelEnv === 'production' ? `app_${schemaSlug}` : `app_${schemaSlug}_dev`;

// Re-attach token trước subscribe — phòng trường hợp token đã refresh
// sau khi client được tạo lần đầu.
function refreshAuth() {
  const ctx = getContext();
  if (!ctx.token) return;
  try { getSupabase().realtime.setAuth(ctx.token); } catch { /* older supabase-js */ }
}

export function subscribeToTable(table, workspaceId, callback) {
  refreshAuth();
  const channel = getSupabase()
    .channel(`db:${schema}.${table}:${workspaceId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema,
        table,
        filter: `workspace_id=eq.${workspaceId}`,
      },
      callback
    )
    .subscribe();

  return () => getSupabase().removeChannel(channel);
}

export function subscribeBroadcast(event, workspaceId, callback) {
  refreshAuth();
  const channel = getSupabase()
    .channel(`bc:${schema}:${workspaceId}`)
    .on('broadcast', { event }, ({ payload }) => callback(payload))
    .subscribe();

  return () => getSupabase().removeChannel(channel);
}

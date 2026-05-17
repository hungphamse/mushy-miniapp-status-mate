// Supabase client cho mini-app.
// - URL + anon key + slug đọc từ mushy.config.json.
// - Token lấy từ APP_CONTEXT (do Shell inject hoặc VITE_DEV_TOKEN).
// - Schema auto theo VERCEL_ENV:
//     production (main deploy)        → app_{slug}        prod
//     preview    (branch khác main)   → app_{slug}_dev    dev sandbox
//     development (local npm run dev) → app_{slug}_dev    dev sandbox
// - 2 client:
//     `db`       → scoped vào schema mini-app (theo env)
//     `dbPublic` → scoped vào `public` (workspaces, mini_apps...). Hiếm dùng.

import { createClient } from '@supabase/supabase-js';
import { getContext } from './context.js';
import config from '../../mushy.config.json';

const url = config.supabase.url;
const anonKey = config.supabase.anonKey;
const slug = config.slug;
// Schema name normalize dash → underscore (slug "lunch-plan" → schema "app_lunch_plan").
// Postgres unquoted identifier không nhận dash → migration SQL không phải quote.
// Slug giữ nguyên dash cho URL/domain.
const schemaSlug = slug.replace(/-/g, '_');
// __VERCEL_ENV__ là global build-time constant (vite.config.js define) — replace
// ở build, KHÔNG phải runtime. Bypass Vite internal handling của import.meta.env.
// eslint-disable-next-line no-undef
const vercelEnv = typeof __VERCEL_ENV__ !== 'undefined' ? __VERCEL_ENV__ : 'development';
const schema = vercelEnv === 'production' ? `app_${schemaSlug}` : `app_${schemaSlug}_dev`;

if (!url || !anonKey) {
  console.warn('[supabase] thiếu supabase.url hoặc supabase.anonKey trong mushy.config.json');
}
if (slug.includes('REPLACE_WITH')) {
  console.warn(
    '[mushy.config.json] slug còn placeholder "REPLACE_WITH_YOUR_SLUG". ' +
    'Đổi sang slug Mushy admin cấp trước khi deploy. Build vẫn pass nhưng query sẽ lỗi runtime.'
  );
}

function makeClient(schemaName) {
  const ctx = getContext();
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: ctx.token ? { Authorization: `Bearer ${ctx.token}` } : {},
    },
    db: { schema: schemaName },
  });
  // Realtime dùng WebSocket riêng — KHÔNG share global.headers với REST.
  // Không setAuth → Realtime treat sub là anon → RLS chặn → INSERT/UPDATE/DELETE
  // event không deliver. setAuth attach token vào WS connection.
  // Token expire sau ~1h → realtime cần re-subscribe sau khi refresh; xem realtime.js.
  if (ctx.token) {
    try { client.realtime.setAuth(ctx.token); } catch { /* older supabase-js */ }
  }
  return client;
}

let _appClient = null;
export function getSupabase() {
  if (!_appClient) _appClient = makeClient(schema);
  return _appClient;
}

let _publicClient = null;
export function getPublicSupabase() {
  if (!_publicClient) _publicClient = makeClient('public');
  return _publicClient;
}

// Clear cache buộc next getSupabase() / getPublicSupabase() recreate client.
// Dùng khi token refresh: REST client capture token vào global.headers lúc
// create — không update được sau, phải recreate. Realtime setAuth thì khác,
// support runtime update (xem realtime.js refreshAuth).
//
// Caller (vd auth.js của miniapp-admin web khi onAuthStateChange fire token
// refresh): gọi resetSupabaseClients() để clear cache → các query sau dùng
// token mới.
export function resetSupabaseClients() {
  _appClient = null;
  _publicClient = null;
}

// Shortcut: db.from('tasks').select(...)  → app_{slug}.tasks
export const db = new Proxy({}, {
  get(_, prop) {
    const c = getSupabase();
    return typeof c[prop] === 'function' ? c[prop].bind(c) : c[prop];
  },
});

// Shortcut: dbPublic.from('mini_apps').select(...)  → public.mini_apps
export const dbPublic = new Proxy({}, {
  get(_, prop) {
    const c = getPublicSupabase();
    return typeof c[prop] === 'function' ? c[prop].bind(c) : c[prop];
  },
});

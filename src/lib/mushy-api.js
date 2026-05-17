// Helper gọi superapp's mini-proxy gateway cho privileged op.
//
// CRUD bình thường → vẫn dùng `db.from(...)` (anon + user JWT + RLS).
// Privileged op (push, cross-user query, …) → qua đây.
//
// Sao không gọi thẳng send-push? Vì send-push yêu cầu service_role auth,
// mini-app không được cấp service_role. mini-proxy verify membership bằng
// user JWT rồi forward với service_role nội bộ.
//
// Usage:
//   import { mushyApi } from './lib/mushy-api.js';
//   await mushyApi.push({ title: 'Hello', body: 'Hi' });
//
//   // Gửi chỉ cho 1 số user trong workspace
//   await mushyApi.push({ title, body, userIds: ['uuid1', 'uuid2'] });
//
//   // Deep link payload — Shell open mini-app khi tap noti.
//   // `workspaceId` được auto-inject từ ctx (Shell cần verify membership +
//   // lookup workspace metadata trước khi mở app). `appSlug` BẮT BUỘC nếu
//   // muốn deeplink vào mini-app — thiếu sẽ chỉ về Mushy home.
//   // Convention khớp `superapp/lib/notification-router.js`.
//   await mushyApi.push({
//     title, body,
//     data: {
//       appSlug: 'lunch-plan',  // BẮT BUỘC cho deeplink
//       screen: 'detail',        // optional — Shell pass qua query
//       recordId: '...',         // optional
//     },
//   });

import config from '../../mushy.config.json';
import { getContext } from './context.js';

const BASE = `${config.supabase.url}/functions/v1/mini-proxy`;

async function call(action, payload) {
  const ctx = getContext();
  if (!ctx.token) throw new Error('mushy-api: missing token in context');
  if (!ctx.workspaceId) throw new Error('mushy-api: missing workspaceId in context');

  const res = await fetch(BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Supabase Edge gateway require Authorization với JWT format hợp lệ. Đẩy
      // anon (HS256) vào đây — gateway happy. KHÔNG đặt user JWT (ES256/RS256)
      // ở Authorization vì gateway reject UNAUTHORIZED_INVALID_JWT_FORMAT kể
      // cả khi function deploy --no-verify-jwt (gateway vẫn JWKS-check kid).
      Authorization: `Bearer ${config.supabase.anonKey}`,
      apikey: config.supabase.anonKey,
      // User identity thật — function đọc + verify qua admin.auth.getUser.
      'X-Mushy-User-Token': ctx.token,
    },
    body: JSON.stringify({ action, workspaceId: ctx.workspaceId, ...payload }),
  });

  const json = await res.json().catch(() => ({ error: `non-JSON ${res.status}` }));
  if (!res.ok) {
    const err = new Error(`mini-proxy ${action}: ${json.error || res.statusText}`);
    err.status = res.status;
    err.detail = json;
    throw err;
  }
  return json;
}

export const mushyApi = {
  /**
   * Gửi push notification tới members của workspace hiện tại.
   * @param {object} opts
   * @param {string} opts.title
   * @param {string} opts.body
   * @param {object} [opts.data] - Deep link payload Shell đọc khi user tap noti.
   *   `workspaceId` auto-inject từ ctx (Shell cần để verify membership + switch
   *   workspace trước khi mở app). Thêm `appSlug` để mở thẳng mini-app, `screen`
   *   + `recordId` để pass qua query params. Override `workspaceId` nếu push
   *   cross-workspace (rare).
   * @param {string[]} [opts.userIds] - chỉ gửi cho subset members
   * @returns {Promise<{sent: number, tokens: number, cleaned: number, tickets: any[]}>}
   */
  push({ title, body, data = {}, userIds }) {
    return call('push', {
      title,
      body,
      data: { workspaceId: getContext().workspaceId, ...data },
      userIds,
    });
  },
};

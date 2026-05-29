// Status-Mate realtime helpers (org_group scoped). App-specific to avoid
// touching shared lib/realtime.js.

import { getSupabase } from '../supabase.js';
import { getContext } from '../context.js';
import config from '../../../mushy.config.json';

const slug = config.slug;
// eslint-disable-next-line no-undef
const vercelEnv = typeof __VERCEL_ENV__ !== 'undefined' ? __VERCEL_ENV__ : 'development';
const schemaSlug = slug.replace(/-/g, '_');
const schema = vercelEnv === 'production' ? `app_${schemaSlug}` : `app_${schemaSlug}_dev`;

function refreshAuth() {
  const ctx = getContext();
  if (!ctx?.token) return;
  try { getSupabase().realtime.setAuth(ctx.token); } catch { /* older supabase-js */ }
}

export function subscribeToStatus(groupId, callback) {
  if (!groupId) return () => {};
  refreshAuth();
  const channel = getSupabase()
    .channel(`db:${schema}.member_statuses:${groupId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema,
        table: 'member_statuses',
        filter: `org_group_id=eq.${groupId}`,
      },
      callback
    )
    .subscribe();

  return () => getSupabase().removeChannel(channel);
}

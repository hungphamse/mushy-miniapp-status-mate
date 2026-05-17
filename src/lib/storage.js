// File storage abstraction.
//
// Default: Supabase Storage. Bucket name = `miniapp-{slug}` (slug từ mushy.config.json).
// Bucket auto-tạo bởi Admin Portal khi register app — mini-app KHÔNG viết SQL touching storage.
//
// R2: opt-in qua env `VITE_USE_R2=true`. Khi bật, upload + view đi qua
// Edge Functions `storage-upload` / `storage-view` (cần deploy 2 functions
// đó vào Supabase, kèm R2 credentials trong env). Đây là path cho prod
// thật khi traffic file lớn / muốn bandwidth rẻ hơn Supabase Storage.
//
// Mini-app KHÔNG nên biết đang dùng cái nào. Lưu `object_key` vào DB,
// không bao giờ lưu URL trực tiếp (URL có thời hạn).
//
// Path convention:
//   prod: {workspace_id}/{folder}/{uuid}.{ext}
//   dev:  {workspace_id}/dev/{folder}/{uuid}.{ext}
// (foldername[1] = workspace_id vẫn match RLS policy. dev có prefix /dev/ để
// dễ wipe sạch test data: delete from storage.objects where name like '%/dev/%')

import { getContext } from './context.js';
import { getSupabase } from './supabase.js';
import config from '../../mushy.config.json';

const useR2 = import.meta.env.VITE_USE_R2 === 'true';
const slug = config.slug;
// __VERCEL_ENV__ build-time constant (vite.config.js define) — đồng bộ với
// supabase.js + realtime.js. Trước dùng import.meta.env.VITE_APP_ENV nhưng
// vite.config.js KHÔNG define → undefined → fallback 'prod' → file dev
// upload vào path KHÔNG có dev/ prefix → trộn với file prod.
// eslint-disable-next-line no-undef
const vercelEnv = typeof __VERCEL_ENV__ !== 'undefined' ? __VERCEL_ENV__ : 'development';
const BUCKET = `miniapp-${slug}`;
const ENV_PREFIX = vercelEnv === 'production' ? '' : 'dev/';

const urlCache = new Map(); // objectKey → { url, expiresAt }

export async function upload(file, folder = 'uploads') {
  const ctx = getContext();
  const ext = (file.name || 'bin').split('.').pop();
  // Path: {workspace_id}/[dev/]{folder}/{uuid}.{ext}
  const objectKey = `${ctx.workspaceId}/${ENV_PREFIX}${folder}/${cryptoUuid()}.${ext}`;

  if (!useR2) {
    const { error } = await getSupabase().storage.from(BUCKET).upload(objectKey, file);
    if (error) throw error;
    return objectKey;
  }
  // R2: gọi Edge Function `storage-upload` để lấy presigned PUT URL
  const sb = getSupabase();
  const { data, error } = await sb.functions.invoke('storage-upload', {
    body: { objectKey, contentType: file.type },
  });
  if (error) throw error;
  const putRes = await fetch(data.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  });
  if (!putRes.ok) throw new Error(`R2 upload failed: ${putRes.status}`);
  return objectKey;
}

export async function getViewUrl(objectKey) {
  const cached = urlCache.get(objectKey);
  if (cached && cached.expiresAt > Date.now()) return cached.url;

  let url;
  if (!useR2) {
    const { data, error } = await getSupabase()
      .storage.from(BUCKET)
      .createSignedUrl(objectKey, 3600);
    if (error) throw error;
    url = data.signedUrl;
  } else {
    const { data, error } = await getSupabase().functions.invoke('storage-view', {
      body: { objectKey },
    });
    if (error) throw error;
    url = data.url;
  }
  urlCache.set(objectKey, { url, expiresAt: Date.now() + 3500 * 1000 });
  return url;
}

function cryptoUuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

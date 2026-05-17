#!/usr/bin/env node
/**
 * Insert sample data vào schema app_{slug} bằng JWT của user đang dev.
 * Đổi nội dung phù hợp với mini-app của bạn.
 */
import './_node-shim.js';
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = join(__dirname, '..', 'mushy.config.json');
if (!existsSync(configPath)) {
  console.error('❌ Thiếu mushy.config.json ở root repo.');
  process.exit(1);
}
const config = JSON.parse(readFileSync(configPath, 'utf8'));

const URL = config.supabase?.url;
const ANON = config.supabase?.anonKey;
const SLUG = config.slug;
const TOKEN = process.env.VITE_DEV_TOKEN;
const WS = process.env.VITE_DEV_WORKSPACE_ID;
const UID = process.env.VITE_DEV_USER_ID;
// Local dev mặc định hit schema _dev (Vercel sẽ override khi build)
const ENV = process.env.VITE_APP_ENV || 'dev';
const SCHEMA = ENV === 'dev' ? `app_${SLUG}_dev` : `app_${SLUG}`;

if (!URL || !ANON || !TOKEN || !WS || !UID) {
  console.error('Thiếu config / env. Đảm bảo mushy.config.json có URL+anon+slug và đã chạy `npm run dev:setup`.');
  process.exit(1);
}

console.log(`Seeding vào schema ${SCHEMA}...`);

const sb = createClient(URL, ANON, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { Authorization: `Bearer ${TOKEN}` } },
  db: { schema: SCHEMA },
});

const samples = [
  { title: 'Đọc CLAUDE.md', done: true,  workspace_id: WS, created_by: UID },
  { title: 'Chạy npm run dev', done: false, workspace_id: WS, created_by: UID },
  { title: 'Build mini-app đầu tiên', done: false, workspace_id: WS, created_by: UID },
];

const { data, error } = await sb.from('tasks').insert(samples).select();
if (error) { console.error('❌', error.message); process.exit(1); }
console.log(`✓ Inserted ${data.length} sample tasks vào ${SCHEMA}.tasks`);

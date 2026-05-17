#!/usr/bin/env node
/**
 * Một lần setup môi trường dev cho mini-app:
 *   1. Login Mushy account qua MAGIC LINK / OTP (không cần password — Mushy
 *      đã bỏ password auth). Email → server gửi mã OTP 6 chữ số → user nhập
 *      → verifyOtp → có session.
 *   2. Chọn workspace (đã tạo trên Mushy app — auto-tạo "Dev Workspace" nếu chưa có)
 *   3. List migrations (apply qua Admin Portal Reviewer, KHÔNG SQL Editor)
 *   4. Ghi VITE_DEV_TOKEN, VITE_DEV_WORKSPACE_ID, VITE_DEV_USER_ID, VITE_DEV_ROLE vào .env
 *
 * KHÔNG hỗ trợ password flow nữa (Mushy bỏ password từ 2026-05-12). Old user
 * có password vẫn dùng email OTP cùng email — Supabase auto-link, không lose data.
 */

import './_node-shim.js';
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const envPath = join(root, '.env');
const configPath = join(root, 'mushy.config.json');

if (!existsSync(configPath)) {
  console.error('❌ Thiếu mushy.config.json ở root repo.');
  process.exit(1);
}
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const SUPABASE_URL = config.supabase?.url;
const ANON_KEY = config.supabase?.anonKey;
const SLUG = config.slug;

if (!SUPABASE_URL || !ANON_KEY || !SLUG) {
  console.error('❌ mushy.config.json thiếu slug / supabase.url / supabase.anonKey.');
  process.exit(1);
}
if (SLUG.includes('REPLACE_WITH')) {
  console.error('❌ mushy.config.json còn placeholder slug "%s".', SLUG);
  console.error('   Đổi sang slug được Mushy admin cấp (vd "expense", "crm"...) trước khi setup.');
  process.exit(1);
}
if (!/^[a-z0-9][a-z0-9_-]{2,40}$/.test(SLUG)) {
  console.error('❌ Slug "%s" không hợp lệ. Phải lowercase 3-41 ký tự [a-z0-9_-].', SLUG);
  process.exit(1);
}
if (ANON_KEY.includes('REPLACE_WITH')) {
  console.error('❌ mushy.config.json còn placeholder anon key. Đặt giá trị thật của Mushy Supabase.');
  process.exit(1);
}
console.log(`Slug: ${SLUG}`);
console.log(`Supabase: ${SUPABASE_URL}\n`);

function makeClient(token) {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
  });
}

let sb = makeClient();
const rl = readline.createInterface({ input, output });

async function main() {
  console.log('— Mini-app dev setup —\n');

  // 1. Login qua OTP (magic link). Mushy đã bỏ password — flow chuẩn:
  //    a. signInWithOtp({ email, shouldCreateUser: false }) → server gửi mail OTP
  //       (shouldCreateUser=false vì user phải đăng ký trên app Mushy trước —
  //        signup từ CLI script sẽ tạo orphan account, không có hồ sơ trong app)
  //    b. User mở mail, lấy mã 6 chữ số, paste vào terminal
  //    c. verifyOtp({ email, token, type: 'email' }) → có session.access_token
  console.log('Bước 1/3: Đăng nhập qua email OTP');
  console.log('  (Mushy đã bỏ password — chỉ cần email, sẽ nhận mã OTP qua mail)\n');
  const email = (await rl.question('Email Mushy: ')).trim().toLowerCase();
  if (!email || !email.includes('@')) {
    console.error('❌ Email không hợp lệ.');
    process.exit(1);
  }

  console.log('Đang gửi mã OTP tới', email, '...');
  const { error: otpErr } = await sb.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false },
  });
  if (otpErr) {
    console.error('❌ Gửi OTP thất bại:', otpErr.message);
    if (/not found|signups not allowed/i.test(otpErr.message)) {
      console.error('   → Email chưa đăng ký trên Mushy. Mở app Mushy → Đăng ký với email này trước.');
    }
    process.exit(1);
  }
  console.log('✓ Đã gửi. Kiểm tra mail (kể cả Spam) — mã 6 chữ số.');
  console.log('  (Token hết hạn sau 1 giờ. Nếu cần gửi lại, chạy lại lệnh này.)\n');

  const token = (await rl.question('Mã OTP 6 chữ số: ')).trim();
  if (!/^\d{6}$/.test(token)) {
    console.error('❌ Mã OTP phải đúng 6 chữ số.');
    process.exit(1);
  }

  const { data: auth, error: verifyErr } = await sb.auth.verifyOtp({
    email,
    token,
    type: 'email',
  });
  if (verifyErr) {
    console.error('❌ Xác minh OTP thất bại:', verifyErr.message);
    console.error('   → Mã sai hoặc đã hết hạn. Chạy lại lệnh để nhận mã mới.');
    process.exit(1);
  }
  console.log('✓ Logged in as', auth.user.email);

  // Re-create client với token explicit để đảm bảo PostgREST nhận JWT
  sb = makeClient(auth.session.access_token);

  // 2. Workspace
  const { data: ws, error: wsErr } = await sb
    .from('workspace_members')
    .select('workspace_id, role, workspaces(name, slug)')
    .eq('user_id', auth.user.id);
  if (wsErr) { console.error('❌ List workspaces failed:', wsErr.message); process.exit(1); }

  let workspaceId, role;
  if (!ws || ws.length === 0) {
    console.log('Bạn chưa có workspace nào. Tạo demo workspace...');
    const { data: newId, error: cErr } = await sb.rpc('create_workspace', {
      p_name: 'Dev Workspace',
      p_slug: `dev-${Date.now()}`,
    });
    if (cErr) { console.error('❌ Create workspace:', cErr.message); process.exit(1); }
    workspaceId = newId;
    role = 'owner';
  } else {
    ws.forEach((w, i) => console.log(`  ${i + 1}. ${w.workspaces?.name} (${w.role})`));
    const idx = parseInt(await rl.question('Chọn workspace # (default 1): ') || '1', 10) - 1;
    workspaceId = ws[idx].workspace_id;
    role = ws[idx].role;
  }
  console.log('✓ Workspace:', workspaceId, '—', role);

  // 3. Migrations — chỉ list, áp tay (cần service_role; chuyển sang Admin Portal sau)
  const migDir = join(root, 'migrations');
  if (existsSync(migDir)) {
    const files = readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
    if (files.length) {
      console.log('\nMigrations tìm thấy (apply qua Admin Portal Reviewer):');
      files.forEach((f) => console.log('  -', f));
    }
  }

  // 4. Ghi .env
  const lines = existsSync(envPath) ? readFileSync(envPath, 'utf8').split('\n') : [];
  const merge = { ...Object.fromEntries(
    lines.filter(Boolean).filter((l) => !l.startsWith('#')).map((l) => l.split('=', 2))
  ),
    VITE_DEV_TOKEN: auth.session.access_token,
    VITE_DEV_WORKSPACE_ID: workspaceId,
    VITE_DEV_USER_ID: auth.user.id,
    VITE_DEV_ROLE: role,
  };
  // Giữ comment + key chưa đụng tới
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    if (!line || line.startsWith('#')) { out.push(line); continue; }
    const k = line.split('=', 1)[0];
    if (k in merge) { out.push(`${k}=${merge[k]}`); seen.add(k); }
    else out.push(line);
  }
  for (const k of Object.keys(merge)) {
    if (!seen.has(k)) out.push(`${k}=${merge[k]}`);
  }
  writeFileSync(envPath, out.join('\n'));
  console.log('\n✓ Đã ghi VITE_DEV_* vào .env');

  await ensureMainBranch();

  console.log('\nXong! Chạy `npm run dev` để start.\n');
  rl.close();
}

function git(args, opts = {}) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', ...opts });
}

async function ensureMainBranch() {
  if (!existsSync(join(root, '.git'))) return;

  const head = git(['symbolic-ref', '--short', 'HEAD']);
  if (head.status !== 0) return;
  const currentBranch = head.stdout.trim();
  if (currentBranch === 'main') return;

  const localMain = git(['rev-parse', '--verify', '--quiet', 'refs/heads/main']).status === 0;
  const hasOrigin = git(['remote', 'get-url', 'origin']).status === 0;
  const remoteMain = hasOrigin
    && git(['ls-remote', '--exit-code', '--heads', 'origin', 'main']).status === 0;
  if (localMain || remoteMain) return;

  console.log('');
  console.log(`⚠️  Repo chưa có branch \`main\` (đang ở \`${currentBranch}\`).`);
  console.log('   Khi connect Vercel, Vercel auto-promote branch duy nhất thành Production Branch.');
  console.log(`   → mini-app build trên \`${currentBranch}\` sẽ có VERCEL_ENV=production`);
  console.log('   → query schema `app_{slug}` (PROD) thay vì `app_{slug}_dev`');
  console.log('   → seed data dev không hiện trong Mushy dev_mode → app trống.');
  console.log('   → Tạo branch `main` placeholder trước khi connect Vercel.');

  if (!hasOrigin) {
    console.log('');
    console.log('   ℹ️  Repo chưa có remote `origin`. Setup remote rồi chạy lệnh:');
    console.log('     git worktree add ../tmp-main --orphan main');
    console.log('     echo \'<!doctype html><meta charset="utf-8"><title>🚧</title><body><h1>🚧 Đang phát triển</h1></body>\' > ../tmp-main/index.html');
    console.log('     (cd ../tmp-main && git add index.html && git commit -m "🚧 Placeholder main")');
    console.log('     (cd ../tmp-main && git push -u origin main)');
    console.log('     git worktree remove ../tmp-main');
    return;
  }

  const ans = (await rl.question('\n   Auto-tạo placeholder main + push lên origin? (y/N): ')).trim().toLowerCase();
  if (ans !== 'y' && ans !== 'yes') {
    console.log('   Skip. Tự làm khi sẵn sàng.');
    return;
  }

  const worktreeDir = join(root, '..', `tmp-main-${Date.now()}`);
  console.log(`   → git worktree add ${worktreeDir} --orphan main`);
  let r = git(['worktree', 'add', worktreeDir, '--orphan', 'main']);
  if (r.status !== 0) {
    console.log('   ❌ git worktree add failed:', r.stderr.trim());
    console.log('   (Yêu cầu git ≥ 2.42 cho `worktree add --orphan`. Update git hoặc chạy lệnh tay ở trên.)');
    return;
  }

  let pushed = false;
  try {
    writeFileSync(join(worktreeDir, 'index.html'),
      '<!doctype html>\n<meta charset="utf-8">\n<title>🚧 Đang phát triển</title>\n' +
      '<body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#FFF7F8;color:#0F0F12">\n' +
      '  <main style="text-align:center"><h1 style="font-size:3rem;margin:0">🚧</h1>' +
      '<p style="margin-top:1rem;opacity:.7">Đang phát triển</p></main>\n</body>\n');
    r = spawnSync('git', ['add', 'index.html'], { cwd: worktreeDir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error('git add: ' + r.stderr.trim());
    r = spawnSync('git', ['commit', '-m', '🚧 Placeholder main branch'], { cwd: worktreeDir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error('git commit: ' + r.stderr.trim());
    r = spawnSync('git', ['push', '-u', 'origin', 'main'], { cwd: worktreeDir, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('git push exit ' + r.status);
    pushed = true;
    console.log('   ✓ Đã push placeholder `main` lên origin.');
  } catch (e) {
    console.log('   ❌', e.message);
  } finally {
    const rm = git(['worktree', 'remove', '--force', worktreeDir]);
    if (rm.status !== 0) {
      try { rmSync(worktreeDir, { recursive: true, force: true }); } catch {}
    }
    if (pushed) {
      console.log(`   ℹ️  Local \`main\` đã tạo, đang track origin/main. Bạn vẫn ở \`${currentBranch}\`.`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

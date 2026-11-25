import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const PORT = 19000 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'vc-api-'));
const ADMIN_PW = 'api-admin-pass';

const child = spawn(process.execPath, ['server/server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, DATA_DIR, PORT: String(PORT), ADMIN_PASSWORD: ADMIN_PW, AUTH_MODE: 'self' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

let adminCookie = '';
let bobCookie = '';

async function req(method, path, body, cookie = '', headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 空 */ }
  return { status: res.status, data, setCookie: res.headers.getSetCookie ? res.headers.getSetCookie() : [] };
}

function cookieOf(setCookies) {
  const raw = setCookies.find(c => c.startsWith('vc_session='));
  return raw ? raw.split(';')[0] : '';
}

await waitReady();
test.after(() => { child.kill('SIGTERM'); });

test('未登录访问同步接口返回 401', async () => {
  const r = await req('GET', '/api/v1/sync/state?app=prompt-capsule');
  assert.equal(r.status, 401);
});

test('登录：错误密码 401，正确密码拿到会话 Cookie', async () => {
  const bad = await req('POST', '/api/v1/auth/login', { username: 'admin', password: 'nope' });
  assert.equal(bad.status, 401);

  const ok = await req('POST', '/api/v1/auth/login', { username: 'admin', password: ADMIN_PW });
  assert.equal(ok.status, 200);
  adminCookie = cookieOf(ok.setCookie);
  assert.ok(adminCookie.startsWith('vc_session='));

  const me = await req('GET', '/api/v1/auth/me', null, adminCookie);
  assert.equal(me.data.user.username, 'admin');
});

test('同步：push 后 pull 能拿到，旧版本冲突', async () => {
  const now = Date.now();
  const push = await req('POST', '/api/v1/sync/push', {
    app: 'prompt-capsule',
    deviceId: 't1',
    ops: [{ collection: 'docs', id: 'd1', op: 'upsert', data: { id: 'd1', title: 'v1' }, updatedAt: now }],
  }, adminCookie);
  assert.equal(push.status, 200);
  assert.equal(push.data.accepted.length, 1);

  const pull = await req('GET', '/api/v1/sync/pull?app=prompt-capsule&since=0', null, adminCookie);
  assert.equal(pull.data.changes.length, 1);
  assert.equal(pull.data.changes[0].data.title, 'v1');

  const stale = await req('POST', '/api/v1/sync/push', {
    app: 'prompt-capsule',
    deviceId: 't2',
    ops: [{ collection: 'docs', id: 'd1', op: 'upsert', data: { id: 'd1', title: 'old' }, updatedAt: now - 5000 }],
  }, adminCookie);
  assert.equal(stale.data.conflicts.length, 1);
  assert.equal(stale.data.conflicts[0].server.data.title, 'v1');
});

test('数据隔离：bob 看不到 admin 的记录', async () => {
  const created = await req('POST', '/api/v1/admin/users', { username: 'bob', password: 'bobpass12345', role: 'user' }, adminCookie);
  assert.equal(created.status, 200);

  const login = await req('POST', '/api/v1/auth/login', { username: 'bob', password: 'bobpass12345' });
  assert.equal(login.status, 200);
  bobCookie = cookieOf(login.setCookie);

  const state = await req('GET', '/api/v1/sync/state?app=prompt-capsule', null, bobCookie);
  assert.equal(state.data.count, 0);

  const forbidden = await req('GET', '/api/v1/admin/users', null, bobCookie);
  assert.equal(forbidden.status, 403);
});

test('备份：导出、merge 导入、replace 导入', async () => {
  const exp = await req('GET', '/api/v1/backup/export?app=prompt-capsule', null, adminCookie);
  assert.equal(exp.data.count, 1);
  assert.equal(exp.data.records[0].id, 'd1');

  const merge = await req('POST', '/api/v1/backup/import', {
    app: 'prompt-capsule',
    mode: 'merge',
    records: [
      { app: 'prompt-capsule', collection: 'docs', id: 'd1', data: { id: 'd1', title: 'ignored' } },
      { app: 'prompt-capsule', collection: 'docs', id: 'd2', data: { id: 'd2', title: 'from backup' } },
    ],
  }, adminCookie);
  assert.equal(merge.data.imported, 1);
  assert.equal(merge.data.skipped, 1);

  const replace = await req('POST', '/api/v1/backup/import', {
    app: 'prompt-capsule',
    mode: 'replace',
    records: [{ app: 'prompt-capsule', collection: 'docs', id: 'd9', data: { id: 'd9', title: 'only' } }],
  }, adminCookie);
  assert.equal(replace.data.imported, 1);

  const state = await req('GET', '/api/v1/sync/state?app=prompt-capsule', null, adminCookie);
  assert.equal(state.data.count, 1);
});

test('历史与回滚：能读到版本并恢复到旧内容', async () => {
  const now = Date.now();
  await req('POST', '/api/v1/sync/push', {
    app: 'prompt-capsule',
    deviceId: 't1',
    ops: [{ collection: 'docs', id: 'h1', op: 'upsert', data: { id: 'h1', title: 'one' }, updatedAt: now }],
  }, adminCookie);
  await req('POST', '/api/v1/sync/push', {
    app: 'prompt-capsule',
    deviceId: 't1',
    ops: [{ collection: 'docs', id: 'h1', op: 'upsert', data: { id: 'h1', title: 'two' }, updatedAt: now + 1000 }],
  }, adminCookie);

  const hist = await req('GET', '/api/v1/sync/history?app=prompt-capsule&collection=docs&id=h1', null, adminCookie);
  assert.ok(hist.data.versions.length >= 2);
  const first = hist.data.versions[hist.data.versions.length - 1];

  const restore = await req('POST', '/api/v1/sync/restore', {
    app: 'prompt-capsule', collection: 'docs', id: 'h1', seq: first.seq,
  }, adminCookie);
  assert.equal(restore.status, 200);

  const pull = await req('GET', '/api/v1/sync/pull?app=prompt-capsule&since=0', null, adminCookie);
  const h1 = pull.data.changes.filter(c => c.id === 'h1').pop();
  assert.equal(h1.data.title, 'one');
});

test('会话：列出并踢下线', async () => {
  const list = await req('GET', '/api/v1/auth/sessions', null, adminCookie);
  assert.ok(list.data.sessions.length >= 1);
  const target = list.data.sessions.find(s => !s.revoked);
  const revoke = await req('DELETE', '/api/v1/auth/sessions/' + target.id, null, adminCookie);
  assert.equal(revoke.data.ok, true);

  const me = await req('GET', '/api/v1/auth/me', null, adminCookie);
  assert.equal(me.data.user, null);
});

test('管理员设置：切换账号模式与邀请码', async () => {
  // 上面的会话已被踢掉，重新登录
  const login = await req('POST', '/api/v1/auth/login', { username: 'admin', password: ADMIN_PW });
  adminCookie = cookieOf(login.setCookie);

  const saved = await req('POST', '/api/v1/admin/settings', {
    mode: 'public', registrationOpen: true, inviteCode: 'INV-1',
  }, adminCookie);
  assert.equal(saved.data.mode, 'public');
  assert.equal(saved.data.inviteRequired, true);

  const badInvite = await req('POST', '/api/v1/auth/register', { username: 'carl', password: 'carlpass12345', invite: 'wrong' });
  assert.equal(badInvite.status, 403);

  const good = await req('POST', '/api/v1/auth/register', { username: 'carl', password: 'carlpass12345', invite: 'INV-1' });
  assert.equal(good.status, 200);

  await req('POST', '/api/v1/admin/settings', { mode: 'self', registrationOpen: false, inviteCode: '' }, adminCookie);
});

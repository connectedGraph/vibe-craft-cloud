import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 必须在 import auth/db 之前指定临时数据目录（db.mjs 在模块加载时读取）
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'vc-unit-'));
process.env.ADMIN_PASSWORD = 'unit-admin-pass';

const auth = await import('../server/auth.mjs');
const { getDb } = await import('../server/db.mjs');

getDb();
auth.ensureSeedUser();

test('scrypt 密码哈希：正确密码通过，错误密码失败', () => {
  const hash = auth.hashPassword('correct horse battery staple');
  assert.ok(hash.startsWith('scrypt$'));
  assert.equal(auth.verifyPassword('correct horse battery staple', hash), true);
  assert.equal(auth.verifyPassword('wrong password', hash), false);
  assert.equal(auth.verifyPassword('x', 'not-a-hash'), false);
});

test('用户：创建、大小写不敏感查找、禁用', () => {
  const u = auth.createUser({ username: 'Alice', password: 'alicepass123' });
  assert.equal(u.username, 'Alice');
  assert.equal(auth.findUser('alice').username, 'Alice');
  assert.throws(() => auth.createUser({ username: 'alice', password: 'whatever123' }));

  auth.setDisabled('alice', true);
  const after = auth.findUser('alice');
  assert.equal(after.disabled, 1);
  assert.equal(auth.userFromToken(null), null);
  auth.setDisabled('alice', false);
});

test('会话：签发有效，吊销后失效', () => {
  const user = auth.findUser('alice');
  const token = auth.createSession(user, { days: 1, device: 'unit-test', ip: '127.0.0.1' });

  assert.equal(auth.userFromToken(token).username, 'Alice');
  const sessions = auth.listSessions('Alice');
  assert.equal(sessions.length, 1);

  const jti = auth.jtiOfToken(token);
  assert.ok(jti);
  auth.revokeSessionByJti(jti);
  assert.equal(auth.userFromToken(token), null);
});

test('改密：旧会话全部失效，新会话有效', () => {
  const oldToken = auth.createSession(auth.findUser('alice'), { days: 1 });
  assert.ok(auth.userFromToken(oldToken));

  auth.setPassword('alice', 'newalicepass123', false);
  assert.equal(auth.userFromToken(oldToken), null);

  const newToken = auth.createSession(auth.findUser('alice'), { days: 1 });
  assert.ok(auth.userFromToken(newToken));
});

test('会话管理：按用户吊销单条', () => {
  const user = auth.findUser('alice');
  const t1 = auth.createSession(user, { days: 1 });
  const t2 = auth.createSession(user, { days: 1 });
  // listSessions 按 id DESC，第一条是最新创建的 t2
  const newest = auth.listSessions('Alice').find(s => !s.revoked_at);

  assert.equal(auth.revokeSession('Alice', newest.id), true);
  assert.equal(auth.userFromToken(t2), null);
  assert.ok(auth.userFromToken(t1));
});

test('登录限流：连续失败 5 次后进入锁定', () => {
  const key = '127.0.0.1|rate-test';
  assert.equal(auth.loginRetryAfterMs(key), 0);
  for (let i = 0; i < 4; i++) {
    auth.noteLoginFailure(key);
    assert.equal(auth.loginRetryAfterMs(key), 0);
  }
  auth.noteLoginFailure(key);
  assert.ok(auth.loginRetryAfterMs(key) > 0);

  auth.clearLoginFailures(key);
  assert.equal(auth.loginRetryAfterMs(key), 0);
});

test('长期令牌：只返回一次明文，吊销后失效', () => {
  const { token, id } = auth.createToken('Alice', 'unit');
  assert.ok(token.startsWith(auth.TOKEN_PREFIX));
  assert.equal(auth.verifyToken(token), 'Alice');
  assert.equal(auth.revokeToken('Alice', id), true);
  assert.equal(auth.verifyToken(token), null);
});

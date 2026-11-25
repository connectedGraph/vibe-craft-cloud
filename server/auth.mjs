import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, getDb } from './db.mjs';

/**
 * 应用自己管账号。移植自 words.6767.chat（Term Book）的 Web 端实现：
 *
 * 浏览器：账号密码登录 → JWT 放 HttpOnly Cookie（不放 localStorage；
 *   且 JWT 无法单独吊销，所以 token 里带 pv=改密时间，改密即让旧 token 全部失效）。
 * 脚本：Bearer 长期令牌（api_token 表，存 sha256）。
 *
 * 三种模式（AUTH_MODE，可在管理端运行时切换）：
 *   off    不登录，所有访问都算同一个账号
 *   self   单账号，不开放注册（默认）
 *   public 可注册，数据按账号隔离
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SESSION_COOKIE = 'vc_session';
export const TOKEN_PREFIX = 'vck_';

function str(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

export const authConfig = {
  mode: str('AUTH_MODE', 'self'),
  authSecret: str('AUTH_SECRET', ''),
  sessionHours: num('SESSION_HOURS', 8),
  rememberDays: num('REMEMBER_DAYS', 30),
  adminUser: str('ADMIN_USER', 'admin'),
  adminPassword: str('ADMIN_PASSWORD', '123456'),
  registrationOpen: str('REGISTRATION_OPEN', '1') === '1',
  registrationCode: str('REGISTRATION_CODE', ''),
  trustProxyAuth: str('TRUST_PROXY_AUTH', '') === '1',
  // 兼容旧部署：SYNC_TOKEN 相当于 admin 的长期令牌
  legacyToken: str('SYNC_TOKEN', ''),
};

/* ───────────── 运行时设置 ───────────── */

function metaGet(key) {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function metaSet(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

export function getMode() {
  const v = metaGet('auth_mode') ?? authConfig.mode;
  return v === 'off' || v === 'public' ? v : 'self';
}

export function setMode(mode) {
  metaSet('auth_mode', mode);
}

export function getRegistrationOpen() {
  if (getMode() !== 'public') return false;
  const v = metaGet('registration_open');
  return v === null ? authConfig.registrationOpen : v === '1';
}

export function setRegistrationOpen(open) {
  metaSet('registration_open', open ? '1' : '0');
}

export function getInviteCode() {
  const v = metaGet('invite_code');
  return v === null ? authConfig.registrationCode : v;
}

export function setInviteCode(code) {
  metaSet('invite_code', code);
}

/* ───────────── 密码 ───────────── */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltHex, keyHex] = parts;
  try {
    const expected = Buffer.from(keyHex, 'hex');
    const got = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
    });
    return got.length === expected.length && timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}

export function isDefaultPassword(password) {
  return password === '123456' || password.length < 8;
}

/* ───────────── 会话令牌（JWT HS256） ───────────── */

let cachedSecret = null;

function secret() {
  if (cachedSecret) return cachedSecret;
  if (authConfig.authSecret) return (cachedSecret = authConfig.authSecret);
  const file = join(DATA_DIR, '.auth-secret');
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing) return (cachedSecret = existing);
  } catch { /* 首次运行 */ }
  const generated = randomBytes(48).toString('hex');
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, generated, { mode: 0o600 });
  } catch { /* 只读文件系统就在进程内用 */ }
  return (cachedSecret = generated);
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function hmac(body) {
  return createHmac('sha256', secret()).update(body).digest('base64url');
}

export function signSession(user, days, jti) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({
    sub: user.username,
    role: user.role,
    pv: user.password_changed_at,
    jti,
    iat: now,
    exp: now + Math.round(days * 86400),
  }));
  const unsigned = `${header}.${body}`;
  return `${unsigned}.${hmac(unsigned)}`;
}

/** 创建一条可吊销的会话，返回签好的 JWT。 */
export function createSession(user, { days, device = '', ip = '' }) {
  const jti = randomBytes(18).toString('base64url');
  getDb().prepare(
    'INSERT INTO session (user_id, jti, device, ip, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(user.username, jti, String(device).slice(0, 200), String(ip).slice(0, 64), Date.now(), Date.now());
  return signSession(user, days, jti);
}

function readSession(token) {
  const raw = String(token ?? '').trim();
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const unsigned = `${parts[0]}.${parts[1]}`;
  const expected = hmac(unsigned);
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.sub !== 'string') return null;
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) return null;
  if (typeof payload.jti !== 'string' || !payload.jti) return null;
  return { sub: payload.sub, pv: Number(payload.pv ?? 0), jti: payload.jti };
}

/** 令牌 → 用户。改过密码、被禁用、用户不存在、会话被吊销都算失效。 */
export function userFromToken(token) {
  const payload = readSession(token);
  if (!payload) return null;

  const s = getDb().prepare('SELECT id, revoked_at, last_seen_at FROM session WHERE jti = ?').get(payload.jti);
  if (!s || s.revoked_at != null) return null;

  const user = findUser(payload.sub);
  if (!user || user.disabled) return null;
  if (Number(payload.pv) !== Number(user.password_changed_at)) return null;

  // last_seen 每 5 分钟更新一次，避免每个请求都写库
  const now = Date.now();
  if (!s.last_seen_at || now - s.last_seen_at > 5 * 60 * 1000) {
    getDb().prepare('UPDATE session SET last_seen_at = ? WHERE id = ?').run(now, s.id);
  }
  return user;
}

/* ───────────── 会话管理 ───────────── */

export function listSessions(userId) {
  return getDb().prepare(
    'SELECT id, user_id, device, ip, created_at, last_seen_at, revoked_at FROM session WHERE user_id = ? ORDER BY id DESC',
  ).all(userId);
}

export function revokeSession(userId, id) {
  const info = getDb().prepare(
    'UPDATE session SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
  ).run(Date.now(), id, userId);
  return Number(info.changes) > 0;
}

export function revokeSessionByJti(jti) {
  const info = getDb().prepare('UPDATE session SET revoked_at = ? WHERE jti = ? AND revoked_at IS NULL').run(Date.now(), jti);
  return Number(info.changes) > 0;
}

export function revokeAllSessions(userId, exceptJti = null) {
  const d = getDb();
  if (exceptJti) {
    d.prepare('UPDATE session SET revoked_at = ? WHERE user_id = ? AND jti != ? AND revoked_at IS NULL')
      .run(Date.now(), userId, exceptJti);
  } else {
    d.prepare('UPDATE session SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(Date.now(), userId);
  }
}

export function jtiOfToken(token) {
  const p = readSession(token);
  return p ? p.jti : null;
}

export function sessionMaxAgeSeconds(remember) {
  return remember ? authConfig.rememberDays * 86400 : authConfig.sessionHours * 3600;
}

/* ───────────── Cookie ───────────── */

export function parseCookie(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    if (trimmed.slice(0, eq).trim() === name) return decodeURIComponent(trimmed.slice(eq + 1).trim());
  }
  return null;
}

export function sessionCookie(token, maxAgeSeconds, secure) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`
    + (secure ? '; Secure' : '');
}

export function clearedCookie(secure) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
    + (secure ? '; Secure' : '');
}

/* ───────────── 用户 ───────────── */

const USER_COLUMNS = 'id, username, password_hash, role, disabled, must_change_password, password_changed_at, created_at, last_login_at';

export function findUser(username) {
  if (!username) return null;
  const row = getDb().prepare(`SELECT ${USER_COLUMNS} FROM user WHERE username = ? COLLATE NOCASE`).get(username);
  return row ?? null;
}

export function listUsers() {
  return getDb().prepare(`SELECT ${USER_COLUMNS} FROM user ORDER BY id`).all();
}

export function countUsers() {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM user').get();
  return Number(row.n);
}

export function countAdmins() {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM user WHERE role = 'admin' AND disabled = 0").get();
  return Number(row.n);
}

export function createUser(input) {
  const now = Date.now();
  const username = String(input.username).trim();
  getDb().prepare(
    'INSERT INTO user (username, password_hash, role, disabled, must_change_password, password_changed_at, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)',
  ).run(username, hashPassword(input.password), input.role ?? 'user', input.mustChange ? 1 : 0, now, now);
  const user = findUser(username);
  if (!user) throw new Error('创建账号失败');
  return user;
}

export function setPassword(username, password, mustChange) {
  const now = Date.now();
  const info = getDb().prepare(
    'UPDATE user SET password_hash = ?, must_change_password = ?, password_changed_at = ? WHERE username = ? COLLATE NOCASE',
  ).run(hashPassword(password), mustChange ? 1 : 0, now, username);
  const user = Number(info.changes) > 0 ? findUser(username) : null;
  // 改密后所有旧会话作废；调用方如果要保留当前浏览器登录，需要重新 createSession
  if (user) revokeAllSessions(user.username);
  return user;
}

export function setDisabled(username, disabled) {
  const info = getDb().prepare('UPDATE user SET disabled = ? WHERE username = ? COLLATE NOCASE').run(disabled ? 1 : 0, username);
  return Number(info.changes) > 0;
}

export function touchLogin(username) {
  getDb().prepare('UPDATE user SET last_login_at = ? WHERE username = ? COLLATE NOCASE').run(Date.now(), username);
}

export function clearMustChange(username) {
  getDb().prepare('UPDATE user SET must_change_password = 0 WHERE username = ? COLLATE NOCASE').run(username);
}

/** 启动时确保至少有一个管理员。默认密码会强制首登改密。 */
export function ensureSeedUser() {
  if (countUsers() > 0) return;
  const password = authConfig.adminPassword || '123456';
  const weak = isDefaultPassword(password);
  createUser({ username: authConfig.adminUser || 'admin', password, role: 'admin', mustChange: weak });
  if (weak) {
    console.warn(`[auth] 已创建管理员 ${authConfig.adminUser}，初始密码为默认值，首次登录必须修改`);
  } else {
    console.log(`[auth] 已创建管理员 ${authConfig.adminUser}，密码来自 ADMIN_PASSWORD`);
  }
}

/* ───────────── 登录限流 ───────────── */

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const failures = new Map();

export function loginRetryAfterMs(key) {
  const hit = failures.get(key);
  if (!hit) return 0;
  if (hit.until > Date.now()) return hit.until - Date.now();
  // 只清理「锁定已过期」的记录；还在累计失败次数（until=0, n>0）的不能删，
  // 否则每次登录前查一次就把计数清了，限流永远触发不了。
  if (hit.until > 0) failures.delete(key);
  return 0;
}

export function noteLoginFailure(key) {
  const hit = failures.get(key) ?? { n: 0, until: 0 };
  hit.n += 1;
  if (hit.n >= LOGIN_MAX_FAILURES) {
    hit.n = 0;
    hit.until = Date.now() + LOGIN_WINDOW_MS;
  }
  failures.set(key, hit);
  if (failures.size > 5000) {
    const now = Date.now();
    for (const [k, v] of failures) if (v.until <= now && v.n === 0) failures.delete(k);
  }
}

export function clearLoginFailures(key) {
  failures.delete(key);
}

/* ───────────── API 长期令牌 ───────────── */

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function createToken(userId, name = 'script') {
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const info = getDb().prepare(
    'INSERT INTO api_token (user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)',
  ).run(userId, name, tokenHash(token), Date.now());
  return { id: Number(info.lastInsertRowid), token };
}

export function listTokens(userId) {
  return getDb()
    .prepare('SELECT id, user_id, name, created_at, last_used_at, revoked_at FROM api_token WHERE user_id = ? ORDER BY id DESC')
    .all(userId);
}

export function revokeToken(userId, id) {
  const info = getDb()
    .prepare('UPDATE api_token SET revoked_at = ? WHERE user_id = ? AND id = ? AND revoked_at IS NULL')
    .run(Date.now(), userId, id);
  return Number(info.changes) > 0;
}

/** 校验 Bearer token，返回 userId；无效返回 null。 */
export function verifyToken(raw) {
  const token = String(raw ?? '').trim();
  if (!token.startsWith(TOKEN_PREFIX) || token.length < 20) return null;

  const d = getDb();
  const row = d.prepare('SELECT id, user_id, token_hash, revoked_at FROM api_token WHERE token_hash = ?')
    .get(tokenHash(token));
  if (!row || row.revoked_at != null) return null;

  const a = Buffer.from(row.token_hash, 'hex');
  const b = Buffer.from(tokenHash(token), 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  d.prepare('UPDATE api_token SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id);
  return row.user_id;
}

/* ───────────── 统一身份解析 ───────────── */

/**
 * 身份来源按优先级：
 *   1. TRUST_PROXY_AUTH=1 且带 X-Auth-User（已有统一登录网关）
 *   2. Authorization: Bearer —— vck_ 长期令牌，或 JWT（脚本）
 *   3. Cookie vc_session（浏览器 JWT）
 *   4. AUTH_MODE=off：所有访问都算 admin
 */
export function identityOf(req) {
  if (authConfig.trustProxyAuth) {
    const name = String(req.headers['x-auth-user'] ?? '').trim();
    if (name) {
      let user = findUser(name);
      if (!user) {
        user = createUser({
          username: name,
          password: randomBytes(24).toString('hex'),
          role: countUsers() === 0 ? 'admin' : 'user',
        });
      }
      return user.disabled ? null : { username: user.username, role: user.role, user };
    }
  }

  const auth = String(req.headers.authorization ?? '');
  if (auth.toLowerCase().startsWith('bearer ')) {
    const raw = auth.slice(7).trim();
    // 兼容旧部署：环境变量里的 SYNC_TOKEN 视为 admin 的长期令牌
    if (authConfig.legacyToken && raw === authConfig.legacyToken) {
      const admin = findUser(authConfig.adminUser || 'admin');
      if (admin && !admin.disabled) return { username: admin.username, role: admin.role, user: admin };
    }
    if (raw.startsWith(TOKEN_PREFIX)) {
      const uid = verifyToken(raw);
      const user = uid ? findUser(uid) : null;
      if (user && !user.disabled) return { username: user.username, role: user.role, user };
    } else {
      const user = userFromToken(raw);
      if (user) return { username: user.username, role: user.role, user };
    }
  }

  const fromCookie = userFromToken(parseCookie(req.headers.cookie, SESSION_COOKIE));
  if (fromCookie) return { username: fromCookie.username, role: fromCookie.role, user: fromCookie };

  if (getMode() === 'off') {
    const admin = findUser(authConfig.adminUser || 'admin');
    if (admin && !admin.disabled) return { username: admin.username, role: admin.role, user: admin };
  }
  return null;
}

export function userPayload(user) {
  return { username: user.username, role: user.role, mustChangePassword: user.must_change_password === 1 };
}

export function authPayload(identity) {
  const admin = findUser(authConfig.adminUser || 'admin');
  return {
    mode: getMode(),
    registrationOpen: getRegistrationOpen(),
    inviteRequired: getInviteCode().length > 0,
    trustProxyAuth: authConfig.trustProxyAuth,
    // 只有管理员确实还在用初始密码时才提示「默认密码 123456」
    defaultPasswordHint: !!(admin && admin.must_change_password === 1),
    user: identity ? userPayload(identity.user) : null,
  };
}

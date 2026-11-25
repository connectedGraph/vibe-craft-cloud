import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { getDb, DB_PATH } from './db.mjs';
import {
  authConfig, authPayload, clearedCookie, clearLoginFailures, createSession, createToken,
  createUser, ensureSeedUser, findUser, getInviteCode, getMode, getRegistrationOpen,
  identityOf, jtiOfToken, listSessions, listTokens, listUsers, loginRetryAfterMs, noteLoginFailure,
  parseCookie, revokeSession, revokeSessionByJti, revokeToken, SESSION_COOKIE, sessionCookie, sessionMaxAgeSeconds,
  setDisabled, setInviteCode, setMode, setPassword, setRegistrationOpen, touchLogin, userPayload,
  verifyPassword,
} from './auth.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 8792);
const HOST = process.env.HOST || '127.0.0.1';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const MAX_BODY = 8 * 1024 * 1024;
const MAX_OPS = 500;
const MAX_PULL = 1000;
const CLOCK_SKEW = 24 * 60 * 60 * 1000;

const db = getDb();
ensureSeedUser();

/* ───────────── 基础工具 ───────────── */

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function corsHeaders(req) {
  const origin = String(req.headers.origin ?? '');
  if (!origin) return {};
  const allowed = ALLOWED_ORIGINS.includes('*') ? '*' : (ALLOWED_ORIGINS.includes(origin) ? origin : '');
  if (!allowed) return {};
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'payload_too_large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolvePromise(raw ? JSON.parse(raw) : {});
      } catch { reject(new HttpError(400, 'invalid_json')); }
    });
    req.on('error', reject);
  });
}

function isSecure(req) {
  return (req.socket && req.socket.encrypted === true)
    || String(req.headers['x-forwarded-proto'] ?? '') === 'https';
}

function clientIp(req) {
  return String(req.headers['x-real-ip'] ?? '').trim()
    || String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
    || req.socket.remoteAddress
    || 'unknown';
}

function normalizeUpdatedAt(value, now) {
  if (!Number.isFinite(value) || value <= 0) return now;
  if (value > now + CLOCK_SKEW) return now;
  if (value < now - CLOCK_SKEW) return now - CLOCK_SKEW;
  return Math.floor(value);
}

const NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;
function requireName(value, field) {
  if (typeof value !== 'string' || !NAME_RE.test(value)) throw new HttpError(400, `bad_${field}`);
  return value;
}

function safeParse(text) {
  if (text === null || text === undefined) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/* ───────────── 鉴权 ───────────── */

const PUBLIC_PATHS = new Set(['/healthz', '/api/v1/health', '/api/v1/auth/me', '/api/v1/auth/login',
  '/api/v1/auth/logout', '/api/v1/auth/register', '/api/v1/auth/password']);

function setSession(res, req, user, remember) {
  const maxAge = sessionMaxAgeSeconds(remember);
  const token = createSession(user, {
    days: maxAge / 86400,
    device: String(req.headers['user-agent'] || '').slice(0, 200),
    ip: clientIp(req),
  });
  res.setHeader('Set-Cookie', sessionCookie(token, maxAge, isSecure(req)));
}

/* ───────────── 同步 ───────────── */

const stmts = {
  getRecord: db.prepare('SELECT * FROM records WHERE user_id = ? AND app = ? AND collection = ? AND id = ?'),
  maxSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM changes WHERE user_id = ? AND app = ?'),
  countRecords: db.prepare('SELECT COUNT(*) AS n FROM records WHERE user_id = ? AND app = ? AND deleted = 0'),
  lastUpdated: db.prepare('SELECT COALESCE(MAX(updated_at), 0) AS t FROM records WHERE user_id = ? AND app = ?'),
  upsertRecord: db.prepare(`
    INSERT INTO records (user_id, app, collection, id, data, updated_at, deleted, seq, device_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, app, collection, id) DO UPDATE SET
      data = excluded.data,
      updated_at = excluded.updated_at,
      deleted = excluded.deleted,
      seq = excluded.seq,
      device_id = excluded.device_id
  `),
  insertChange: db.prepare(`
    INSERT INTO changes (user_id, app, collection, id, data, updated_at, deleted, device_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  lastRowId: db.prepare('SELECT last_insert_rowid() AS s'),
  pullChanges: db.prepare(`
    SELECT c.collection, c.id, c.data, c.updated_at, c.seq, c.deleted
    FROM changes c
    JOIN records r
      ON r.user_id = c.user_id AND r.app = c.app AND r.collection = c.collection AND r.id = c.id
    WHERE c.user_id = ? AND c.app = ? AND c.seq > ? AND r.seq = c.seq
    ORDER BY c.seq ASC
    LIMIT ?
  `),
};

function handleState(userId, url) {
  const app = requireName(url.searchParams.get('app'), 'app');
  return {
    ok: true,
    seq: stmts.maxSeq.get(userId, app).seq,
    count: stmts.countRecords.get(userId, app).n,
    updatedAt: stmts.lastUpdated.get(userId, app).t,
  };
}

function handlePull(userId, url) {
  const app = requireName(url.searchParams.get('app'), 'app');
  const since = Math.max(0, Number(url.searchParams.get('since') || 0) | 0);
  const limit = Math.min(MAX_PULL, Math.max(1, Number(url.searchParams.get('limit') || 500) | 0));

  const rows = stmts.pullChanges.all(userId, app, since, limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    ok: true,
    now: page.length ? page[page.length - 1].seq : Math.max(since, stmts.maxSeq.get(userId, app).seq),
    hasMore,
    changes: page.map(r => ({
      collection: r.collection,
      id: r.id,
      op: r.deleted ? 'delete' : 'upsert',
      data: r.deleted ? null : safeParse(r.data),
      updatedAt: r.updated_at,
      seq: r.seq,
    })),
  };
}

function handlePush(userId, body) {
  const app = requireName(body.app, 'app');
  const deviceId = typeof body.deviceId === 'string' ? body.deviceId.slice(0, 64) : 'unknown';
  if (!Array.isArray(body.ops)) throw new HttpError(400, 'bad_ops');
  if (body.ops.length === 0) return { ok: true, now: stmts.maxSeq.get(userId, app).seq, accepted: [], conflicts: [] };
  if (body.ops.length > MAX_OPS) throw new HttpError(400, 'too_many_ops');

  const now = Date.now();
  const accepted = [];
  const conflicts = [];

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const raw of body.ops) {
      const collection = requireName(raw.collection, 'collection');
      const id = requireName(raw.id, 'id');
      const op = raw.op === 'delete' ? 'delete' : 'upsert';
      const updatedAt = normalizeUpdatedAt(Number(raw.updatedAt), now);
      const deleted = op === 'delete' ? 1 : 0;
      const data = deleted ? null : (raw.data === undefined ? null : JSON.stringify(raw.data));

      const existing = stmts.getRecord.get(userId, app, collection, id);
      if (existing && existing.updated_at >= updatedAt) {
        const sameContent = deleted ? !!existing.deleted : (!existing.deleted && existing.data === data);
        if (sameContent) {
          accepted.push({ collection, id, seq: existing.seq, unchanged: true });
          continue;
        }
        conflicts.push({
          collection, id,
          server: {
            data: existing.deleted ? null : safeParse(existing.data),
            updatedAt: existing.updated_at,
            deleted: !!existing.deleted,
            seq: existing.seq,
          },
        });
        continue;
      }

      stmts.insertChange.run(userId, app, collection, id, data, updatedAt, deleted, deviceId, now);
      const realSeq = stmts.lastRowId.get().s;
      stmts.upsertRecord.run(userId, app, collection, id, data, updatedAt, deleted, realSeq, deviceId);
      accepted.push({ collection, id, seq: realSeq });
    }
    db.exec('COMMIT');
    return { ok: true, now: stmts.maxSeq.get(userId, app).seq, accepted, conflicts };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

/* ───────────── 鉴权路由 ───────────── */

function handleAuthMe(ctx) {
  return authPayload(ctx.identity);
}

async function handleLogin(ctx) {
  if (getMode() === 'off') throw new HttpError(400, 'anonymous_mode');
  const body = await ctx.body();
  const username = String(body.username ?? '').trim();
  const password = String(body.password ?? '');
  const remember = body.remember === true || String(body.remember) === '1';
  if (!username || !password) throw new HttpError(400, 'missing_credentials');

  const key = `${clientIp(ctx.req)}|${username.toLowerCase()}`;
  const retry = loginRetryAfterMs(key);
  if (retry > 0) {
    const err = new HttpError(429, 'too_many_attempts');
    err.retryAfter = Math.ceil(retry / 1000);
    throw err;
  }

  const user = findUser(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    noteLoginFailure(key);
    throw new HttpError(401, 'invalid_credentials');
  }
  if (user.disabled) throw new HttpError(403, 'account_disabled');

  clearLoginFailures(key);
  touchLogin(user.username);
  setSession(ctx.res, ctx.req, user, remember);
  return { ok: true, user: userPayload(user) };
}

async function handleRegister(ctx) {
  if (getMode() !== 'public' || !getRegistrationOpen()) throw new HttpError(403, 'registration_closed');
  const body = await ctx.body();
  const username = String(body.username ?? '').trim();
  const password = String(body.password ?? '');
  const invite = String(body.invite ?? '').trim();

  const code = getInviteCode();
  if (code && invite !== code) throw new HttpError(403, 'bad_invite_code');
  if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) throw new HttpError(400, 'bad_username');
  if (password.length < 8) throw new HttpError(400, 'weak_password');
  if (findUser(username)) throw new HttpError(409, 'username_taken');

  const user = createUser({ username, password, role: 'user' });
  touchLogin(user.username);
  setSession(ctx.res, ctx.req, user, false);
  return { ok: true, user: userPayload(user) };
}

async function handleChangePassword(ctx) {
  if (!ctx.identity) throw new HttpError(401, 'unauthenticated');
  const body = await ctx.body();
  const current = String(body.current ?? '');
  const next = String(body.next ?? '');
  if (next.length < 8) throw new HttpError(400, 'weak_password');
  if (next === '123456') throw new HttpError(400, 'default_password');
  if (next === current) throw new HttpError(400, 'same_password');

  const forced = ctx.identity.user.must_change_password === 1;
  if (!forced && !verifyPassword(current, ctx.identity.user.password_hash)) {
    throw new HttpError(401, 'wrong_password');
  }
  if (forced && current && !verifyPassword(current, ctx.identity.user.password_hash)) {
    throw new HttpError(401, 'wrong_password');
  }

  const updated = setPassword(ctx.identity.username, next, false);
  if (!updated) throw new HttpError(500, 'password_update_failed');
  setSession(ctx.res, ctx.req, updated, false);
  return { ok: true, user: userPayload(updated) };
}

/* ───────────── 管理端 ───────────── */

function publicUser(u) {
  return {
    username: u.username,
    role: u.role,
    disabled: u.disabled === 1,
    mustChangePassword: u.must_change_password === 1,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  };
}

function handleAdminUsers(ctx) {
  if (ctx.method === 'GET') return { ok: true, users: listUsers().map(publicUser) };

  return (async () => {
    const body = await ctx.body();
    const username = String(body.username ?? '').trim();
    const password = String(body.password ?? '');
    const role = body.role === 'admin' ? 'admin' : 'user';
    if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) throw new HttpError(400, 'bad_username');
    if (password.length < 8) throw new HttpError(400, 'weak_password');
    if (findUser(username)) throw new HttpError(409, 'username_taken');
    const user = createUser({ username, password, role, mustChange: false });
    return { ok: true, user: publicUser(user) };
  })();
}

/* ───────────── 路由表 ───────────── */

const routes = [];
function route(method, pattern, handler, opts = {}) {
  routes.push({ method, pattern, handler, ...opts });
}

route('GET', /^\/healthz$/, () => ({ ok: true, version: '2.0.0', time: Date.now() }), { open: true });
route('GET', /^\/api\/v1\/health$/, () => ({ ok: true, version: '2.0.0', time: Date.now() }), { open: true });
route('GET', /^\/api\/v1\/auth\/me$/, handleAuthMe, { open: true });
route('POST', /^\/api\/v1\/auth\/login$/, handleLogin, { open: true });
route('POST', /^\/api\/v1\/auth\/logout$/, (ctx) => {
  const jti = jtiOfToken(parseCookie(ctx.req.headers.cookie, SESSION_COOKIE));
  if (jti) revokeSessionByJti(jti);
  ctx.res.setHeader('Set-Cookie', clearedCookie(isSecure(ctx.req)));
  return { ok: true };
}, { open: true });
route('POST', /^\/api\/v1\/auth\/register$/, handleRegister, { open: true });
route('POST', /^\/api\/v1\/auth\/password$/, handleChangePassword);

function sessionPublic(s) {
  return {
    id: s.id,
    device: s.device,
    ip: s.ip,
    createdAt: s.created_at,
    lastSeenAt: s.last_seen_at,
    revoked: s.revoked_at != null,
  };
}

route('GET', /^\/api\/v1\/auth\/sessions$/, (ctx) => ({
  ok: true,
  sessions: listSessions(ctx.identity.username).map(sessionPublic),
}));
route('DELETE', /^\/api\/v1\/auth\/sessions\/(\d+)$/, (ctx, m) => ({
  ok: revokeSession(ctx.identity.username, Number(m[1])),
}));
route('GET', /^\/api\/v1\/admin\/sessions$/, (ctx) => {
  const username = ctx.url.searchParams.get('username') || ctx.identity.username;
  return { ok: true, sessions: listSessions(username).map(sessionPublic) };
}, { admin: true });
route('DELETE', /^\/api\/v1\/admin\/sessions\/(\d+)$/, (ctx, m) => ({
  ok: revokeSession(ctx.identity.username, Number(m[1])),
}), { admin: true });

route('GET', /^\/api\/v1\/sync\/state$/, (ctx) => handleState(ctx.identity.username, ctx.url));
route('GET', /^\/api\/v1\/sync\/pull$/, (ctx) => handlePull(ctx.identity.username, ctx.url));
route('POST', /^\/api\/v1\/sync\/push$/, async (ctx) => handlePush(ctx.identity.username, await ctx.body()));

/* ───────────── 备份 / 历史 ───────────── */

route('GET', /^\/api\/v1\/backup\/export$/, (ctx) => {
  const app = ctx.url.searchParams.get('app') || '';
  const userId = ctx.identity.username;
  const rows = app
    ? db.prepare('SELECT app, collection, id, data, updated_at, deleted FROM records WHERE user_id = ? AND app = ? ORDER BY app, collection, id').all(userId, app)
    : db.prepare('SELECT app, collection, id, data, updated_at, deleted FROM records WHERE user_id = ? ORDER BY app, collection, id').all(userId);
  return {
    ok: true,
    format: 'vibe-craft-backup-v1',
    exportedAt: Date.now(),
    user: userId,
    app: app || null,
    count: rows.length,
    records: rows.map(r => ({
      app: r.app,
      collection: r.collection,
      id: r.id,
      data: r.deleted ? null : safeParse(r.data),
      updatedAt: r.updated_at,
      deleted: !!r.deleted,
    })),
  };
});

route('POST', /^\/api\/v1\/backup\/import$/, async (ctx) => {
  const body = await ctx.body();
  if (!Array.isArray(body.records)) throw new HttpError(400, 'bad_records');
  if (body.records.length > 20000) throw new HttpError(413, 'too_many_records');
  const mode = body.mode === 'replace' ? 'replace' : 'merge';
  const userId = ctx.identity.username;
  const now = Date.now();
  let imported = 0;
  let skipped = 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    if (mode === 'replace') {
      const apps = [...new Set(body.records.map(r => r.app || body.app).filter(a => typeof a === 'string' && NAME_RE.test(a)))];
      for (const app of apps) {
        const live = db.prepare('SELECT collection, id FROM records WHERE user_id = ? AND app = ? AND deleted = 0').all(userId, app);
        for (const r of live) {
          stmts.insertChange.run(userId, app, r.collection, r.id, null, now, 1, 'restore', now);
          const seq = stmts.lastRowId.get().s;
          stmts.upsertRecord.run(userId, app, r.collection, r.id, null, now, 1, seq, 'restore');
        }
      }
    }

    for (const raw of body.records) {
      const app = requireName(raw.app || body.app, 'app');
      const collection = requireName(raw.collection, 'collection');
      const id = requireName(raw.id, 'id');
      const deleted = raw.deleted ? 1 : 0;

      const existing = stmts.getRecord.get(userId, app, collection, id);
      if (mode === 'merge' && existing) { skipped++; continue; }

      const data = deleted ? null : JSON.stringify(raw.data === undefined ? null : raw.data);
      stmts.insertChange.run(userId, app, collection, id, data, now, deleted, 'restore', now);
      const seq = stmts.lastRowId.get().s;
      stmts.upsertRecord.run(userId, app, collection, id, data, now, deleted, seq, 'restore');
      imported++;
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
  return { ok: true, mode, imported, skipped };
});

route('GET', /^\/api\/v1\/sync\/history$/, (ctx) => {
  const app = requireName(ctx.url.searchParams.get('app'), 'app');
  const collection = requireName(ctx.url.searchParams.get('collection'), 'collection');
  const id = requireName(ctx.url.searchParams.get('id'), 'id');
  const limit = Math.min(200, Math.max(1, Number(ctx.url.searchParams.get('limit') || 50) | 0));
  const rows = db.prepare(`
    SELECT seq, data, updated_at, deleted, device_id, created_at
    FROM changes
    WHERE user_id = ? AND app = ? AND collection = ? AND id = ?
    ORDER BY seq DESC LIMIT ?
  `).all(ctx.identity.username, app, collection, id, limit);
  return {
    ok: true,
    versions: rows.map(r => ({
      seq: r.seq,
      data: r.deleted ? null : safeParse(r.data),
      updatedAt: r.updated_at,
      deleted: !!r.deleted,
      deviceId: r.device_id,
      createdAt: r.created_at,
    })),
  };
});

route('POST', /^\/api\/v1\/sync\/restore$/, async (ctx) => {
  const body = await ctx.body();
  const app = requireName(body.app, 'app');
  const collection = requireName(body.collection, 'collection');
  const id = requireName(body.id, 'id');
  const seq = Number(body.seq);
  const row = db.prepare(`
    SELECT data, deleted FROM changes
    WHERE user_id = ? AND app = ? AND collection = ? AND id = ? AND seq = ?
  `).get(ctx.identity.username, app, collection, id, seq);
  if (!row) throw new HttpError(404, 'version_not_found');

  const now = Date.now();
  const deleted = row.deleted ? 1 : 0;
  const data = deleted ? null : row.data;
  stmts.insertChange.run(ctx.identity.username, app, collection, id, data, now, deleted, 'restore', now);
  const newSeq = stmts.lastRowId.get().s;
  stmts.upsertRecord.run(ctx.identity.username, app, collection, id, data, now, deleted, newSeq, 'restore');
  return { ok: true, seq: newSeq, updatedAt: now };
});

route('GET', /^\/api\/v1\/admin\/users$/, handleAdminUsers, { admin: true });
route('POST', /^\/api\/v1\/admin\/users$/, handleAdminUsers, { admin: true });
route('PATCH', /^\/api\/v1\/admin\/users\/([^/]+)$/, async (ctx, m) => {
  const username = decodeURIComponent(m[1]);
  const user = findUser(username);
  if (!user) throw new HttpError(404, 'user_not_found');
  const body = await ctx.body();
  if (username.toLowerCase() === ctx.identity.username.toLowerCase() && body.disabled === true) {
    throw new HttpError(400, 'cannot_disable_self');
  }
  if (typeof body.disabled === 'boolean') {
    setDisabled(username, body.disabled);
  }
  if (typeof body.password === 'string' && body.password) {
    if (body.password.length < 8) throw new HttpError(400, 'weak_password');
    setPassword(username, body.password, !!body.mustChange);
  }
  return { ok: true, user: publicUser(findUser(username)) };
}, { admin: true });
route('GET', /^\/api\/v1\/admin\/settings$/, () => ({
  ok: true,
  mode: getMode(),
  registrationOpen: getRegistrationOpen(),
  inviteRequired: getInviteCode().length > 0,
  inviteCode: getInviteCode(),
}), { admin: true });
route('POST', /^\/api\/v1\/admin\/settings$/, async (ctx) => {
  const body = await ctx.body();
  if (body.mode === 'off' || body.mode === 'self' || body.mode === 'public') setMode(body.mode);
  if (typeof body.registrationOpen === 'boolean') setRegistrationOpen(body.registrationOpen);
  if (typeof body.inviteCode === 'string') setInviteCode(body.inviteCode.trim());
  return { ok: true, mode: getMode(), registrationOpen: getRegistrationOpen(), inviteRequired: getInviteCode().length > 0 };
}, { admin: true });
route('GET', /^\/api\/v1\/admin\/tokens$/, (ctx) => ({ ok: true, tokens: listTokens(ctx.identity.username) }), { admin: true });
route('POST', /^\/api\/v1\/admin\/tokens$/, async (ctx) => {
  const body = await ctx.body();
  return { ok: true, ...createToken(ctx.identity.username, String(body.name ?? 'script').slice(0, 40)) };
}, { admin: true });
route('DELETE', /^\/api\/v1\/admin\/tokens\/(\d+)$/, (ctx, m) => {
  const ok = revokeToken(ctx.identity.username, Number(m[1]));
  return { ok, };
}, { admin: true });

/* ───────────── 静态资源 ───────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bri': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// 只允许这些目录/文件被浏览器访问，避免把 server/、tests/、.git 暴露出去
const STATIC_PREFIXES = ['/shared/', '/prompt-capsule/', '/contextly/', '/expressing/', '/desktop-lite/', '/adhd-text/', '/icons/'];
const STATIC_FILES = new Set([
  '/index.html', '/login.html', '/login.css', '/login.js',
  '/admin.html', '/admin.js', '/manifest.webmanifest', '/sw.js', '/favicon.ico',
]);

function resolveStatic(pathname) {
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  if (pathname.includes('\0') || pathname.includes('..')) return null;
  if (!STATIC_FILES.has(pathname) && !STATIC_PREFIXES.some(p => pathname.startsWith(p))) return null;
  const file = join(ROOT, pathname);
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  return file;
}

function serveStatic(res, file) {
  const buf = readFileSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

/* ───────────── 主循环 ───────────── */

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  const cors = corsHeaders(req);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);

  try {
    const pathname = url.pathname;

    // API
    if (pathname.startsWith('/api/') || pathname === '/healthz') {
      const identity = identityOf(req);

      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(pathname);
        if (!m) continue;
        if (!r.open && !identity) throw new HttpError(401, 'unauthenticated');
        if (r.admin && identity.role !== 'admin') throw new HttpError(403, 'forbidden');

        const ctx = { req, res, url, identity, body: () => readBody(req), method: req.method };
        const out = await r.handler(ctx, m);
        if (!res.writableEnded) json(res, 200, out);
        return;
      }
      json(res, 404, { ok: false, error: 'not_found' });
      return;
    }

    // 登录页与 PWA 外壳永远可访问
    if (pathname === '/login.html' || pathname === '/login.css' || pathname === '/login.js'
      || pathname === '/manifest.webmanifest' || pathname === '/sw.js' || pathname === '/favicon.ico') {
      const file = resolveStatic(pathname);
      if (!file) { res.writeHead(404); res.end('not found'); return; }
      serveStatic(res, file);
      return;
    }

    // 页面：需要登录时直接 302，省一次白闪
    if (getMode() !== 'off' && !identityOf(req)) {
      const next = encodeURIComponent(pathname + url.search);
      res.writeHead(302, { Location: `/login.html?next=${next}`, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    const file = resolveStatic(pathname);
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    serveStatic(res, file);
  } catch (err) {
    if (err instanceof HttpError) {
      const headers = err.retryAfter ? { 'Retry-After': String(err.retryAfter) } : {};
      json(res, err.status, { ok: false, error: err.code }, headers);
    } else {
      console.error('[server] internal error:', err);
      json(res, 500, { ok: false, error: 'internal_error' });
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[server] listening on http://${HOST}:${PORT}`);
  console.log(`[server] db: ${DB_PATH}`);
  console.log(`[server] auth mode: ${getMode()}${authConfig.trustProxyAuth ? ' (trust-proxy-auth)' : ''}`);
  if (getMode() !== 'off') {
    const admin = findUser(authConfig.adminUser || 'admin');
    if (admin && admin.must_change_password === 1) {
      console.warn(`[server] 管理员 ${admin.username} 仍在使用初始密码，首次登录会要求修改`);
    }
  }
});

function shutdown(signal) {
  console.log(`[server] ${signal}, shutting down`);
  server.close(() => { try { db.close(); } catch {} process.exit(0); });
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

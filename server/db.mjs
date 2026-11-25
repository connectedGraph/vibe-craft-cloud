import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 项目根 .env（存在才读；环境变量优先级更高）
const envFile = join(__dirname, '..', '.env');
if (existsSync(envFile)) {
  try { process.loadEnvFile(envFile); } catch { /* 忽略格式错误 */ }
}

export const DATA_DIR = process.env.DATA_DIR || join(__dirname, 'data');
export const DB_PATH = join(DATA_DIR, 'sync.db');

let db = null;

export function getDb() {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

function tableExists(d, name) {
  return !!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function columnExists(d, table, column) {
  return d.prepare(`PRAGMA table_info(${table})`).all().some(r => r.name === column);
}

function migrate(d) {
  // 旧版（无账号）的表结构：records/changes 没有 user_id。
  // 有数据就整体迁到 admin 名下，测试数据也不丢。
  if (tableExists(d, 'records') && !columnExists(d, 'records', 'user_id')) {
    d.exec(`
      CREATE TABLE records_new (
        user_id    TEXT NOT NULL,
        app        TEXT NOT NULL,
        collection TEXT NOT NULL,
        id         TEXT NOT NULL,
        data       TEXT,
        updated_at INTEGER NOT NULL,
        deleted    INTEGER NOT NULL DEFAULT 0,
        seq        INTEGER NOT NULL,
        device_id  TEXT,
        PRIMARY KEY (user_id, app, collection, id)
      );
      CREATE TABLE changes_new (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    TEXT NOT NULL,
        app        TEXT NOT NULL,
        collection TEXT NOT NULL,
        id         TEXT NOT NULL,
        data       TEXT,
        updated_at INTEGER NOT NULL,
        deleted    INTEGER NOT NULL DEFAULT 0,
        device_id  TEXT,
        created_at INTEGER NOT NULL
      );
      INSERT INTO records_new (user_id, app, collection, id, data, updated_at, deleted, seq, device_id)
        SELECT 'admin', app, collection, id, data, updated_at, deleted, seq, device_id FROM records;
      INSERT INTO changes_new (seq, user_id, app, collection, id, data, updated_at, deleted, device_id, created_at)
        SELECT seq, 'admin', app, collection, id, data, updated_at, deleted, device_id, created_at FROM changes;
      DROP TABLE records;
      DROP TABLE changes;
      ALTER TABLE records_new RENAME TO records;
      ALTER TABLE changes_new RENAME TO changes;
    `);
    console.log('[db] migrated legacy records to user "admin"');
  }

  d.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- 账号。user_id 全站用 username 字符串；用户名不可改，改名会断数据。
    CREATE TABLE IF NOT EXISTS user (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash        TEXT NOT NULL,
      role                 TEXT NOT NULL DEFAULT 'user',
      disabled             INTEGER NOT NULL DEFAULT 0,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      password_changed_at  INTEGER NOT NULL,
      created_at           INTEGER NOT NULL,
      last_login_at        INTEGER
    );

    -- 脚本 / 非浏览器客户端的长期令牌。存 sha256，不存明文。
    CREATE TABLE IF NOT EXISTS api_token (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      TEXT NOT NULL,
      name         TEXT NOT NULL DEFAULT '',
      token_hash   TEXT NOT NULL UNIQUE,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS api_token_user ON api_token (user_id);

    CREATE TABLE IF NOT EXISTS records (
      user_id    TEXT NOT NULL,
      app        TEXT NOT NULL,
      collection TEXT NOT NULL,
      id         TEXT NOT NULL,
      data       TEXT,
      updated_at INTEGER NOT NULL,
      deleted    INTEGER NOT NULL DEFAULT 0,
      seq        INTEGER NOT NULL,
      device_id  TEXT,
      PRIMARY KEY (user_id, app, collection, id)
    );

    CREATE TABLE IF NOT EXISTS changes (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    TEXT NOT NULL,
      app        TEXT NOT NULL,
      collection TEXT NOT NULL,
      id         TEXT NOT NULL,
      data       TEXT,
      updated_at INTEGER NOT NULL,
      deleted    INTEGER NOT NULL DEFAULT 0,
      device_id  TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_changes_user_app_seq ON changes(user_id, app, seq);
    CREATE INDEX IF NOT EXISTS idx_changes_record ON changes(user_id, app, collection, id, seq);

    -- 可吊销的登录会话。JWT 里带 jti，会话被吊销后即使签名有效也拒绝。
    CREATE TABLE IF NOT EXISTS session (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      TEXT NOT NULL,
      jti          TEXT NOT NULL UNIQUE,
      device       TEXT NOT NULL DEFAULT '',
      ip           TEXT NOT NULL DEFAULT '',
      created_at   INTEGER NOT NULL,
      last_seen_at INTEGER,
      revoked_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS session_user ON session(user_id, revoked_at);
  `);
}

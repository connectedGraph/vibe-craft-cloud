# Vibe Craft 云同步设计

> 目标：在**保持纯前端、localStorage 仍是本地真源**的前提下，让同一用户在多台设备/多个浏览器之间同步数据，并顺带获得一份服务端备份。

## 1. 设计原则

1. **前端仍是主存储**。断网、未登录后端时，每个工具必须能完整独立工作；同步是增强，不是依赖。
2. **账号体系由应用自己管**。移植自 `words.6767.chat` 的 Web 端实现：账号密码登录、scrypt 哈希、JWT 放 HttpOnly Cookie、改密即失效、登录限流。三种模式 `off` / `self`（默认，单账号）/ `public`（开放注册）。不做安卓原生客户端与远程连接。
3. **数据按记录同步，不按整份 JSON 同步**。整份覆盖会让两台设备互相盖掉对方的新内容；记录级才有增量与冲突判断。
4. **全量和增量是同一套接口**。`since=0` 就是全量；`since=<lastSeq>` 就是增量。
5. **UI 状态不同步**。侧栏开关、搜索框、当前选中文档、zen 模式等都是设备本地偏好。
6. **敏感字段默认不同步**。例如 Contextly 里用户填的 API Key。

## 2. 数据抽象

每个工具的数据拆成若干 **collection（集合）**，集合里每条 **record（记录）** 必须满足：

| 字段 | 说明 |
|---|---|
| `id` | 稳定唯一标识，客户端生成，跨设备一致 |
| `updatedAt` | 毫秒时间戳，记录最后一次内容修改时间 |
| `data` | 记录内容（任意 JSON） |
| `deleted` | 墓碑标记。删除不真删，写 `deleted=true`，避免被别的设备同步回来 |

各工具映射：

| 工具 | localStorage key | collection | 记录 id | 备注 |
|---|---|---|---|---|
| Prompt Capsule | `bri_app_pro_v2` | `docs` | `doc.id` | 文档本身 |
| | | `settings` | 固定 `__singleton__` | `categories` 数组 |
| Expressing | `bri_fix_pro_v1` | `docs` | `doc.id` | 中文/初稿/地道表达/注解 |
| | | `settings` | `__singleton__` | `categories` |
| Contextly | `glass_memory_v2` | `cards` | `card.id` | 卡片 |
| | | `settings` | `__singleton__` | 只同步非敏感设置；`apiKey` 排除 |
| Desktop Lite | `aura_pkm_data_v2` | `clipboards` / `inboxItems` / `pits` | 各自 id | 结构化实体 |
| | | `dailyLogs` | 日期字符串 | 按天一条 |
| | | `settings` | `__singleton__` | plannerSlots / timeline / logTopics / pomodoro 配置 |
| ADHD Text | — | — | — | 纯展示页，无持久数据，不接同步 |

第一版只实现 Prompt Capsule；另外三个工具按同一套 adapter 接入。

## 3. 同步算法

**记录级 Last-Write-Wins（LWW） + 服务端单调游标（seq） + 墓碑删除。**

### 客户端

- `localStorage` 之外单独保存同步元数据（不混进业务数据）：
  ```json
  {
    "server": "http://127.0.0.1:8792",
    "token": "…",
    "deviceId": "dev_xxx",
    "cursors": { "prompt-capsule": 42 },
    "pending": { "prompt-capsule": { "docs": { "id1": 1730000000000 } } }
  }
  ```
- 每次业务数据写入后（`persistState`），客户端做一次快照 diff：
  - 新 id → `upsert`
  - 内容变化 → `upsert`，`updatedAt = max(now, 本地旧 updatedAt + 1)`
  - 消失的 id → `delete`（tombstone）
- push 成功后清掉对应 `pending`。
- 启动 / 定时 / `visibilitychange` 时 pull：
  - 按 id 比较 `updatedAt`，只应用比本地新的记录。
  - 应用后调用 adapter 的 `applyRemote()` 把变更写回内存状态并重渲染。

### 服务端

- 每条记录保存：`(user_id, app, collection, id) → data, updated_at, deleted, seq`。
- 每次写入分配一个全局单调 `seq`，并记入 `changes` 日志。
- push 时逐条比较：
  - 无记录 → 接受
  - `op.updatedAt > existing.updated_at` → 接受
  - 否则 → 冲突，返回服务端版本（客户端保留本地内容另存为冲突副本，见 4）
- pull 时只返回每个 id 的最新版本（`changes.seq = records.seq`），避免同一 id 的历史变更刷屏。

### 冲突

同一记录两端都改过，按 `updatedAt` 大者胜。**输的那一份不丢**：

- 客户端收到冲突时，把本地内容写进同集合的 `id#conflict-<deviceId>-<时间戳>` 新记录，再接受服务端版本。
- UI 里表现为多出一篇「冲突副本」文档，由用户自行合并/删除。

这比弹窗打断简单，也不会静默丢数据。第一版先这样。

## 4. HTTP 接口

Base：`/api/v1`。

认证优先级：

1. `TRUST_PROXY_AUTH=1` 时的 `X-Auth-User`（已有统一登录网关）
2. `Authorization: Bearer vck_...`（长期令牌）或 `Bearer <JWT>`（脚本）
3. `Cookie: vc_session=<JWT>`（浏览器）
4. `AUTH_MODE=off` 时所有访问算 `admin`

浏览器登录：

```
GET  /api/v1/auth/me
POST /api/v1/auth/login      { username, password, remember }
POST /api/v1/auth/logout
POST /api/v1/auth/register   { username, password, invite }   # 仅 public 模式
POST /api/v1/auth/password   { current, next }                # 首次强制改密可不带 current
```

管理端（`role=admin`）：

```
GET    /api/v1/admin/users
POST   /api/v1/admin/users            { username, password, role }
PATCH  /api/v1/admin/users/:username  { disabled?, password?, mustChange? }
GET    /api/v1/admin/settings
POST   /api/v1/admin/settings         { mode?, registrationOpen?, inviteCode? }
GET    /api/v1/admin/tokens
POST   /api/v1/admin/tokens           { name }
DELETE /api/v1/admin/tokens/:id
```

安全细节：

- 密码 scrypt（N=16384, r=8, p=1），`timingSafeEqual` 比较
- JWT HS256，密钥存 `data/.auth-secret`（0600），payload 带 `pv`
- Cookie：`HttpOnly; SameSite=Lax`，HTTPS 下加 `Secure`
- 登录失败 5 次锁 15 分钟，key = `IP|username`

### `GET /healthz`

```json
{ "ok": true, "version": "2.0.0", "time": 1795563622209 }
```

### `GET /sync/state?app=prompt-capsule`

```json
{ "ok": true, "seq": 128, "count": 37, "updatedAt": 1730000000000 }
```

### `GET /sync/pull?app=prompt-capsule&since=42&limit=500`

```json
{
  "ok": true,
  "now": 128,
  "hasMore": false,
  "changes": [
    {
      "collection": "docs",
      "id": "abc123",
      "op": "upsert",
      "data": { "id": "abc123", "title": "…" },
      "updatedAt": 1730000000000,
      "seq": 127
    },
    {
      "collection": "docs",
      "id": "xyz",
      "op": "delete",
      "data": null,
      "updatedAt": 1730000000100,
      "seq": 128
    }
  ]
}
```

- `since` 用上一次响应的 `now`。
- `hasMore=true` 时客户端继续用返回的最大 `seq` 拉。

### `POST /sync/push`

```json
{
  "app": "prompt-capsule",
  "deviceId": "dev_xxx",
  "ops": [
    { "collection": "docs", "id": "abc123", "op": "upsert", "data": { … }, "updatedAt": 1730000000000 },
    { "collection": "docs", "id": "old", "op": "delete", "updatedAt": 1730000000100 }
  ]
}
```

响应：

```json
{
  "ok": true,
  "now": 131,
  "accepted": [
    { "collection": "docs", "id": "abc123", "seq": 130 }
  ],
  "conflicts": [
    { "collection": "docs", "id": "abc999", "server": { "data": {…}, "updatedAt": 1730000000500, "deleted": false, "seq": 129 } }
  ]
}
```

约束：

- 请求体上限 8 MB；`ops` 单次上限 500 条。
- `app` 只允许 `[a-z0-9-]{1,40}`。
- `updatedAt` 超出 `now ± 24h` 的会被夹紧（防客户端时钟乱跳）。
- 同一 `(app, collection, id)` 并发写由 SQLite 事务串行化。

### 错误

```json
{ "ok": false, "error": "invalid_token" }
```

`401 invalid_token`、`400 bad_request`、`413 payload_too_large`、`429 rate_limited`、`500 internal_error`。

## 5. 服务端存储

单文件 SQLite（Node 24 内置 `node:sqlite`，零 npm 依赖）：

```sql
CREATE TABLE user (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  username             TEXT NOT NULL UNIQUE COLLATE NOCASE,  -- 全站 user_id 用 username
  password_hash        TEXT NOT NULL,                        -- scrypt
  role                 TEXT NOT NULL DEFAULT 'user',
  disabled             INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  password_changed_at  INTEGER NOT NULL,                     -- 写进 JWT 的 pv，改密即失效旧会话
  created_at           INTEGER NOT NULL,
  last_login_at        INTEGER
);

-- 脚本/非浏览器客户端用的长期令牌；存 sha256，不存明文
CREATE TABLE api_token (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);

CREATE TABLE records (
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

CREATE TABLE changes (
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

CREATE INDEX idx_changes_user_app_seq ON changes(user_id, app, seq);
```

旧版没有 `user_id` 的 `records/changes` 会在启动时自动迁移到 `admin` 名下。

DB 文件默认 `server/data/sync.db`，可用 `DATA_DIR` 改。

## 6. 部署与安全

- `PORT`（默认 8792）、`AUTH_MODE`（默认 `self`）、`DATA_DIR`、`ALLOWED_ORIGINS`（默认同源，不需要 CORS）。
- 生产必须放在 HTTPS 反代后面（nginx/Caddy），`HOST=0.0.0.0`，并由反代补 `X-Forwarded-Proto: https`，否则 Cookie 不会加 `Secure`。
- 服务端托管前端静态文件（同源），Cookie 不需要跨站配置。
- 只存密码哈希与同步内容，不存明文密码；日志不打印 token。

## 7. 接入方式

各工具页面引入 `../shared/sync-client.js`，调用：

```js
VibeSync.attach({
  app: 'prompt-capsule',
  storageKey: 'bri_app_pro_v2',
  collections: {
    docs: {
      read: () => appState.docs,
      apply: (map) => { /* 把 map 合并回 appState.docs */ },
      getId: (d) => d.id,
      getUpdatedAt: (d) => d.updatedAt || 0,
      normalize: (d) => d
    }
  },
  onApplied: () => { /* 重新渲染 */ }
});
```

`sync-client.js` 负责配置、游标、diff、push/pull、冲突副本、状态事件；页面只提供「怎么读写自己的数据」。

## 8. 版本演进

- 接口带 `/v1`，向后兼容只加字段。
- `changes` 日志保留 180 天（后续加清理任务），清理后旧设备需重新全量（`since=0`）。
- 多用户已落地：`records/changes` 用 `user_id` 隔离，接口路径与语义不变；未登录用户拿不到任何记录。

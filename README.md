# vibe-craft

[简体中文](#chinese-version)

A collection of lightweight, zero-dependency, web-based Single Page Applications (SPAs) designed to optimize development, learning, and knowledge management workflows.

> **This fork adds optional cloud sync.** localStorage remains the local source of truth; the sync server only relays incremental changes between devices and keeps a backup. See [Cloud Sync](#cloud-sync) and [docs/SYNC-DESIGN.md](docs/SYNC-DESIGN.md). Currently wired up for **Prompt Capsule**; the other tools use the same client (`shared/sync-client.js`) with their own adapter.

---

## Cloud Sync

### What it is

- **账号体系**：账号密码登录，`scrypt` 哈希，JWT 放 HttpOnly Cookie（不放 localStorage）。令牌带 `pv=改密时间`，改密后旧会话全部失效；`jti` 支持按设备踢下线。登录限流 5 次 / 15 分钟。
- **SQLite 持久化**：`user` / `api_token` / `session` / `records` / `changes` / `meta`，零 npm 依赖（Node 内置 `node:sqlite`）。
- **数据按账号隔离**：同步记录的主键是 `(user_id, app, collection, id)`，两个账号即使文档 id 相同也互不可见。
- **记录级增量同步**：文档/卡片逐条按 `updatedAt` 做 LWW，不整份覆盖；删除用墓碑。
- **冲突不丢**：较旧的版本另存为「标题 · 冲突副本」。
- **版本历史与回滚**：每次修改都进 `changes` 日志，Prompt Capsule 页头的时钟按钮可查看并恢复任一历史版本。
- **云端备份**：一键导出账号全部记录为 JSON，支持合并恢复或覆盖恢复。
- **多工具**：Prompt Capsule、Contextly、Expressing、Desktop Lite 都已接入同一套同步（后三个用右下角浮层）。
- **PWA**：manifest + service worker，可安装到桌面/手机，断网时外壳仍可打开。
- **前端仍可离线**：直接双击 HTML 打开时不会连后端，所有数据留在 localStorage，只是没有同步。

### 快速开始

```bash
./install.sh                 # 检查 Node、生成 .env、创建 data 目录
node server/server.mjs       # 默认 http://127.0.0.1:8792
```

打开 <http://127.0.0.1:8792>。首次账号 `admin / 123456`，登录后会强制改密。
之后打开 `/prompt-capsule/index.html`，左下角显示 `Synced` 即同步正常。

线上实例：<https://craft.6767.chat/>（tx，systemd `vibe-craft.service`）。

### 账号模式

| `AUTH_MODE` | 行为 |
|---|---|
| `off` | 不登录，所有访问算 `admin`（只适合本机演示） |
| `self` | 单账号，不开放注册（默认） |
| `public` | 开放注册，数据按账号隔离；可再加邀请码 |

环境变量（也可写在项目根 `.env`）：

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8792` | HTTP 端口 |
| `HOST` | `127.0.0.1` | 监听地址（反代后设 `0.0.0.0`） |
| `DATA_DIR` | `server/data` | SQLite 与密钥目录 |
| `AUTH_MODE` | `self` | `off` / `self` / `public` |
| `AUTH_SECRET` | 自动生成 | JWT 签名密钥，缺省写入 `data/.auth-secret`（0600） |
| `SESSION_HOURS` | `8` | 普通会话有效期 |
| `REMEMBER_DAYS` | `30` | 「保持登录」有效期 |
| `ADMIN_USER` / `ADMIN_PASSWORD` | `admin` / `123456` | 首次启动创建的管理员；默认密码强制改密 |
| `REGISTRATION_OPEN` | `1` | `public` 模式下是否开放注册 |
| `REGISTRATION_CODE` | 空 | 注册邀请码 |
| `ALLOWED_ORIGINS` | 空 | 跨域来源（同源部署不需要） |
| `SYNC_TOKEN` | 空 | 兼容旧部署：视为 `admin` 的长期 Bearer 令牌 |

### 登录与页面

- 未登录访问任何页面 → `302 /login.html?next=...`
- 登录成功后跳回原页面；首次登录强制改密（不用再输一遍旧密码）
- 浏览器只保存 `vc_session`（HttpOnly、SameSite=Lax）
- 同步客户端 `shared/sync-client.js` 自动探测同源后端：可用则走 Cookie 账号模式，不可用则回退到手动 `Server URL + Token` 模式

### 管理员

登录 `admin` 后可直接调用（也可以用 `/admin` 页面，后续补 UI）：

```
GET    /api/v1/admin/users
POST   /api/v1/admin/users            { username, password, role }
PATCH  /api/v1/admin/users/:username  { disabled?, password?, mustChange? }
GET    /api/v1/admin/settings
POST   /api/v1/admin/settings         { mode?, registrationOpen?, inviteCode? }
GET    /api/v1/admin/tokens
POST   /api/v1/admin/tokens           { name }  → 返回一次明文 vck_ 令牌
DELETE /api/v1/admin/tokens/:id
```

### API

```
GET  /healthz
GET  /api/v1/auth/me
POST /api/v1/auth/login | logout | register | password
GET  /api/v1/sync/state?app=prompt-capsule
GET  /api/v1/sync/pull?app=prompt-capsule&since=<seq>&limit=500
POST /api/v1/sync/push
```

认证优先级：`X-Auth-User`（网关模式）→ `Authorization: Bearer vck_/JWT` → `vc_session` Cookie → `AUTH_MODE=off`。
完整协议与表结构：[docs/SYNC-DESIGN.md](docs/SYNC-DESIGN.md)。

### 测试

```bash
# 需要 server(8792)、headless Chrome(9223)
# 服务端：ADMIN_PASSWORD=testpass123 SYNC_TOKEN=test-token-123 DATA_DIR=/tmp/vc-test node server/server.mjs
node tests/e2e-sync.mjs
```

覆盖：首次全量上传、远端拉取、本地推送、冲突副本。

### 目录

```
login.html / login.js      # 登录、注册、强制改密页
shared/sync-client.js      # 浏览器端同步客户端 + 账号探测
server/server.mjs          # HTTP 路由、静态托管、同步 API
server/auth.mjs            # 密码、JWT、Cookie、用户、限流
server/db.mjs              # SQLite schema 与迁移
docs/SYNC-DESIGN.md        # 协议与数据模型
tests/e2e-sync.mjs         # 真实浏览器端到端验证
```

### 部署

放在 HTTPS 反代后，`HOST=0.0.0.0`，`server/data` 权限 `700`、`.auth-secret` 与 `.env` 权限 `600`。
服务端只存密码哈希（scrypt）与同步内容，不存明文密码；`api_token` 也只存 sha256。

---

## Included Tools

### Prompt Capsule

Prompt Capsule is a dedicated knowledge-persistence utility designed to capture, organize, and review Q&A interactions with AI assistants. Instead of letting valuable chat sessions get buried in browser history, Prompt Capsule provides a structured workspace to save and review this knowledge.

#### Key Features

*   **Gallery Explorer**: A visually rich dashboard to browse all saved topics and documents in a grid or list view.
*   **Tagging and Categorization**: Standardized labels and custom categories to keep your learning notes organized and searchable.
*   **Spaced Repetition and Review**: Built-in mechanisms to flag documents for review, tracking your learning progress and helping you retain knowledge.
*   **Markdown and LaTeX Support**: Render rich text notes, technical documentations, and complex mathematical formulas accurately using integrated Markdown and KaTeX engines.
*   **Zen Mode**: A clean, distraction-free reading and writing interface to maximize focus.
*   **Local Storage and Data Portability**: Save and import your documents locally as JSON or Markdown formats.

#### Getting Started

To launch Prompt Capsule:
1. Navigate to the tool's directory:
   ```bash
   cd prompt-capsule
   ```
2. Open index.html directly in any modern web browser.

---

### Contextly

Contextly is a local, high-fidelity vocabulary builder designed to save learned words and phrases along with their surrounding reading context (the current sentence, as well as the optional preceding and succeeding sentences). This ensures that you can always recall the exact scenario and usage context in which the word was encountered.

#### Key Features

*   **Contextual Preservation**: Save vocabulary alongside surrounding sentences (before, current, and after) to capture the full semantic context.
*   **Structured Word Vault**: View and search all saved words, definitions, and contextual sentences in a clean dashboard.
*   **JSON Data Export**: Export your complete vocabulary library to JSON format for offline review, spaced repetition software (Anki), or custom application development.
*   **Glassmorphic Design**: Clean and modern user interface styled with Tailwind CSS and glassmorphic panels.

#### Getting Started

To launch Contextly:
1. Navigate to the tool's directory:
   ```bash
   cd contextly
   ```
2. Open index.html directly in any modern web browser.

---

### Expressing

Expressing is a lightweight writing refiner and native expression logger. It is designed to capture polished sentence expressions and compare them side-by-side with original drafts, highlighting the nuances and improvements in native English choices.

#### Key Features

*   **Side-by-Side Comparison**: Distinct split columns to compare original drafts with polished native expressions.
*   **Expression Highlighter**: Mark and focus on specific vocabulary changes and grammatical improvements.
*   **Refinement Vault**: Save and tag refined expressions locally to build your own personal database of idiomatic English.
*   **Zero Dependencies**: Fully runs client-side in a single HTML file using Tailwind CSS and native Javascript.

#### Getting Started

To launch Expressing:
1. Navigate to the tool's directory:
   ```bash
   cd expressing
   ```
2. Open index.html directly in any modern web browser.

---

### Desktop Lite

Desktop Lite (Aura PKM) is a lightweight personal knowledge management workspace. It provides a clean, distraction-free environment to capture, organize, filter, and review notes and ideas, all running entirely client-side in a single HTML file.

#### Key Features

*   **Personal Knowledge Management**: A compact, self-contained workspace to capture, tag, and organize notes with local storage persistence.
*   **Filterable Notes**: Search and filter your notes to quickly surface what you need.
*   **Zero Dependencies**: Fully runs client-side in a single HTML file using Tailwind CSS and native Javascript.

#### Getting Started

To launch Desktop Lite:
1. Navigate to the tool's directory:
   ```bash
   cd desktop-lite
   ```
2. Open index.html directly in any modern web browser.

---

### ADHD Text

ADHD Text is a professional reading typography and visual testing lab. It is designed to improve reading comfort and focus through dyslexia-friendly fonts, adjustable typography, reading rulers, and visual helpers.

#### Key Features

*   **Dyslexia-Friendly Fonts**: OpenDyslexic and other legible typefaces built in to lower the barrier to reading.
*   **Reading Helpers**: Adjustable rulers, spacing, and visual guides to reduce line-skipping and distraction.
*   **Zero Dependencies**: Fully runs client-side in a single HTML file using Tailwind CSS and native Javascript.

#### Getting Started

To launch ADHD Text:
1. Navigate to the tool's directory:
   ```bash
   cd adhd-text
   ```
2. Open index.html directly in any modern web browser.

---

<a name="chinese-version"></a>
# 中文版

[Back to English Version / 返回英文版](#vibe-craft)

> **本分支加入账号体系与云同步。** localStorage 仍是本地真源，服务端只做多设备增量中转与备份；账号密码登录，数据按账号隔离。协议见 [docs/SYNC-DESIGN.md](docs/SYNC-DESIGN.md)。目前 Prompt Capsule 已接入，其余工具用同一个 `shared/sync-client.js` 配 adapter 即可。

## 云同步快速开始

```bash
./install.sh                     # 生成 .env、准备 data 目录
node server/server.mjs           # 默认 127.0.0.1:8792
```

打开 <http://127.0.0.1:8792>，首次账号 `admin / 123456`，登录后强制改密。之后打开 `prompt-capsule/index.html`，左下角绿点 `Synced` 即表示同步正常。两端同时改同一篇时，较新的版本胜出，旧的另存为「冲突副本」。

---

一系列轻量级、零依赖的纯网页单页面应用（SPA）提效工具集合，旨在优化软件开发、系统学习和个人知识管理的日常工作流。

---

## 包含工具

### Prompt Capsule

Prompt Capsule 是一款专为 AI 问答持久化设计的知识管理工具。它可以帮助你轻松捕获、整理和复习与 AI 助手的问答交互。Prompt Capsule 提供了一个结构化的工作空间，防止有价值的对话信息被埋没在漫无目的的浏览器历史记录中。

#### 核心特性

*   **知识库面板**：采用视觉上极简、美观的卡片网格和列表视图，方便快速检索和浏览所有已保存的主题文档。
*   **标签与多分类**：支持自定义分类与标准化标签管理，保持知识库井井有条，支持关键字快速搜索。
*   **复习与间隔记忆机制**：内置复习标记与学习进度追踪系统，帮助你进行针对性温习，强化知识点记忆。
*   **Markdown 与 LaTeX 公式渲染**：内置 Markdown 编译器与 KaTeX 排版引擎，完美呈现技术文档 and 复杂的数学公式。
*   **禅模式**：提供专注、无干扰的沉浸式阅读与编辑界面，最大限度减少外界干扰。
*   **数据本地化导入导出**：所有数据均可通过 JSON 或 Markdown 格式进行本地导入或导出保存，保障你的数据安全与迁移自由。

#### 快速开始

启动 Prompt Capsule：
1. 进入该工具所在的目录：
   ```bash
   cd prompt-capsule
   ```
2. 直接在任意现代浏览器中打开 index.html 即可开始使用。

---

### Contextly

Contextly 是一款本地单词与短语情境记忆工具。它不仅能记录你学到的生词或短语，还能选择性地保存阅读时的上下文（当前所在句子、前一句以及后一句）。这能帮助你随时还原记单词时的真实语境和场景，强化场景联想记忆。

#### 核心特性

*   **语境同步保存**：在记录单词时一并保存当前句、前一句和后一句，最大化还原真实的阅读语境。
*   **结构化词汇库**：在美观的词卡面板中查看、检索和管理所有已保存的单词、释义及例句。
*   **JSON 数据导出**：支持将完整的单词数据库导出为标准的 JSON 格式文件，便于进行后续开发、本地数据备份或导入 Anki 进行复习。
*   **毛玻璃极简视觉**：采用 Tailwind CSS 和现代毛玻璃设计风格，提供清爽的护眼使用体验。

#### 快速开始

启动 Contextly：
1. 进入该工具所在的目录：
   ```bash
   cd contextly
   ```
2. 直接在任意现代浏览器中打开 index.html 即可开始使用。

---

### Expressing

Expressing 是一款地道英语表达对比与积累工具。它通过直观的左右分栏，帮助你记录和对比自己的英文初稿与最终润色后的地道表达，清晰展现词汇、语法以及句式上的润色细节。

#### 核心特性

*   **双栏对比视图**：提供左右分屏的清晰排版，直观比较初稿表达与润色后的纯正英语表达。
*   **句式高亮分析**：支持对词汇替换与句型重组进行精准的高亮标注。
*   **地道表达库**：本地归类并打标签存储你积累的各类地道句型，打造个人专属的表达语料库。
*   **纯前端零依赖**：无任何后端或构建环境依赖，双击 index.html 即可随时运行。

#### 快速开始

启动 Expressing：
1. 进入该工具所在的目录：
   ```bash
   cd expressing
   ```
2. 直接在任意现代浏览器中打开 index.html 即可开始使用。

---

### Desktop Lite

Desktop Lite (Aura PKM) 是一款轻量级的个人知识管理工作台。它以简洁、无干扰的界面帮助你捕获、整理、筛选与复习笔记和灵感，纯前端单文件运行，无需任何构建与后端依赖。

#### 核心特性

*   **个人知识管理**：紧凑的自包含工作空间，支持本地存储持久化地捕获、打标签与整理笔记。
*   **笔记筛选**：可搜索、可筛选，快速定位你需要的笔记内容。
*   **纯前端零依赖**：单 HTML 文件即可运行，使用 Tailwind CSS 与原生 Javascript。

#### 快速开始

启动 Desktop Lite：
1. 进入该工具所在的目录：
   ```bash
   cd desktop-lite
   ```
2. 直接在任意现代浏览器中打开 index.html 即可开始使用。

---

### ADHD Text

ADHD Text 是一个专业阅读排版与视觉测试实验室。它通过易读字体、可调排版、阅读辅助线等视觉工具，改善阅读舒适度并提升专注力。

#### 核心特性

*   **易读字体**：内置 OpenDyslexic 等为阅读障碍优化的可读字体，降低阅读门槛。
*   **阅读辅助工具**：可调辅助线、行距与视觉引导，减少跳行与注意力涣散。
*   **纯前端零依赖**：单 HTML 文件即可运行，使用 Tailwind CSS 与原生 Javascript。

#### 快速开始

启动 ADHD Text：
1. 进入该工具所在的目录：
   ```bash
   cd adhd-text
   ```
2. 直接在任意现代浏览器中打开 index.html 即可开始使用。



#!/usr/bin/env bash
# Vibe Craft Cloud Sync — 幂等安装脚本
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${DATA_DIR:-$ROOT/server/data}"

command -v node >/dev/null || { echo "需要 Node.js >= 22.5"; exit 1; }
node -e "const {DatabaseSync}=require('node:sqlite')" >/dev/null 2>&1 \
  || { echo "当前 Node 不支持 node:sqlite（需要 >= 22.5）"; exit 1; }

mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"

if [ ! -f "$ROOT/.env" ]; then
  cat > "$ROOT/.env" <<EOF
PORT=8792
HOST=127.0.0.1
AUTH_MODE=self
ADMIN_USER=admin
ADMIN_PASSWORD=123456
# 反向代理场景：
# HOST=0.0.0.0
# ALLOWED_ORIGINS=https://your.domain
# AUTH_SECRET=改成一段长随机串（不填会自动生成到 server/data/.auth-secret）
EOF
  chmod 600 "$ROOT/.env"
  echo "已生成 $ROOT/.env（默认密码 123456，首次登录会强制修改）"
fi

cat <<EOF

安装完成。

启动：
  node "$ROOT/server/server.mjs"

默认地址：http://127.0.0.1:8792
默认账号：admin / 123456（首次登录会要求改成新密码）

账号模式（AUTH_MODE）：
  off     不登录，所有访问算 admin（仅限本机演示）
  self    单账号，不开放注册（默认）
  public  开放注册，数据按账号隔离

数据目录：$DATA_DIR
  sync.db          SQLite（用户、会话令牌、同步记录）
  .auth-secret     JWT 签名密钥（自动生成，0600）
EOF

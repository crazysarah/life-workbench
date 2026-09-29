#!/usr/bin/env bash
# 服务器端一键安装：装 Docker（如缺）→ 生成 .env 和随机口令 → 构建并启动服务
#
# 用法（在服务器上、仓库目录里跑）：
#   bash deploy/setup-server.sh                 # 默认：只要后端，8080 直接对外
#   bash deploy/setup-server.sh --port 18080    # 换端口
#   bash deploy/setup-server.sh --caddy         # 额外启用仓库自带的 Caddy（自动 HTTPS）
#
# 已经自建了 nginx / Traefik 等反代的，不要加 --caddy，用默认方式即可，
# 然后在 .env 里设 BIND_ADDR=127.0.0.1 把服务端口收到本机。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${HTTP_PORT:-8080}"
USE_CADDY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --caddy) USE_CADDY=1; shift ;;
    *) echo "未知参数：$1"; exit 1 ;;
  esac
done

COMPOSE_CMD=(docker compose)
if [ "$USE_CADDY" = "1" ]; then
  COMPOSE_CMD+=(-f docker-compose.yml -f deploy/docker-compose.caddy.yml)
fi

echo "==> 1/5 检查 Docker"
if ! command -v docker >/dev/null 2>&1; then
  echo "    没装 Docker，开始安装（官方脚本）..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
else
  echo "    Docker 已就绪：$(docker --version)"
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "!! 缺 docker compose 插件。Debian/Ubuntu 上试：apt-get install -y docker-compose-plugin"
  exit 1
fi

echo "==> 2/5 准备 .env"
FRESH_ENV=0
if [ ! -f .env ]; then
  cp .env.example .env
  FRESH_ENV=1

  PW="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 16)"
  SECRET="$(head -c 48 /dev/urandom | base64 | tr -d '/+=' | head -c 43)"

  # 用 | 作分隔符，避免随机串里的特殊字符出问题
  sed -i "s|^APP_PASSWORD=.*|APP_PASSWORD=${PW}|" .env
  sed -i "s|^APP_SECRET=.*|APP_SECRET=${SECRET}|" .env
  sed -i "s|^HTTP_PORT=.*|HTTP_PORT=${PORT}|" .env
  echo "    已生成 .env（含随机口令）"
  echo "    访问口令：${PW}"
fi

env_get() { sed -n "s/^$1=//p" .env 2>/dev/null | tr -d '\r' | head -1; }
env_set() { # 只在值当前为空时写入，不覆盖用户已填写的内容
  if ! grep -qE "^$1=" .env 2>/dev/null; then
    printf '%s=%s\n' "$1" "$2" >> .env
  elif [ -z "$(env_get "$1")" ]; then
    sed -i "s|^$1=.*|$1=$2|" .env
  fi
}

if [ "$USE_CADDY" = "1" ]; then
  if [ -z "$(env_get DOMAIN)" ]; then
    echo "!! --caddy 需要在 .env 里填 DOMAIN（例如 life.example.com），且域名 A 记录要指向本机。"
    exit 1
  fi
  # Caddy 对外提供 80/443，后端没必要再占着公网端口
  env_set BIND_ADDR 127.0.0.1
  echo "    Caddy 模式：后端收在 127.0.0.1，对外由 Caddy 代管（$(env_get DOMAIN)）"
else
  # 端口占用检查（只对直接 IP 模式有意义）
  if command -v ss >/dev/null 2>&1; then
    if ss -lnt 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${PORT}\$"; then
      echo "!! 端口 ${PORT} 已被占用，换一个：bash deploy/setup-server.sh --port 18080"
      exit 1
    fi
  fi
fi

echo "==> 3/5 构建镜像（第一次会慢一些）"
"${COMPOSE_CMD[@]}" build

echo "==> 4/5 启动服务"
"${COMPOSE_CMD[@]}" up -d

echo "==> 5/5 等待健康检查"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    echo "    服务已就绪"
    break
  fi
  sleep 1
  if [ "$i" = "30" ]; then
    echo "!! 30 秒内没起来，看日志：${COMPOSE_CMD[*]} logs --tail=50 api"
    exit 1
  fi
done

# 对外访问地址：优先用 .env 里填的 PUBLIC_BASE_URL，没填就自动探测公网 IP
BASE_URL="$(env_get PUBLIC_BASE_URL)"
BASE_SOURCE=".env 的 PUBLIC_BASE_URL"
if [ "$USE_CADDY" = "1" ]; then
  BASE_URL="https://$(env_get DOMAIN)"
  BASE_SOURCE="Caddy 自动 HTTPS"
elif [ -z "$BASE_URL" ]; then
  DETECTED_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo '')"
  if [ -n "$DETECTED_IP" ]; then
    BASE_URL="http://${DETECTED_IP}:${PORT}"
    BASE_SOURCE="自动探测公网 IP"
  else
    BASE_URL="http://<你的公网IP>:${PORT}"
    BASE_SOURCE="探测失败，需自己填"
  fi
fi

cat <<EOF

============================================================
  部署完成
============================================================

  访问地址：${BASE_URL}      （来源：${BASE_SOURCE}）
  健康检查：curl http://127.0.0.1:${PORT}/api/health

  APK 里要填的服务端地址：
      ${BASE_URL}

EOF

cat <<'EOF'
  想让 APK 用这个地址，还要去 GitHub 仓库配一份（Actions 读不到 .env）：
      Settings → Secrets and variables → Actions → Variables → New variable
      名称 API_BASE，值填上面这个地址

EOF

if [ "$FRESH_ENV" = "1" ]; then
  echo "  访问口令（App 首次打开时输入）：$(grep '^APP_PASSWORD=' .env | cut -d= -f2-)"
  echo
fi

if [ "$USE_CADDY" = "1" ]; then
  cat <<'EOF'
  Caddy 会在首次访问域名时自动申请证书，去云控制台放行 80 和 443。

EOF
elif [ "$(env_get BIND_ADDR)" = "127.0.0.1" ]; then
  cat <<'EOF'
  已设 BIND_ADDR=127.0.0.1，只对本机开放。你的反代上游填：
      http://127.0.0.1:端口   （反代在同一 docker 网络里则填 http://life-workbench-api:8080）

EOF
else
  cat <<'EOF'
  别忘了在云控制台【防火墙】放行该端口。

EOF
fi

cat <<'EOF'
  常用命令：
    docker compose logs -f api      看日志
    docker compose restart api      重启
    docker compose down             停止
    cp data/workbench.db ~/bak.db   备份数据

EOF

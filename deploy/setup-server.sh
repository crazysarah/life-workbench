#!/usr/bin/env bash
# 服务器端一键安装：装 Docker（如缺）→ 生成 .env 和随机口令 → 构建并启动服务
#
# 用法（在服务器上、仓库目录里跑）：
#   bash deploy/setup-server.sh
#   bash deploy/setup-server.sh --port 8080
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${HTTP_PORT:-8080}"
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    *) echo "未知参数：$1"; exit 1 ;;
  esac
done

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

# 端口占用检查（只对直接 IP 模式有意义）
if command -v ss >/dev/null 2>&1; then
  if ss -lnt 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${PORT}\$"; then
    echo "!! 端口 ${PORT} 已被占用，换一个：bash deploy/setup-server.sh --port 18080"
    exit 1
  fi
fi

echo "==> 3/5 构建镜像（第一次会慢一些）"
docker compose build

echo "==> 4/5 启动服务"
docker compose up -d

echo "==> 5/5 等待健康检查"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    echo "    服务已就绪"
    break
  fi
  sleep 1
  if [ "$i" = "30" ]; then
    echo "!! 30 秒内没起来，看日志：docker compose logs --tail=50 api"
    exit 1
  fi
done

# 对外访问地址：优先用 .env 里填的 PUBLIC_BASE_URL，没填就自动探测公网 IP
BASE_URL="$(sed -n 's/^PUBLIC_BASE_URL=//p' .env 2>/dev/null | tr -d '\r' | head -1)"
BASE_SOURCE=".env 的 PUBLIC_BASE_URL"
if [ -z "$BASE_URL" ]; then
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

cat <<'EOF'
  别忘了在云控制台【防火墙】放行该端口。

  常用命令：
    docker compose logs -f api      看日志
    docker compose restart api      重启
    docker compose down             停止
    cp data/workbench.db ~/bak.db   备份数据

EOF

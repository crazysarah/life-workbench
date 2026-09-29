#!/usr/bin/env bash
# 一条命令跑完：生成客户端页面 -> 拷贝静态资源 -> 装 Capacitor -> 生成/同步安卓工程 -> 打补丁
#
# 服务端地址是**可选**的：不传就不内置，用户装好 App 后自己填（右下角齿轮随时能改）；
# 传了就是「内置默认地址」，用户自己填过的地址优先级更高。
#
# 用法：
#   bash build/sync_mobile.sh                      # 不内置地址（推荐，一个包到处用）
#   bash build/sync_mobile.sh http://203.0.113.10:8080    # 内置默认地址
set -euo pipefail

API_BASE="${1:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${PYTHON:-python3}"

if ! command -v "$PY" >/dev/null 2>&1; then
  PY=python
fi

echo "==> 1/5 注入内置地址 (apiBase=${API_BASE:-留空，装好后在 App 里填})"
"$PY" "$ROOT/build/inject_api_base.py" --api-base "$API_BASE" --out "$ROOT/mobile/www/index.html"

echo "==> 2/5 拷贝静态资源"
cp "$ROOT/client/manifest.webmanifest" "$ROOT/mobile/www/"
cp "$ROOT/client/icon.svg" "$ROOT/mobile/www/"
cp "$ROOT/client/icon-maskable.svg" "$ROOT/mobile/www/"

echo "==> 3/5 安装 Capacitor 依赖"
(cd "$ROOT/mobile" && npm install --no-audit --no-fund)

echo "==> 4/5 生成并同步安卓工程"
(cd "$ROOT/mobile" && { [ -d android ] || npx cap add android; } && npx cap sync android)

echo "==> 5/5 给安卓工程打补丁"
"$PY" "$ROOT/build/patch_android.py"

cat <<'EOF'

完成。构建 APK：

  cd mobile/android
  ./gradlew assembleDebug          # 调试包，可直接装
  # 产物：mobile/android/app/build/outputs/apk/debug/app-debug.apk

第一次构建 Gradle 要下载依赖，会比较慢。
EOF

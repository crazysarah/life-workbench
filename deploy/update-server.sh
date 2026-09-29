#!/usr/bin/env bash
# 服务器端更新：拉最新代码 → 重建镜像 → 重启 → 健康检查
#
# 用法（在服务器上、仓库目录里跑）：
#   bash deploy/update-server.sh              # 更新到最新
#   bash deploy/update-server.sh --check      # 只看有没有新版，什么都不改
#   bash deploy/update-server.sh --caddy      # 当初用 --caddy 装的，要带上
#
# 数据不受影响：默认存在 docker 卷 lw-data 里，重建镜像和容器都不会动它。
# 万一新版起不来，脚本会打印回滚命令。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

USE_CADDY=0
CHECK_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --caddy) USE_CADDY=1; shift ;;
    --check) CHECK_ONLY=1; shift ;;
    *) echo "未知参数：$1"; exit 1 ;;
  esac
done

COMPOSE_CMD=(docker compose)
if [ "$USE_CADDY" = "1" ]; then
  COMPOSE_CMD+=(-f docker-compose.yml -f deploy/docker-compose.caddy.yml)
fi

# 注意：函数必须自己吞掉「.env 不存在」的情况。
# 在 set -e 下 `VAR="$(env_get X)"` 这种赋值，一旦里面命令返回非零就会静默退出，
# 什么提示都没有 —— 极难排查。
env_get() {
  [ -f .env ] || return 0
  sed -n "s/^$1=//p" .env 2>/dev/null | tr -d '\r' | head -1 || true
}
PORT="$(env_get HTTP_PORT)"; PORT="${PORT:-8080}"

DATA_VOL="$(env_get DATA_VOLUME)"
case "$DATA_VOL" in
  ""|lw-data) DATA_NOTE="docker 卷 lw-data" ;;
  /*|./*)     DATA_NOTE="宿主机目录 ${DATA_VOL}" ;;
  *)          DATA_NOTE="docker 卷 ${DATA_VOL}" ;;
esac

# ---------- 1. 工作区检查 ----------
echo "==> 1/5 检查工作区"
if [ ! -f .env ]; then
  echo "!! 当前目录没有 .env —— 这台机器还没用仓库里的脚本装过？"
  echo "   第一次部署请先跑：bash deploy/setup-server.sh"
  echo "   （如果你只是 clone 了代码、服务在别处，请在部署目录里跑本脚本。）"
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "!! 找不到 git。"
  exit 1
fi
DIRTY="$(git status --porcelain | grep -v '^??' || true)"
if [ -n "$DIRTY" ]; then
  echo "!! 仓库里有未提交的改动，直接更新会和 git pull 打架："
  printf '%s\n' "$DIRTY" | sed 's/^/     /'
  echo "   先收好它们（.env 不受影响，它在 .gitignore 里）："
  echo "     git stash        # 更新完再 git stash pop 取回来"
  exit 1
fi
UNTRACKED="$(git status --porcelain | grep '^??' || true)"
if [ -n "$UNTRACKED" ]; then
  echo "   提示：有未跟踪的文件，若与远端新增文件重名会挡住更新："
  printf '%s\n' "$UNTRACKED" | sed 's/^/     /'
fi

OLD="$(git rev-parse --short HEAD)"
OLD_FULL="$(git rev-parse HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "    当前版本：$OLD（分支 $BRANCH）"

# ---------- 2. 拉取 ----------
echo "==> 2/5 拉取最新代码"
if ! git fetch --quiet origin "$BRANCH"; then
  echo "!! 拉取失败 —— 服务器连不上 GitHub？"
  echo "   代码没更新，数据和服务也没动，旧版仍在正常运行。"
  exit 1
fi

BEHIND="$(git rev-list --count "HEAD..origin/$BRANCH")"
if [ "$BEHIND" = "0" ]; then
  echo "    已经是最新，没有新提交。"
  if [ "$CHECK_ONLY" = "1" ]; then exit 0; fi
  echo "    （仍然重建一次容器 —— 你刚改过 .env 想让它生效时有用）"
  NEW="$OLD"
else
  echo "    落后 $BEHIND 个提交："
  git log --oneline "HEAD..origin/$BRANCH" | sed 's/^/     /'
  if [ "$CHECK_ONLY" = "1" ]; then
    echo
    echo "--check：什么都没改。去掉 --check 再跑一次就会真的更新。"
    exit 0
  fi
  git merge --ff-only --quiet "origin/$BRANCH"
  NEW="$(git rev-parse --short HEAD)"
  echo "    已更新：$OLD → $NEW"
fi

# ---------- 3. 重建 ----------
echo "==> 3/5 重建镜像并重启"
if ! docker compose version >/dev/null 2>&1; then
  echo "!! 找不到 docker compose 插件（Debian/Ubuntu 上试：apt-get install -y docker-compose-plugin）"
  echo "   代码已经拉下来了，但容器没重建 —— 旧版仍在正常运行。"
  exit 1
fi
"${COMPOSE_CMD[@]}" up -d --build

# ---------- 4. 健康检查 ----------
echo "==> 4/5 健康检查"
OK=0
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    OK=1
    echo "    服务已就绪（http://127.0.0.1:${PORT}/api/health）"
    break
  fi
  sleep 1
done

if [ "$OK" != "1" ]; then
  echo "!! 30 秒内没起来，最近 40 行日志："
  "${COMPOSE_CMD[@]}" logs --tail=40 api 2>&1 | sed 's/^/     /' || true
  cat <<EOF

  回滚到更新前的版本（数据在 ${DATA_NOTE} 里，不受影响）：
      git reset --hard ${OLD_FULL}
      ${COMPOSE_CMD[*]} up -d --build

  跑回旧版之后用 git fetch && git merge --ff-only origin/${BRANCH} 可以再回到最新。
  把这台机器的报错贴出来看看是什么问题。

EOF
  exit 1
fi

# ---------- 5. 收尾 ----------
echo "==> 5/5 完成"
if [ "$NEW" = "$OLD" ]; then
  TITLE="重建完成（代码未变，仍是 ${OLD}）"
else
  TITLE="更新完成：${OLD} → ${NEW}"
fi
cat <<EOF

============================================================
  ${TITLE}
============================================================

  服务：curl http://127.0.0.1:${PORT}/api/health
  数据：${DATA_NOTE}（重建容器不影响它）

  提醒：手机 App 里的页面是**安装包自带的**，更新服务端不会改变 App 界面，
  数据是实时的会一起更新。界面本身有改动时要装新 APK（见 Releases 页）。

EOF

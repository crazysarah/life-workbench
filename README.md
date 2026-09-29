# 生活工作台 · 自建版

一个装在手机上的 App（Capacitor 套壳 APK）+ 一套自己掌控的服务端（Docker Compose）。
记账、习惯打卡、减脂健身、日程、待买清单、书影音收藏六个模块，
数据存在**你自己的服务器**上，换手机重新登录数据都在。

- 前端：单文件页面（约 190 KB，零外部依赖），数据层指向自建 API
- 后端：Node 22 + Express + SQLite，单容器，数据卷持久化
- 客户端：Capacitor 7 套壳成安卓 APK，前端内嵌在包里（断网也能开界面）
- 部署：`docker compose up -d --build` 一条命令
- 出包：GitHub Actions 云端构建 APK，本机不需要装 Android SDK

---

## 架构

```
┌──────────────────────────────┐
│  手机 App（Capacitor APK）    │
│  ├─ WebView 加载内嵌前端       │
│  └─ fetch ──► /api/*          │
└───────────────┬───────────────┘
                │ HTTP(S)
                ▼
┌──────────────────────────────┐
│  你的服务器 (Docker)          │
│  ├─ api   Node22 + Express    │
│  │        └─ SQLite (数据卷)   │
│  └─ caddy 可选：自动 HTTPS     │
└──────────────────────────────┘
```

前端页面本身不直连数据库，所有读写都通过那四个函数走 HTTP：

| 前端函数 | HTTP | 说明 |
|---|---|---|
| `dbFetchAll(table, cb)` | `GET /api/t/:table` | 拉全表 |
| `dbAdd(table, props, cb)` | `POST /api/t/:table` | 新增 |
| `dbUpdate(table, id, props)` | `PATCH /api/t/:table/:id` | 修改（合并字段） |
| `dbDelete(table, id)` | `DELETE /api/t/:table/:id` | 删除 |

六张表的 `table` 取值：`money` `habit` `plan` `fitness` `shopping` `media`。

---

## 一、服务端部署

### 1. 准备

服务器需要装了 Docker 和 Docker Compose 插件。Debian/Ubuntu 上：

```bash
curl -fsSL https://get.docker.com | sh
docker --version && docker compose version
```

### 2. 上传代码

```bash
# 本地：把仓库推到你的服务器
scp -r life-workbench root@150.109.255.241:/opt/
# 或者用 git（更推荐）
# 服务器上：git clone <你的仓库地址> /opt/life-workbench
```

### 3. 配置

```bash
cd /opt/life-workbench
cp .env.example .env
vi .env
```

`.env` 里至少改这两个：

```ini
APP_PASSWORD=你自己的口令        # 手机 App 首次打开要输这个
APP_SECRET=一串足够长的随机字符   # 用来派生登录态
HTTP_PORT=8080
```

### 4. 启动

```bash
docker compose up -d --build
docker compose logs -f api
```

看到 `[life-workbench] listening on 0.0.0.0:8080` 就是好了。

### 5. 验证

```bash
curl http://127.0.0.1:8080/api/health
# {"ok":true,"service":"life-workbench","time":...}

# 登录拿 token
curl -s -X POST http://127.0.0.1:8080/api/login \
  -H 'Content-Type: application/json' \
  -d '{"password":"你的口令"}'

# 用 token 读表
curl -s http://127.0.0.1:8080/api/tables -H "Authorization: Bearer <token>"
```

### 6. 放行端口

云控制台的安全组要放行 `HTTP_PORT`（默认 8080）。腾讯云轻量：**防火墙** → 添加规则 → TCP 8080。

> 服务器本机能 `curl` 通、手机连不上，九成是安全组没放行。

---

## 二、构建 APK

APK 里的前端是**内嵌**的，服务端地址在构建时写死进去。所以先确定地址：

```
http://150.109.255.241:8080
```

### 方式 A：GitHub Actions（推荐）

本机不需要 JDK / Android SDK，push 到 GitHub 自动出包。

1. 把仓库推到你的 GitHub
2. 打开仓库 → **Settings → Actions → General**，确认 Actions 是启用的
3. 改地址：编辑 `.github/workflows/build-apk.yml` 里的 `DEFAULT_API_BASE`
4. 推送代码，或到 **Actions → Build Android APK → Run workflow** 手动触发
5. 跑完在 workflow 页面底部 **Artifacts** 下载 `life-workbench-apk-debug`

> Android SDK 和 Gradle 依赖第一次要下几分钟，后续有缓存会快。

### 方式 B：本地构建

需要 JDK 21 和 Android SDK（装 Android Studio 最省事）。

```bash
# 一键：生成页面 → 拷资源 → 装 Capacitor → 建安卓工程 → 打补丁
bash build/sync_mobile.sh http://150.109.255.241:8080

cd mobile/android
./gradlew assembleDebug
```

产物：`mobile/android/app/build/outputs/apk/debug/app-debug.apk`

Windows 上在 Git Bash 里跑同样的命令。

---

## 三、装到手机

1. 把 `app-debug.apk` 传到手机（微信/QQ 传给自己、或用 `adb install`）
2. 点开安装，系统提示「未知来源应用」时允许一次
3. 打开 App → 输入 `.env` 里的 `APP_PASSWORD` → 连上就能用了

之后每次打开都是全屏、无地址栏，数据自动同步。

```bash
# 有 adb 的话更省事
adb install -r app-debug.apk
```

---

## 四、换服务器地址

APK 里的地址是构建时写死的。两种情况：

**服务器 IP 变了**：改 `.github/workflows/build-apk.yml` 的 `DEFAULT_API_BASE`，
重新触发一次构建，装新的 APK。

**只是想临时试另一个地址**：App 里连不上时，可以用手机连电脑调试（`chrome://inspect`），
在 Console 里执行：

```js
lw.base('http://新地址:8080')   // 改地址并持久化
lw.state()                      // 看当前状态
lw.login()                      // 重新弹登录框
```

---

## 五、升级域名 + HTTPS

明文 HTTP 能用，但有两个代价：Android 上要放开明文流量（已在补丁里处理），
以及部分网络环境下会被中间设备干扰。有域名就走 HTTPS：

1. 域名 A 记录指向服务器公网 IP
2. `.env` 里填 `DOMAIN=life.example.com` 和 `ACME_EMAIL=you@example.com`
3. 把 `docker-compose.yml` 里 `api` 服务的 `ports:` 两行删掉（只让 Caddy 对外）
4. `docker compose --profile https up -d --build`

Caddy 会自动申请并续期 Let's Encrypt 证书。之后把 APK 的地址改成
`https://life.example.com` 重新构建即可。

> 轻量服务器广州节点绑域名走 80/443 需要备案；香港 / 首尔不用。

---

## 六、备份与恢复

数据就是一个 SQLite 文件，在 `./data/` 目录。

```bash
# 备份（容器运行中也安全，用 sqlite 的在线备份）
docker compose exec api sh -c 'kill -STOP 1; cp /data/workbench.db /data/backup.db; kill -CONT 1'
cp data/backup.db ~/workbench-$(date +%F).db

# 或者直接停服再拷
docker compose stop api && cp -r data ~/workbench-backup-$(date +%F) && docker compose start api
```

恢复：把 `.db` 文件放回 `data/` 目录，重启容器。

```bash
docker compose restart api
```

建议加个 crontab 每天拷一份：

```cron
0 4 * * * cd /opt/life-workbench && cp data/workbench.db /root/backups/workbench-$(date +\%F).db
```

---

## 七、接口速查

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查，免认证 |
| POST | `/api/login` | `{"password":"..."}` → `{token}` |
| GET | `/api/tables` | 六张表的清单和条数 |
| GET | `/api/t/:table` | 读表，支持 `?limit=&offset=` |
| POST | `/api/t/:table` | 新增，body `{"properties":{...}}` → `{record_id}` |
| PATCH | `/api/t/:table/:id` | 改，body `{"properties":{...}}`（只带变更字段） |
| DELETE | `/api/t/:table/:id` | 删 |
| POST | `/api/t/:table/import` | 批量导入，body `{"rows":[{...}]}` |
| POST | `/api/t/:table/clear` | 清空该表，body `{"confirm":true}` |

除 `/api/health` 和 `/api/login` 外都要带 `Authorization: Bearer <token>`。

字段名沿用中文（`日期`、`金额`、`分类` …），存储层是 JSON，加字段不用改表结构。

---

## 八、常见问题

**手机连不上服务器**
按顺序查：① 服务端 `curl 127.0.0.1:端口/api/health` 通不通 → ② 云控制台安全组放行没有
→ ③ `docker compose logs api` 有没有报错 → ④ 手机浏览器直接开 `http://IP:端口/api/health` 看有没有响应。

**App 打开白屏**
多半是口令没输或输错。下拉刷新一般会重新弹登录框；不行就杀掉重开。
调试可以连电脑看 `chrome://inspect` 的 Console。

**改成新口令后 App 进不去**
token 是从口令派生的，改 `APP_PASSWORD` 会让所有旧 token 失效，
App 里重新输一次新口令即可。

**数据写到一半断网了怎么办**
前端有离线队列：写失败的操作会暂存在手机上，联网后（或每 20 秒自动重试）补传，
补传成功会弹一句「离线期间的改动已全部同步」。

**想清空某张表**
```bash
curl -X POST http://127.0.0.1:8080/api/t/money/clear \
  -H "Authorization: Bearer <token>" \
  -H 'Content-Type: application/json' \
  -d '{"confirm":true}'
```

**怎么从之前的资料库版本迁数据过来**
先 `POST /api/t/:table/import`，body 里放 `{"rows":[{...拍平的字段...}]}`。
字段名和资料库版一致，直接导。

---

## 项目结构

```
life-workbench/
├─ server/                 后端服务
│  ├─ Dockerfile
│  ├─ package.json
│  └─ src/
│     ├─ index.js          路由 + 启动
│     ├─ db.js             SQLite 建表与读写
│     ├─ tables.js         六张表的定义 + 属性拍平
│     └─ auth.js           口令认证
├─ client/                 前端页面
│  ├─ index.html           构建产物（由 build/make_client.py 生成）
│  ├─ manifest.webmanifest
│  └─ icon*.svg
├─ build/                  构建脚本
│  ├─ adapter.js           替换掉原资料库 SDK 的 API 适配器
│  ├─ make_client.py       生成 client/index.html
│  ├─ sync_mobile.sh       一键生成安卓工程
│  └─ patch_android.py     给安卓工程打明文流量补丁
├─ mobile/                 Capacitor 壳
│  ├─ package.json
│  ├─ capacitor.config.json
│  └─ android/             （自动生成，不入库）
├─ deploy/Caddyfile        可选：自动 HTTPS
├─ docker-compose.yml
├─ .env.example
└─ .github/workflows/build-apk.yml
```

---

## 安全提醒

- `.env` 别提交到公开仓库（已在 `.gitignore` 里）
- 单用户口令认证，够个人用；要多人共用得另做账号体系
- 建议把 `APP_SECRET` 设成足够长的随机串，别用示例值

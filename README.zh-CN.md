# 生活工作台 · 自建版

[English](README.md) | **简体中文**

> 英文版 `README.md` 是精简 Quick Start（面向国际访客）；
> **完整文档以本页为准** —— HTTPS、备份恢复、接口速查、自检、项目结构等都只在这里。
> 两份文档的改动请一起改，`build/check_docs.py` 会盯着最基本的一致性。

一个装在手机上的 App（Capacitor 套壳 APK）+ 一套自己掌控的服务端（Docker Compose）。
记账、习惯打卡、减脂健身、日程、待买清单、书影音收藏六个模块，
数据存在**你自己的服务器**上，换手机重新登录数据都在。

- 前端：单文件页面（约 190 KB，零外部依赖），数据层指向自建 API
- 后端：Node 22 + Express + SQLite，单容器，数据卷持久化
- 客户端：Capacitor 7 套壳成安卓 APK，前端内嵌在包里（断网也能开界面）
- 服务器地址：**装完在 App 里就能填 / 能改**（右下角齿轮），不用为了换地址重新打包
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
│  └─ api   Node22 + Express    │
│           └─ SQLite (数据卷)   │
│                               │
│  反代（可选，你自己决定）        │
│  已有 nginx/Traefik 就用现成的  │
│  没有再用仓库自带的 Caddy        │
└──────────────────────────────┘
```

**`docker compose up -d --build` 只起后端**，一条命令直接可用。
仓库自带的 Caddy 是可选件，放在 `deploy/docker-compose.caddy.yml`，
需要时叠加使用；你已经有反代就完全不用理它。

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
# 本地：把仓库推到你的服务器（换成你自己的 IP / 域名）
scp -r life-workbench root@你的服务器IP:/opt/
# 或者用 git（更推荐）
# 服务器上：git clone <你的仓库地址> /opt/life-workbench
```

### 3. 配置

```bash
cd /opt/life-workbench
cp .env.example .env
vi .env
```

`.env` 里至少改这几个：

```ini
APP_PASSWORD=你自己的口令        # 手机 App 首次打开要输这个
APP_SECRET=一串足够长的随机字符   # 用来派生登录态
HTTP_PORT=8080
PUBLIC_BASE_URL=               # 你的服务器对外地址，例 http://203.0.113.10:8080
```

`PUBLIC_BASE_URL` 就是**手机要连的地址**，留空的话部署脚本会自动探测公网 IP。

`BIND_ADDR` 决定服务端口对谁开放，按你的情况选：

| 你的情况 | `BIND_ADDR` | 反代上游填什么 |
|---|---|---|
| 直接 IP 访问，没反代 | 留空（= `0.0.0.0`） | — |
| 本机已有 nginx / Traefik 等反代 | `127.0.0.1` | `http://127.0.0.1:8080` |
| 反代也跑在 docker 里 | `127.0.0.1`，并把 `docker-compose.yml` 里 `api` 的 `ports:` 两行删掉 | `http://life-workbench-api:8080` |

填 `127.0.0.1` 之后，8080 只对本机开放，公网上扫不到这个端口，比直连安全。

`DATA_VOLUME` 决定数据库文件放哪，**建议留空**：

| 填什么 | 效果 | 备份方式 |
|---|---|---|
| 留空（推荐） | 用 docker 卷 `lw-data` | `docker compose cp api:/data/workbench.db ./备份.db` |
| `./data` | 存到仓库目录下，宿主机上直接可见 | 直接 `cp data/workbench.db` |

⚠️ **用 `./data` 必须先授权，否则容器起不来**：

```bash
mkdir -p data && sudo chown -R 1000:1000 data
```

原因：容器里跑的是 uid 1000 的 `node`，而 docker 自动创建的宿主目录属于 `root:root`。
挂载会**覆盖镜像里对 `/data` 的授权**，所以镜像层面修不了这件事。
漏了这步的表现是容器反复重启，日志里刷 `SqliteError: unable to open database file`。

### 4. 启动

**推荐一键脚本**，它会自动装 Docker、生成 `.env` 和随机口令、构建启动、跑健康检查，
最后把访问地址和口令打在屏幕上：

```bash
cd /opt/life-workbench
bash deploy/setup-server.sh
```

端口被占了就换一个：`bash deploy/setup-server.sh --port 18080`

需要仓库自带的 Caddy 自动签证书才加 `--caddy`（**已有反代就不要加**）：

```bash
bash deploy/setup-server.sh --caddy
```

**想手动控制**就自己来：

```bash
cp .env.example .env && vi .env    # 至少改 APP_PASSWORD
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
> 如果 `BIND_ADDR=127.0.0.1`（前面已有反代），这个端口**不用对公网放行**，
> 只需放行你反代自己的 80 / 443。

### 7. 以后怎么更新

仓库有新提交时（新功能、修 bug），在服务器上、仓库目录里跑一条命令：

```bash
bash deploy/update-server.sh
```

它会依次做：检查有没有未提交的改动 → `git pull` → 重建镜像并重启 → 健康检查。
**数据在 docker 卷里，重建容器不会动它。**

```bash
bash deploy/update-server.sh --check     # 只看有没有新版，什么都不改
bash deploy/update-server.sh --caddy     # 当初用 --caddy 装的，要带上这个参数
```

它拒绝在「工作区有未提交改动」时继续（否则 `git pull` 会打架）——
`.env` 不受影响，它在 `.gitignore` 里，你自己的配置不会被碰。

不想用脚本的话，等价于手工三条：

```bash
git pull && docker compose up -d --build
curl http://127.0.0.1:8080/api/health
```

**新版起不来怎么办**：脚本会打印回滚命令（把代码切回更新前那个提交再重建），
数据同样不受影响。也可以先看日志定位：`docker compose logs --tail=50 api`。

> ⚠️ **更新服务端不会改变 App 的界面。** 手机 App 里的页面是**安装包自带的**，
> 服务端只提供数据。所以数据会实时更新，但界面本身有改动时必须装新 APK
> （见 [Releases](https://github.com/crazysarah/life-workbench/releases/latest)）。
> 用浏览器直接打开服务端地址的话，刷新就是最新的页面。

---

## 二、接上你自己的反代

已经有 nginx / Traefik / 自己的 Caddy 的，按这三步接：

1. `.env` 里设 `BIND_ADDR=127.0.0.1`，然后 `docker compose up -d --build`
2. 反代上游指向 `http://127.0.0.1:8080`（反代在 docker 里则用 `http://life-workbench-api:8080`）
3. 反代配置里记得带这两个头，否则日志里看不到真实来源 IP：

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

再把这个地址填进 `.env` 的 `PUBLIC_BASE_URL`（例 `https://life.example.com`），
它就是手机要连的地址，也要同步填到 GitHub 仓库变量 `API_BASE` 用于出包。

> 页面本身是单文件、零外部依赖，反代**不需要**额外配 WebSocket、缓存或压缩，
> 普通 HTTP 转发即可。

---

## 三、构建 APK

**服务端地址不必在构建时写死了** —— App 装到手机上之后可以自己填、自己改
（首次启动会引导，之后随时点右下角的齿轮按钮）。

所以出包时地址是**可选**的：

| 你想怎样 | 怎么做 |
|---|---|
| 一个包给所有人用，各自填自己的服务器 | 什么都不用配，直接构建 |
| 给自己用，懒得每次填 | 配一个「内置默认地址」，用户填过的地址优先级更高 |

内置地址形如：

```
http://你的服务器IP:端口      例：http://203.0.113.10:8080
https://你的域名            例：https://life.example.com
```

> 仓库里的 `client/index.html` 是**已经构建好的成品**（资料库的绑定属性和表 id 都清理过了），
> 出包时只需给它换一个内置地址，所以走 `build/inject_api_base.py`。
> 只有在改了 `build/adapter.js` 之后才需要从原始页面完整重建
> （`build/make_client.py`）——那要求你自备资料库导出的原始页面，
> 源码库不收录它，因为它带着资料库的数据库 id。

服务器那边自己的地址配置在 `.env` → `PUBLIC_BASE_URL`（只影响部署脚本打印的访问地址）。
Actions 读不到服务器上的 `.env`，所以要内置的话在仓库 **Variables** → `API_BASE` 里填同一个值。

### 方式 A：GitHub Actions（推荐）

本机不需要 JDK / Android SDK，push 到 GitHub 自动出包。

1. 把仓库推到你的 GitHub
2. 打开仓库 → **Settings → Actions → General**，确认 Actions 是启用的
3. （可选）内置默认地址：**Settings → Secrets and variables → Actions → Variables → New variable**
   名称 `API_BASE`，值填你的服务器地址（例 `http://203.0.113.10:8080`）。
   不配也能出包，装好后在 App 里填一次即可
4. 推送代码，或到 **Actions → Build Android APK → Run workflow** 手动触发
   （手动触发时也能在 `api_base` 输入框临时填一个地址，会覆盖变量）
5. 跑完在 workflow 页面底部 **Artifacts** 下载 `life-workbench-apk-debug`

> 工作流里的地址只出现在「构建时内置」这一步；公开仓库的日志会对它打码。
> 没配地址也不会失败 —— 那种包里没有内置地址，首次打开会引导用户填写。
> 自检失败（设置逻辑或页面静态检查不过）会直接停下，不会出一个坏包。

> Android SDK 和 Gradle 依赖第一次要下几分钟，后续有缓存会快。

### 方式 B：本地构建

需要 JDK 21 和 Android SDK（装 Android Studio 最省事）。

```bash
# 不内置地址（装好后自己填）
bash build/sync_mobile.sh

# 或者内置一个默认地址
bash build/sync_mobile.sh http://你的服务器IP:8080

cd mobile/android
./gradlew assembleDebug
```

产物：`mobile/android/app/build/outputs/apk/debug/app-debug.apk`

Windows 上在 Git Bash 里跑同样的命令。

---

## 四、装到手机

**不想自己构建？** 直接到 [**Releases**](https://github.com/crazysarah/life-workbench/releases/latest)
下预构建的 APK —— 同一套包，不内置地址，装完在 App 里填自己的服务器（见下面第 3 步）。

1. 把 APK 传到手机（微信/QQ 传给自己、或用 `adb install`）
2. 点开安装，系统提示「未知来源应用」时允许一次
3. 打开 App：
   - **包里内置过地址** → 直接输入 `.env` 里的 `APP_PASSWORD` 就能用
   - **没内置地址** → 会先弹出服务器设置，填 `http://服务器IP:端口`，
     点「测试连接」确认通了，再填口令保存
4. 之后每次打开都是全屏、无地址栏，数据自动同步

```bash
# 有 adb 的话更省事
adb install -r app-debug.apk
```

---

## 五、换服务器地址

装好之后**在 App 里就能改，不用重新打包**：

1. 点右下角的齿轮按钮（在「中文 / EN」开关上方）打开服务器设置
2. 改「服务器地址」→ 建议先点「测试连接」确认服务端在跑
3. 填「访问口令」→ 点「保存并连接」

面板里还能看到当前地址、在线/本地模式、待同步条数，以及「清除本机口令」和
「填回内置默认地址」两个操作。

面板底部还有一块**数据维护**：内置示例数据没清干净时会出现「清空示例数据（N 条）」。
这个入口原本是页面顶部那颗垃圾桶按钮 —— 手机上又小又容易误触，就收进设置里了。
它只删内置的示例记录 / 示例打卡 / 示例收藏，你自己录入的内容一律不动。

几个行为上的细节：

- 地址容错：只填 IP 或 `IP:端口` 会自动补 `http://`；结尾带不带 `/` 或 `/api` 都认
- **换到另一台服务器**：本机口令会清掉（旧服务器签发的 token 在新服务器上无效），
  需要重新登录；上一台服务器的本地缓存也会清掉，避免显示错的数据
- **离线队列不会丢**：还没同步到服务器的改动会保留，登录后自动补传
- 同一个地址重复保存不会清口令

命令行 / 远程调试时也可以直接改（手机连电脑开 `chrome://inspect`，在 Console 里；
注意包里 `webContentsDebuggingEnabled` 默认是 `false`，要调试得先把它改成 `true` 重新打包）：

```js
lw.settings()                    // 打开设置面板
lw.base('http://新地址:8080')     // 直接改地址并持久化
lw.base()                        // 读当前地址
lw.probe('http://新地址:8080')    // 探活
lw.state()                       // 看状态（地址/在线/待同步条数）
lw.login()                       // 重新弹登录框
```

**出厂内置地址**想改的话：改 GitHub 仓库变量 `API_BASE`（和服务端 `.env` 的
`PUBLIC_BASE_URL`），重新构建装新包 —— 但只有在用户没自己填过地址时才生效。

---

## 六、升级域名 + HTTPS

明文 HTTP 能用，但有两个代价：Android 上要放开明文流量（已在补丁里处理），
以及部分网络环境下会被中间设备干扰。有域名就走 HTTPS。

**已经有反代的**：直接在你自己那套里加一个站点指向 `http://127.0.0.1:8080`
（见第二节），证书用你现有的方式签，不用动这个仓库。

**没有反代的**：用仓库自带的 Caddy，自动申请并续期 Let's Encrypt 证书。

1. 域名 A 记录指向服务器公网 IP
2. `.env` 里填 `DOMAIN=life.example.com`，建议连 `ACME_EMAIL=you@example.com` 一起填
3. 启动时叠加 Caddy 文件：

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.caddy.yml up -d --build
```

脚本也一样，加 `--caddy` 即可，它会自动把 `BIND_ADDR` 收到 `127.0.0.1`：

```bash
bash deploy/setup-server.sh --caddy
```

之后把 APK 的地址改成 `https://life.example.com` 重新构建即可。

> Caddy 要占 80 / 443，本机已有反代就不要用这个文件，会端口冲突。
> 轻量服务器广州节点绑域名走 80/443 需要备案；香港 / 首尔不用。

---

## 七、备份与恢复

数据就是一个 SQLite 文件（外加 WAL 的 `-wal` / `-shm` 两个附属文件），
容器里的路径固定是 `/data/workbench.db`，只是物理位置随 `DATA_VOLUME` 变。

**通用备份（两种模式都行，容器跑着也能拷）**

```bash
docker compose cp api:/data/workbench.db ~/workbench-$(date +%F).db
```

**`DATA_VOLUME` 留空（docker 卷）** —— 想直接摸到文件，去卷的挂载点：

```bash
sudo ls /var/lib/docker/volumes/life-workbench_lw-data/_data/
```

**`DATA_VOLUME=./data`（宿主目录）** —— 最直观，直接拷：

```bash
cp data/workbench.db ~/workbench-$(date +%F).db
```

恢复都是塞回去再重启：

```bash
docker compose cp ~/workbench-2026-09-29.db api:/data/workbench.db
docker compose exec api sh -c 'rm -f /data/workbench.db-wal /data/workbench.db-shm'
docker compose restart api
```

> 恢复前把那两个 WAL 附属文件清掉，否则可能读到旧内容。
> 换成自己的备份文件名再执行。

建议加个 crontab 每天拷一份：

```cron
0 4 * * * cd /opt/life-workbench && docker compose cp api:/data/workbench.db /root/backups/workbench-$(date +\%F).db
```

---

## 八、接口速查

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

## 九、常见问题

**容器反复重启，日志刷 `SqliteError: unable to open database file`**

数据库文件写不进去。九成是**宿主目录属主不对**：

```bash
ls -ldn data            # 看 uid/gid，容器里跑的是 uid 1000
```

容器里是 uid 1000 的 `node`，而 docker 自动创建的宿主目录属于 `root:root`（`uid=0`）→
建不了 `workbench.db`，连 WAL 的 `-wal` / `-shm` 也建不出来。

挂载会**覆盖镜像里对 `/data` 的授权**，所以在 Dockerfile 里 `chown` 是没用的，
只能在宿主机这一侧解决。两个办法：

```bash
# A. 最快：把宿主目录让给 uid 1000
sudo chown -R 1000:1000 ./data && docker compose restart api

# B. 推荐：改用 docker 卷，权限随镜像走，永远不会踩这个坑
#    把 .env 里的 DATA_VOLUME 留空（或整行删掉），然后：
docker compose up -d
```

> 换成卷之后，之前那个 root 属主的 `data/` 目录就没用了：`sudo rm -rf data`
> （确认里面没有你要留的数据库文件再删）。

新版本的日志会把目录属主、进程身份和这三条解法直接打出来，照着做即可。

**`docker compose up` 报 `required variable DOMAIN is missing a value`**

说明你跑的是旧版代码——Caddy 还在主文件里。这个报错**跟要不要用 Caddy 无关**：
Docker Compose 是先对整份文件做变量插值、之后才判断服务启不启动，
所以 `${DOMAIN:?...}` 这种「必需变量」写法只要出现在文件里，
哪怕 Caddy 的 profile 没激活，命令也会直接失败。

现在的 `docker-compose.yml` 已经不含 Caddy，拉最新代码即可：

```bash
bash deploy/update-server.sh      # 推荐，带健康检查；起不来会提示回滚
# 手工等价：
git pull && docker compose up -d --build
```

**我已经有自己的反代，怎么接**

`.env` 里设 `BIND_ADDR=127.0.0.1`，反代上游指向 `http://127.0.0.1:8080`。
详见第二节。

**手机连不上服务器**
先在 App 里点右下角齿轮 → 设置面板 → 点「测试连接」，它会直接告诉你卡在哪一步
（连不上/超时/服务端返回了什么）。再按顺序查：① 服务端 `curl 127.0.0.1:端口/api/health`
通不通 → ② 云控制台安全组放行没有 → ③ `docker compose logs api` 有没有报错
→ ④ 手机浏览器直接开 `http://IP:端口/api/health` 看有没有响应。

**改了服务器地址 / 换了台服务器**
不用重装 App：右下角齿轮 → 改地址 → 保存并连接。详见第五节。
（换服务器后要重新输口令，这是正常的 —— 旧服务器签发的 token 在新服务器上无效。）

**地址填对了还是连不上**
检查地址是不是写全了端口（`http://IP:8080`，不是 `http://IP`）；
如果是 https，证书必须是**受信任的** —— 自签证书 WebView 会直接拒绝，
用 http 或者换成受信任的证书。

**找不到「清空示例」了**
它收进设置面板了：右下角齿轮 → 面板底部「数据维护」→ 清空示例数据。
只在还有示例数据时出现，清空后那里会变成「示例数据已经清空」。
（原先是页面顶部的一颗垃圾桶按钮，手机上太小容易误触，已移除。）

**App 打开白屏**
多半是还没配服务器地址、或者没输口令。新版首次打开会自动弹设置面板引导填写；
填过之后如果还白，下拉刷新会重新弹登录框，不行就杀掉 App 重开。
调试可以连电脑看 `chrome://inspect` 的 Console（需要先把
`mobile/capacitor.config.json` 里的 `webContentsDebuggingEnabled` 改成 `true` 重新打包）。

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

## 本地自检

改完配置或前端之后，不用起 Docker 也能先验一遍：

```bash
node build/test_settings.js       # 设置面板逻辑（108 项：地址容错、换服务器清态、探活、面板 DOM、清空示例、齿轮）
python3 build/check_client.py     # 客户端产物：语法、外链、宿主残留
python3 build/check_compose.py    # compose 结构与变量（需 pyyaml）
python3 build/check_docs.py       # 双语文档：语言互链、英文版无残留中文、引用的文件都在

# 服务器地址设置的端到端（32 项，脚本自己拉一个临时服务端起来，跑完关掉）
node build/test_settings_e2e.js

# 服务端接口端到端（33 项，要自己先起服务端）
cd server && node src/index.js &
python3 build/smoke_test.py
```

`test_settings.js` / `test_settings_e2e.js` 用最小 DOM stub 把 `build/adapter.js`
直接跑在 Node 里（脚手架见 `build/_harness.js`），不需要浏览器或真机 ——
本机没安卓环境时也能验「App 内改服务器地址」这条链路。
`test_settings_e2e.js` 会真起一个服务端，把「填地址 → 测试连接 → 保存 → 拉到数据」
整条路走通，包括口令填错、地址填错这些岔路。

`check_compose.py` 会模拟 Compose 的变量插值并校验 YAML 层级 ——
本地没装 Docker 时 `docker compose config` 跑不了，它顶这个位。

`test_settings.js` 和 `check_client.py` 已经在 Actions 里当门禁，
之后改前端跑一遍就行（`test_settings_e2e.js` 需要 server 依赖，没进 CI）。

`check_docs.py` 是两份 README 的守门人：这两份文档分头维护（英文版是精简版，
中文版是完整版，内容并不逐条对应），最容易出的事就是只改了一份。
它检查两份都在、开头都有语言切换链接、各自只保留一个 H1、必需章节没被删掉、
正文点名的仓库文件真实存在，以及**英文版里没有残留的中文正文**。
它跑在独立的 `check-docs.yml` 里（秒级），不牵动 Android 构建。

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
├─ build/                  构建与自检脚本
│  ├─ adapter.js           替换掉原资料库 SDK 的 API 适配器（含服务器地址设置面板）
│  ├─ make_client.py       从原始页面完整生成 client/index.html（重建用；含页面功能补丁）
│  ├─ inject_api_base.py   给成品页面注入内置默认地址（日常构建走这个，可留空）
│  ├─ sync_mobile.sh       一键生成安卓工程
│  ├─ patch_android.py     给安卓工程打明文流量补丁
│  ├─ check_client.py      客户端产物静态自检
│  ├─ _harness.js          测试脚手架（最小 DOM / localStorage / vm 装载器）
│  ├─ test_settings.js     服务器地址设置逻辑离线自测（不需要浏览器/真机/服务端）
│  ├─ test_settings_e2e.js 同一套逻辑的端到端自测（自己起临时服务端）
│  ├─ check_compose.py     compose 结构与变量自检（本地没 docker 时顶替 compose config）
│  ├─ check_docs.py        两份 README 的自检（语言互链、英文版无残留中文、引用有效）
│  └─ smoke_test.py        服务端端到端冒烟测试
├─ mobile/                 Capacitor 壳
│  ├─ package.json
│  ├─ capacitor.config.json
│  └─ android/             （自动生成，不入库）
├─ deploy/
│  ├─ Caddyfile                    可选：自动 HTTPS（配下面那个文件用）
│  ├─ docker-compose.caddy.yml     可选：Caddy 服务定义，不需要就别管
│  ├─ setup-server.sh              服务器端一键安装（--caddy 才启用 Caddy）
│  └─ update-server.sh             服务器端更新（拉代码 → 重建 → 健康检查，可回滚）
├─ docker-compose.yml
├─ .env.example
├─ README.md               英文（精简 Quick Start，GitHub 首页默认展示）
├─ README.zh-CN.md         中文（本文件，完整文档）
└─ .github/workflows/
   ├─ build-apk.yml        云端构建 APK
   └─ check-docs.yml       两份 README 的一致性自检
```

---

## 安全提醒

- `.env` 别提交到公开仓库（已在 `.gitignore` 里）
- 单用户口令认证，够个人用；要多人共用得另做账号体系
- 建议把 `APP_SECRET` 设成足够长的随机串，别用示例值

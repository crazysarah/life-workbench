# Life Workbench · Self-hosted

**English** | [简体中文](README.zh-CN.md)

> This is a **condensed Quick Start** aimed at English readers: architecture, server deploy,
> APK build, install, changing the server address, and troubleshooting.
> The full documentation — HTTPS/domain upgrade, backup & restore, API reference, local
> self-checks, complete project layout, long-form FAQ — lives in
> [README.zh-CN.md](README.zh-CN.md) (Chinese).

A personal life app you host yourself: an installable Android app (Capacitor shell) plus a
server you control (Docker Compose). Six modules — ledger, habits, fitness, schedule, shopping
list, media collection. **Your data lives on your own server**: wipe the phone, log in again,
everything is still there.

- **Frontend** — one self-contained HTML page (~190 KB, zero external dependencies); its data layer talks to your own API
- **Backend** — Node 22 + Express + SQLite, a single container with a persistent volume
- **Client** — Capacitor 7 shell → Android APK; the UI is bundled inside, so it opens offline
- **Server address** — settable **inside the app** (gear button, bottom-right); no rebuild needed to point it at another server
- **Deploy** — `docker compose up -d --build`
- **Build** — GitHub Actions produces the APK; no local Android SDK required

---

## Architecture

```
┌──────────────────────────────┐
│  Phone app (Capacitor APK)   │
│  ├─ WebView loads bundled UI │
│  └─ fetch ──► /api/*         │
└───────────────┬──────────────┘
                │ HTTP(S)
                ▼
┌──────────────────────────────┐
│  Your server (Docker)        │
│  └─ api   Node 22 + Express  │
│           └─ SQLite (volume) │
│                              │
│  reverse proxy (optional)    │
│  already have nginx/Traefik? │
│  use yours — otherwise the   │
│  bundled Caddy               │
└──────────────────────────────┘
```

`docker compose up -d --build` starts **the backend only** — one command and you are up. The
bundled Caddy is optional and kept in `deploy/docker-compose.caddy.yml`; if you already run a
reverse proxy you can ignore it completely.

The page never talks to a database directly. Every read and write goes through four functions
that speak HTTP:

| Front-end function | HTTP | Purpose |
|---|---|---|
| `dbFetchAll(table, cb)` | `GET /api/t/:table` | fetch the whole table |
| `dbAdd(table, props, cb)` | `POST /api/t/:table` | insert |
| `dbUpdate(table, id, props)` | `PATCH /api/t/:table/:id` | update (fields merged) |
| `dbDelete(table, id)` | `DELETE /api/t/:table/:id` | delete |

`table` is one of `money`, `habit`, `plan`, `fitness`, `shopping`, `media`.

---

## 1. Deploy the server

### Requirements

Docker with the Compose plugin (Debian/Ubuntu):

```bash
curl -fsSL https://get.docker.com | sh
docker --version && docker compose version
```

### Get the code

```bash
# from your machine
scp -r life-workbench root@YOUR_SERVER_IP:/opt/

# or, on the server (preferred)
git clone <your-repo-url> /opt/life-workbench
```

### Configure

```bash
cd /opt/life-workbench
cp .env.example .env
vi .env
```

The four values that matter:

```ini
APP_PASSWORD=choose-your-own       # the app asks for this on first launch
APP_SECRET=a-long-random-string    # derives login tokens
HTTP_PORT=8080
PUBLIC_BASE_URL=                   # public address, e.g. http://203.0.113.10:8080
```

`PUBLIC_BASE_URL` is **the address your phone will connect to**. Leave it empty and the deploy
script probes for the public IP itself.

`BIND_ADDR` decides who can reach the port — pick the row that matches your setup:

| Your setup | `BIND_ADDR` | Reverse-proxy upstream |
|---|---|---|
| Direct IP access, no proxy | leave empty (= `0.0.0.0`) | — |
| You already run nginx / Traefik on the host | `127.0.0.1` | `http://127.0.0.1:8080` |
| Your proxy runs in Docker too | `127.0.0.1`, and delete the two `ports:` lines under `api` in `docker-compose.yml` | `http://life-workbench-api:8080` |

With `127.0.0.1` the port is host-local only — not reachable from, or scannable on, the internet.

`DATA_VOLUME` decides where the database file lives. **Leave it empty.**

| Value | Where it lands | How to back it up |
|---|---|---|
| empty (recommended) | Docker named volume `lw-data` | `docker compose cp api:/data/workbench.db ./backup.db` |
| `./data` | a directory in the repo, visible on the host | `cp data/workbench.db` directly |

⚠️ **With `./data` you must fix ownership first, or the container will not start:**

```bash
mkdir -p data && sudo chown -R 1000:1000 data
```

The container runs as `node`, uid 1000. Docker creates host directories as `root:root`, and the
bind mount **overrides the ownership baked into the image** — which is why this cannot be fixed
at the image level. Skip it and you get a container stuck in a restart loop logging
`SqliteError: unable to open database file`.

### Start

The one-shot script installs Docker, generates `.env` with a random password, builds, starts,
health-checks, and prints the URL and password:

```bash
cd /opt/life-workbench
bash deploy/setup-server.sh
```

Port taken? `bash deploy/setup-server.sh --port 18080`

Add `--caddy` only if you want the bundled Caddy to fetch certificates
(**do not** if you already run a reverse proxy):

```bash
bash deploy/setup-server.sh --caddy
```

Or drive it manually:

```bash
cp .env.example .env && vi .env    # at minimum, set APP_PASSWORD
docker compose up -d --build
docker compose logs -f api
```

You are up when you see `[life-workbench] listening on 0.0.0.0:8080`.

### Verify

```bash
curl http://127.0.0.1:8080/api/health
# {"ok":true,"service":"life-workbench","time":...}

# log in for a token
curl -s -X POST http://127.0.0.1:8080/api/login \
  -H 'Content-Type: application/json' \
  -d '{"password":"YOUR_PASSWORD"}'

# read tables with it
curl -s http://127.0.0.1:8080/api/tables -H "Authorization: Bearer <token>"
```

### Open the port

Open `HTTP_PORT` (default 8080) in your cloud firewall. On Tencent Cloud Lighthouse:
**Firewall → Add rule → TCP 8080**.

> If `curl` works on the server but your phone cannot connect, it is almost always the security
> group. With `BIND_ADDR=127.0.0.1` you do **not** expose 8080 publicly — open 80/443 for your
> own reverse proxy instead.

### Updating later

When the repo has new commits, one command on the server (inside the repo directory):

```bash
bash deploy/update-server.sh
```

It checks for uncommitted changes → `git pull` → rebuilds and restarts → health check.
**Your data lives in a docker volume, so rebuilding containers does not touch it.**

```bash
bash deploy/update-server.sh --check     # only report whether an update exists, change nothing
bash deploy/update-server.sh --caddy     # if you installed with --caddy
```

It refuses to run with uncommitted changes (that would make `git pull` conflict) — your `.env`
is unaffected, it is gitignored.

Without the script, it is just:

```bash
git pull && docker compose up -d --build
curl http://127.0.0.1:8080/api/health
```

**If the new version fails to start**, the script prints the rollback commands (reset to the
previous commit and rebuild) — your data is untouched either way. Diagnostics:
`docker compose logs --tail=50 api`.

> ⚠️ **Updating the server does not change the app's UI.** The page inside the Android app is
> **bundled into the APK**; the server only serves data. So your data updates live, but UI
> changes require installing a new APK (see
> [Releases](https://github.com/crazysarah/life-workbench/releases/latest)).
> Opening the server address in a browser always shows the current page.

---

## 2. Behind your own reverse proxy

Already running nginx / Traefik / your own Caddy? Three steps:

1. Set `BIND_ADDR=127.0.0.1` in `.env`, then `docker compose up -d --build`
2. Point the upstream at `http://127.0.0.1:8080` (`http://life-workbench-api:8080` if your proxy is containerised)
3. Forward these headers, or logs lose the real client IP:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Then put that public address in `.env` → `PUBLIC_BASE_URL` (e.g. `https://life.example.com`) —
it is what the phone connects to — and, if you want it baked into the APK, in the GitHub
repository variable `API_BASE`.

> The page is a single file with zero external dependencies; the proxy needs **no** WebSocket,
> caching or compression rules. Plain HTTP forwarding is enough.

---

## 3. Build the APK

**The server address no longer has to be baked in at build time.** Once installed, the app lets
you enter and change it — guided on first launch, then any time via the gear button.

So supplying an address at build time is **optional**:

| Goal | What to do |
|---|---|
| One APK for everyone, each person fills in their own server | nothing to configure — just build |
| Your own APK, no retyping | configure a built-in default; a user-typed address always wins |

A built-in address looks like:

```
http://YOUR_SERVER_IP:PORT      e.g. http://203.0.113.10:8080
https://your.domain             e.g. https://life.example.com
```

> `client/index.html` in this repo is the **pre-built artifact** (all bindings and table IDs
> from the original page platform stripped out), so a build only has to swap the address —
> which is what `build/inject_api_base.py` does. Only if you modified `build/adapter.js` do you
> need a full rebuild via `build/make_client.py`; that requires the original exported page,
> which this repo does not include because it carries platform database IDs.

Server-side, your own address lives in `.env` → `PUBLIC_BASE_URL` (it only affects the address
the deploy script prints). Actions cannot read your `.env`, so to bake one in, set the same
value in the repository **Variables** → `API_BASE`.

### Option A — GitHub Actions (recommended)

No JDK or Android SDK needed locally; push and it builds.

1. Push the repo to your GitHub
2. **Settings → Actions → General** — make sure Actions is enabled
3. *(optional)* baked-in default: **Settings → Secrets and variables → Actions → Variables → New variable**, name `API_BASE`, value your server address (e.g. `http://203.0.113.10:8080`). Skipping this is fine — the user enters it once inside the app
4. Push, or run **Actions → Build Android APK → Run workflow** manually (the `api_base` input overrides the variable for that run)
5. Download `life-workbench-v1.0.2-debug` from **Artifacts** at the bottom of the run page
   (the version in the name comes from `VERSION` — see below)

> The address only appears in the "inject" step, and public-repo logs mask it.
> A missing address is not an error — that APK simply prompts on first launch.
> A failing self-check stops the build rather than shipping a broken package.

> The first run downloads the Android SDK and Gradle dependencies (a few minutes); later runs hit the cache.

### Option B — local build

Requires JDK 21 and the Android SDK (installing Android Studio is the easy way).

```bash
# no baked-in address (the user fills it in after installing)
bash build/sync_mobile.sh

# or bake in a default
bash build/sync_mobile.sh http://YOUR_SERVER_IP:8080

cd mobile/android
./gradlew assembleDebug
```

Output: `mobile/android/app/build/outputs/apk/debug/app-debug.apk`

On Windows, run the same commands in Git Bash.

### Versioning

There is exactly **one** source of truth for the version: the `VERSION` file in the repo root
(contents like `1.0.2`). Change it and push — CI injects it into the package.

```
versionName = VERSION as-is                       what Android shows under Settings → Apps
versionCode = major*10000 + minor*100 + patch     what the system compares (1.0.2 → 10002)
```

**Do not edit `mobile/android/app/build.gradle` directly.** That directory is generated by
`npx cap add android`, excluded via `.gitignore`, and never committed — the scaffold always
creates `versionCode 1` / `versionName "1.0"`. Your local copy does not exist during a CI
build, and even if it did, `cap sync` would overwrite it.

That is exactly how the historical bug happened: the version inside every package stayed at
`1.0`, so installing a new build still showed `1.0`, and a re-install looked like the very
same version.

CI enforces two things:

| Step | What it does |
|---|---|
| Inject version | Writes `build.gradle` **after** `cap sync` |
| Verify packaged version | Unpacks the APK and reads the binary `AndroidManifest.xml`; fails the whole pipeline on any mismatch with `VERSION` |

Local builds take the same path (the last step of `build/sync_mobile.sh`). You can double-check
an artifact yourself:

```bash
python3 build/check_apk_version.py    # auto-discovers the artifact if you pass no path
```

It reads the manifest straight out of the APK — the same thing `aapt dump badging` does,
without needing the Android SDK.

### Cutting a release

```bash
echo 1.0.3 > VERSION                           # 1. bump — this is the only place
python3 build/set_version.py --check           # 2. optional: see the mapping locally
git commit -am "release: v1.0.3" && git push   # 3. push; CI builds it
```

Download `life-workbench-v1.0.3-debug` from the run page, then publish a **Release** tagged
`v1.0.3` with the APK attached. The download links in this README point at
`/releases/latest`, so no doc changes are needed.

> Existing users just install over the top — their data lives on their own server.

---

## 4. Install on your phone

**Don't want to build it yourself?** Grab the prebuilt APK from
[**Releases**](https://github.com/crazysarah/life-workbench/releases/latest) — same package,
no baked-in address, so you fill in your server on first launch (step 3 below).

1. Copy the APK to the phone (send it to yourself, or use `adb install`)
2. Tap to install; allow "install from unknown sources" once
3. Open the app:
   - **address was baked in** → just enter the `APP_PASSWORD` from `.env`
   - **no baked-in address** → the settings panel appears first; enter `http://YOUR_SERVER_IP:PORT`,
     tap **Test connection** to confirm it is reachable, then save with your password
4. From then on it opens full-screen with no address bar, syncing automatically

```bash
# easier with adb
adb install -r app-debug.apk
```

---

## 5. Changing the server address

Available **inside the app — no rebuild required**:

1. Tap the gear button at the bottom-right (above the 中文 / EN switch) to open server settings
2. Edit **Server address** — tapping **Test connection** first is recommended
3. Enter the **password**, then tap **Save and connect**

The panel also shows the current address, online/local mode and pending-sync count, plus
**clear local password** and **restore built-in default**.

At the bottom there is a **Data maintenance** section: while sample data is still present it
offers **Clear sample data (N)**. That entry used to be a trash-can button in the page header —
too small and too easy to hit by accident on a phone, so it moved into settings. It only
deletes the bundled sample records / check-ins / bookmarks; anything you entered yourself is
untouched.

Behaviours worth knowing:

- **Address tolerance** — a bare host or `host:port` gets `http://` prepended; a trailing `/` or `/api` is accepted
- **Switching to another server** clears the local password (tokens issued by the old server are invalid anyway) and the cached records pulled from that server, so you never see stale data
- **The offline queue survives** — edits not yet synced are kept and flushed automatically after you log in
- **Re-saving the same address** does not clear your password

Over remote debugging (open `chrome://inspect` from your computer) you can also drive it from
the Console — note `webContentsDebuggingEnabled` defaults to `false` in
`mobile/capacitor.config.json`, so set it to `true` and rebuild if you need this:

```js
lw.settings()                     // open the settings panel
lw.base('http://NEW_ADDR:8080')   // set + persist the address
lw.base()                         // read the current address
lw.probe('http://NEW_ADDR:8080')  // health check
lw.state()                        // address / online / pending count
lw.login()                        // re-open the login prompt
```

To change the **factory default**: update the GitHub variable `API_BASE` (and `PUBLIC_BASE_URL`
in the server `.env`) and rebuild — it only applies to users who never typed an address.

---

## Troubleshooting

**Container restart loop, log full of `SqliteError: unable to open database file`**

The database file cannot be written. Nine times out of ten the host directory has the wrong owner:

```bash
ls -ldn data            # check uid/gid — the container runs as uid 1000
```

```bash
# A. quickest — hand the host directory to uid 1000
sudo chown -R 1000:1000 ./data && docker compose restart api

# B. recommended — switch to a Docker volume and never hit this again
#    clear DATA_VOLUME in .env (or delete the line), then:
docker compose up -d
```

> The old root-owned `data/` directory is then dead weight: `sudo rm -rf data`
> (check it holds no database file you want to keep first).

Newer builds print the directory owner, the process identity and these two fixes straight into
the log.

**`docker compose up` fails with `required variable DOMAIN is missing a value`**

You are on an old revision where Caddy was still in the main compose file. The error has
nothing to do with whether you use Caddy: Docker Compose interpolates the **whole file** before
deciding which services to start, so a `${DOMAIN:?...}` required-variable expression fails the
command even when the Caddy profile is inactive. The current `docker-compose.yml` contains no
Caddy — just pull:

```bash
bash deploy/update-server.sh      # recommended: rebuild + health check, prints rollback on failure
# or manually:
git pull && docker compose up -d --build
```

**Phone cannot reach the server**

In the app: gear button → settings → **Test connection**; it tells you which step failed
(unreachable / timed out / what the server returned). Then check in order:
① `curl 127.0.0.1:PORT/api/health` on the server → ② cloud firewall / security group →
③ `docker compose logs api` → ④ open `http://IP:PORT/api/health` in the phone's browser.

**Changed the address, or moved to another server**

No reinstall needed: gear button → edit the address → save and connect. Re-entering the
password afterwards is expected — tokens issued by the old server are invalid on the new one.

**Correct address, still failing**

Make sure the port is included (`http://IP:8080`, not `http://IP`). For HTTPS the certificate
must be **trusted** — self-signed certificates are rejected outright by the WebView; use HTTP or
a trusted certificate.

**Blank screen on open**

Usually no server address configured, or no password entered. New builds prompt with the
settings panel on first launch; if it still stays blank, pull-to-refresh re-opens the login
prompt, otherwise kill the app and reopen. Debug via `chrome://inspect` (see section 5).

**Changed `APP_PASSWORD` and now the app will not get in**

Tokens are derived from the password, so changing it invalidates every existing token. Just
re-enter the new password in the app.

**Wrote data while offline**

There is an offline queue: failed writes are kept on the phone and replayed once the network
returns (or every 20 seconds). A successful flush reports "offline changes synced".

**Want to empty a table**

```bash
curl -X POST http://127.0.0.1:8080/api/t/money/clear \
  -H "Authorization: Bearer <token>" \
  -H 'Content-Type: application/json' \
  -d '{"confirm":true}'
```

**Migrating data from the original page-platform version**

Use `POST /api/t/:table/import` with `{"rows":[{...flattened fields...}]}`. Property names
match, so you can import as-is.

---

## Security notes

- Never commit `.env` to a public repo (it is already in `.gitignore`)
- Single-user password auth — fine for personal use; multi-user would need a real account system
- Set `APP_SECRET` to a sufficiently long random string, not the sample value

---

## Full documentation

**[README.zh-CN.md](README.zh-CN.md)** (Chinese) — HTTPS and domain upgrade, backup & restore,
API reference, local self-checks, the complete project layout, and the long-form FAQ.

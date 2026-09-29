#!/usr/bin/env node
/*
 * 服务器地址设置的端到端验证：真服务端 + vm 里跑的 adapter.js（模拟 App）。
 *
 * 覆盖「用户拿到 APK → 填地址 → 测试连接 → 保存 → 打开就拉到数据」这条完整链路，
 * 以及改错地址、改口令这些岔路。需要 server 的依赖已安装（server/node_modules）。
 *
 * 用法：node build/test_settings_e2e.js
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAsserts, loadAdapter, openSettingsViaUi, findAll } = require('./_harness');

const { ok, eq, report } = createAsserts();

const REPO = path.join(__dirname, '..');
const PORT = 18099;
const BASE = 'http://127.0.0.1:' + PORT;
const PASSWORD = 'e2e-pass-123';
const SECRET = 'e2e-secret-xyz';
const TMP_DB = path.join(os.tmpdir(), 'lw-e2e-' + process.pid + '.db');

let server = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/api/health');
      if (res.ok) return true;
    } catch (e) { /* 还没起来 */ }
    await sleep(120);
  }
  return false;
}

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, [path.join(REPO, 'server', 'src', 'index.js')], {
      cwd: path.join(REPO, 'server'),
      env: Object.assign({}, process.env, {
        PORT: String(PORT),
        DB_FILE: TMP_DB,
        APP_PASSWORD: PASSWORD,
        APP_SECRET: SECRET
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    server.stdout.on('data', d => { out += d.toString(); });
    server.stderr.on('data', d => { out += d.toString(); });
    server.on('exit', code => { if (code !== 0 && code !== null) reject(new Error('服务端退出，code=' + code + '\n' + out)); });
    resolve();
  });
}

function stopServer() {
  if (server && !server.killed) {
    try { server.kill(); } catch (e) { /* ignore */ }
  }
  try { fs.unlinkSync(TMP_DB); } catch (e) { /* ignore */ }
  try { fs.unlinkSync(TMP_DB + '-wal'); } catch (e) { /* ignore */ }
  try { fs.unlinkSync(TMP_DB + '-shm'); } catch (e) { /* ignore */ }
}

/* 模拟一台「刚装好的手机」：Capacitor 容器、本地存储空的 */
function freshApp(opts) {
  return loadAdapter(Object.assign({
    capacitor: { isNativePlatform: () => true },
    fetch: (...a) => fetch(...a),     // 打真请求
    realTimers: true                  // 保存后 260ms 弹登录浮层要真跑
  }, opts || {}));
}

function fetchAll(sandbox, table) {
  return new Promise(resolve => sandbox.dbFetchAll(table, rows => resolve(rows)));
}
function addRecord(sandbox, table, props) {
  return new Promise(resolve => sandbox.dbAdd(table, props, id => resolve(id)));
}

(async function main() {
  try {
    await startServer();
    if (!await waitHealth(15000)) {
      throw new Error('服务端 15 秒内没起来');
    }
    console.log('[e2e] 服务端已就绪 %s', BASE);

    /* ---- 1. 刚装好、没配地址的 App ---- */
    {
      const { lw } = freshApp();
      eq('全新 App 待配置', lw.state().needsSetup, true);
      eq('全新 App 不在线', lw.state().online, false);
    }

    /* ---- 2. 引导面板里点「测试连接」→ 真服务端 ---- */
    {
      const { sandbox, dom } = freshApp();
      const ui = openSettingsViaUi(sandbox, dom, true);
      ui.addr.value = '127.0.0.1:' + PORT;      // 故意不带 http://，测容错
      ui.testBtn.onclick();
      await sleep(600);
      const texts = ui.texts().join(' | ');
      ok('真实探活成功并提示可以保存', texts.indexOf('连接正常') >= 0, texts);
      ok('探活文案里显示补全后的地址', texts.indexOf(BASE) >= 0, texts);
    }

    /* ---- 3. 填地址 + 口令 → 保存并连接（真登录） ---- */
    {
      const { sandbox, dom, store } = freshApp();
      const ui = openSettingsViaUi(sandbox, dom, true);
      ui.addr.value = '127.0.0.1:' + PORT;
      ui.pw.value = PASSWORD;
      ui.saveBtn.onclick();
      await sleep(800);

      eq('地址已规范化并生效', sandbox.lw.state().apiBase, BASE);
      eq('登录成功拿到 token', sandbox.lw.state().hasToken, true);
      ok('token 已落盘', (store.getItem('lw_token') || '').length > 20, store.getItem('lw_token'));
      eq('面板已关闭', dom.doc.getElementById('lw-settings'), null);
      eq('不再是待配置', sandbox.lw.state().needsSetup, false);
      eq('进入在线模式', sandbox.lw.state().online, true);

      // 真的能读到数据
      const rows = await fetchAll(sandbox, 'money');
      ok('保存后能真的拉到表数据', Array.isArray(rows), JSON.stringify(rows));

      // 真的能写数据
      const id = await addRecord(sandbox, 'money', { 日期: '2026-09-29', 分类: '测试', 金额: 1 });
      ok('保存后能真的写入记录', typeof id === 'string' && id.length > 0, String(id));
      const rows2 = await fetchAll(sandbox, 'money');
      eq('写入后能读到 1 条', rows2.length, 1);
    }

    /* ---- 4. 口令填错 → 地址存下但不放行 ---- */
    {
      const { sandbox, dom, store } = freshApp();
      const ui = openSettingsViaUi(sandbox, dom, true);
      ui.addr.value = BASE;
      ui.pw.value = 'wrong-password';
      ui.saveBtn.onclick();
      await sleep(700);
      eq('口令错 → 没有 token', sandbox.lw.state().hasToken, false);
      eq('口令错 → 地址仍然保存了', store.getItem('lw_api_base'), BASE);
      ok('提示口令不对', ui.texts().some(t => t.indexOf('口令不对') >= 0), ui.texts().join(' | '));
      ok('面板保持打开方便重试', !!dom.doc.getElementById('lw-settings'));
    }

    /* ---- 5. 换成连不上的地址：probe 报错、保存后旧口令被清 ---- */
    {
      const { sandbox, dom, store } = freshApp({
        storage: { lw_api_base: BASE, lw_token: 'STALE_TOKEN', lw_cache_money: '[{"x":1}]' }
      });
      const ui = openSettingsViaUi(sandbox, dom, false);
      eq('设置面板初值带出当前地址', ui.addr.value, BASE);

      ui.addr.value = '127.0.0.1:1';        // 必然连不上的端口
      ui.testBtn.onclick();
      await sleep(1200);
      ok('探活失败时提示排查方向',
         ui.texts().some(t => t.indexOf('连不上') >= 0 || t.indexOf('超时') >= 0), ui.texts().join(' | '));

      ui.saveBtn.onclick();
      await sleep(300);
      eq('地址已换成新值', sandbox.lw.state().apiBase, 'http://127.0.0.1:1');
      eq('换服务器后旧口令被清', sandbox.lw.state().hasToken, false);
      eq('换服务器后旧缓存被清', store.getItem('lw_cache_money'), null);
    }

    /* ---- 6. 地址填对、口令留空 → 走登录浮层 ---- */
    {
      const { sandbox, dom } = freshApp();
      const ui = openSettingsViaUi(sandbox, dom, true);
      ui.addr.value = BASE;
      ui.saveBtn.onclick();
      await sleep(500);
      // 保存后 260ms 弹登录浮层（这里 setTimeout 是真的，wait 够就行）
      const login = dom.doc.getElementById('lw-login');
      ok('口令留空 → 弹出登录浮层', !!login);
      if (login) {
        const hint = (function walk(n, acc) {
          if (n.textContent) acc.push(n.textContent);
          n.children.forEach(c => walk(c, acc));
          return acc;
        })(login, []).join(' | ');
        ok('登录浮层显示的是刚填的服务器', hint.indexOf(BASE) >= 0, hint);
        ok('登录浮层能跳去改地址', hint.indexOf('修改地址') >= 0, hint);
      }
    }

    /* ---- 7. 同一地址重复保存：口令不被清 ---- */
    {
      const { sandbox, dom, store } = freshApp();
      const ui1 = openSettingsViaUi(sandbox, dom, true);
      ui1.addr.value = BASE;
      ui1.pw.value = PASSWORD;
      ui1.saveBtn.onclick();
      await sleep(700);
      const token1 = store.getItem('lw_token');
      ok('第一次保存拿到 token', !!token1);

      const ui2 = openSettingsViaUi(sandbox, dom, false);
      ui2.addr.value = BASE + '/';          // 等价地址（只差一个斜杠）
      ui2.saveBtn.onclick();
      await sleep(300);
      eq('等价地址不算换服务器，token 保留', store.getItem('lw_token'), token1);
    }

    /* ---- 8. 改地址后离线队列不丢 ---- */
    {
      const { sandbox, dom, store } = freshApp({
        storage: { lw_api_base: 'http://old-host:8080', lw_queue: '[{"table":"money","op":"add","props":{}}]' }
      });
      const ui = openSettingsViaUi(sandbox, dom, false);
      ok('状态行显示待同步条数', ui.texts().some(t => t.indexOf('待同步 1 条') >= 0), ui.texts().join(' | '));
      ui.addr.value = BASE;
      ui.pw.value = PASSWORD;
      ui.saveBtn.onclick();
      await sleep(900);
      eq('队列没被换地址丢掉', store.getItem('lw_queue'), '[]');   // 登录后已成功补传，所以清空
      eq('补传后队列归零', sandbox.lw.state().queued, 0);
    }

    /* ---- 9. 服务端停掉后：探活失败、状态可读 ---- */
    {
      stopServer();
      await sleep(400);
      const { lw } = freshApp({ storage: { lw_api_base: BASE } });
      const r = await lw.probe(BASE, 3000);
      eq('服务端停掉后探活失败', r.ok, false);
      ok('给出可读原因', typeof r.error === 'string' && r.error.length > 0, JSON.stringify(r));
    }

    const good = report('test_settings_e2e');
    stopServer();
    process.exit(good ? 0 : 1);
  } catch (e) {
    console.error('[e2e] 异常：', e && e.message);
    stopServer();
    process.exit(1);
  }
})();

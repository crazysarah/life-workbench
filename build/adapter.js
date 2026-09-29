/* ================= Self-hosted API adapter =================
   本区块整体替换原「Database SDK Integration」区块。
   四个函数 dbFetchAll / dbAdd / dbUpdate / dbDelete 的签名与原版完全一致，
   因此上游 push* / updateRemote* / deleteRemote* / pullAllRemote 一行都不用改。
   ========================================================================== */

var DB_MONEY = 'money';
var DB_HABIT = 'habit';
var DB_PLAN = 'plan';
var DB_FITNESS = 'fitness';
var DB_SHOPPING = 'shopping';
var DB_MEDIA = 'media';

var LW_TABLE_NAMES = {
  money: '记账', habit: '习惯', plan: '日程',
  fitness: '健身', shopping: '待买', media: '书影音'
};

/* ---- 服务端地址解析：优先构建时注入，其次本地设置 ---- */
var LW_INJECTED = (typeof window.__LW_CONFIG__ === 'object' && window.__LW_CONFIG__) ? window.__LW_CONFIG__ : null;
var API_BASE = '';
var LW_HAS_API = false;
if (LW_INJECTED && typeof LW_INJECTED.apiBase === 'string') {
  API_BASE = LW_INJECTED.apiBase;
  LW_HAS_API = true;
}
try {
  var lwSavedBase = localStorage.getItem('lw_api_base');
  if (lwSavedBase !== null) { API_BASE = lwSavedBase; LW_HAS_API = true; }
} catch (e) { /* 隐私模式下忽略 */ }
API_BASE = String(API_BASE || '').replace(/\/+$/, '');

var ONLINE = LW_HAS_API;
var LOCAL_ONLY = false;
var LW_TOKEN = '';
try { LW_TOKEN = localStorage.getItem('lw_token') || ''; } catch (e) { /* ignore */ }

function goLocalOnly(reason) {
  console.warn('[api] ' + reason);
}

/* ------------------------------ 提示条 ------------------------------ */
function lwToast(msg, kind) {
  try {
    if (!document.body) return;
    var host = document.getElementById('lw-toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'lw-toast-host';
      host.style.cssText = 'position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:100002;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;width:max-content;max-width:92vw;';
      document.body.appendChild(host);
    }
    var bg = kind === 'error' ? '#b3261e' : (kind === 'warn' ? '#8a5a00' : '#1f6f43');
    var el = document.createElement('div');
    el.style.cssText = 'pointer-events:auto;background:' + bg + ';color:#fff;padding:10px 16px;border-radius:12px;font-size:14px;line-height:1.5;box-shadow:0 6px 24px rgba(0,0,0,.18);max-width:92vw;word-break:break-word;';
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .3s';
      el.style.opacity = '0';
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 320);
    }, kind === 'error' ? 5600 : 2800);
  } catch (e) { /* ignore */ }
}

/* ------------------------------ 请求封装 ------------------------------ */
function lwSaveToken(t) {
  LW_TOKEN = t || '';
  try { localStorage.setItem('lw_token', LW_TOKEN); } catch (e) { /* ignore */ }
}

function lwRequest(method, path, body, skipAuthPrompt) {
  var headers = { 'Content-Type': 'application/json' };
  if (LW_TOKEN) headers['Authorization'] = 'Bearer ' + LW_TOKEN;
  var opts = { method: method, headers: headers };
  if (body !== undefined && body !== null) opts.body = JSON.stringify(body);

  return fetch(API_BASE + path, opts).then(function (res) {
    if (res.status === 401) {
      if (!skipAuthPrompt) lwAskLogin();
      var e401 = new Error('UNAUTHORIZED');
      e401.status = 401;
      throw e401;
    }
    return res.text().then(function (txt) {
      var data = null;
      try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
      if (!res.ok) {
        var err = new Error((data && data.message) || ('HTTP ' + res.status));
        err.status = res.status;
        throw err;
      }
      return data;
    });
  });
}

/* ------------------------------ 登录浮层 ------------------------------ */
function lwAskLogin(force) {
  if (document.getElementById('lw-login')) return;
  if (!ONLINE) { lwToast('没有配置服务端地址，当前是纯本地模式', 'error'); return; }

  var mask = document.createElement('div');
  mask.id = 'lw-login';
  mask.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(28,24,20,.62);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);z-index:100001;display:flex;align-items:center;justify-content:center;padding:24px;';

  var box = document.createElement('div');
  box.style.cssText = 'background:#fffdfa;border-radius:20px;padding:26px 24px;max-width:380px;width:100%;box-shadow:0 24px 70px rgba(0,0,0,.28);box-sizing:border-box;';

  var title = document.createElement('div');
  title.textContent = '连接你的工作台';
  title.style.cssText = 'font-size:17px;font-weight:600;color:#2a2622;margin-bottom:6px;';

  var desc = document.createElement('div');
  desc.textContent = '输入服务端口令。数据保存在你自己的服务器上，换设备登录后数据都在。';
  desc.style.cssText = 'font-size:13px;color:#8a8177;line-height:1.6;margin-bottom:16px;';

  var input = document.createElement('input');
  input.type = 'password';
  input.placeholder = '访问口令';
  input.autocomplete = 'current-password';
  input.style.cssText = 'width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #ded7cd;border-radius:12px;font-size:16px;outline:none;background:#faf8f5;color:#2a2622;';

  var btn = document.createElement('button');
  btn.textContent = '连接';
  btn.style.cssText = 'margin-top:14px;width:100%;padding:12px;border:none;border-radius:12px;background:#2a2622;color:#fff;font-size:15px;font-weight:600;cursor:pointer;';

  var errBox = document.createElement('div');
  errBox.style.cssText = 'margin-top:10px;font-size:13px;color:#b3261e;min-height:18px;line-height:1.5;';

  var hint = document.createElement('div');
  hint.textContent = '服务器：' + (API_BASE || '同源');
  hint.style.cssText = 'margin-top:12px;font-size:11px;color:#b3aa9e;word-break:break-all;';

  box.appendChild(title);
  box.appendChild(desc);
  box.appendChild(input);
  box.appendChild(btn);
  box.appendChild(errBox);
  box.appendChild(hint);
  mask.appendChild(box);
  document.body.appendChild(mask);

  function submit() {
    var pw = input.value;
    if (!pw) { errBox.textContent = '请先输入口令'; return; }
    btn.disabled = true;
    btn.textContent = '连接中…';
    errBox.textContent = '';
    lwRequest('POST', '/api/login', { password: pw }, true).then(function (data) {
      if (!data || !data.token) throw new Error('服务端返回异常');
      lwSaveToken(data.token);
      if (mask.parentNode) mask.parentNode.removeChild(mask);
      lwToast('已连接', 'ok');
      lwFlushQueue();
      if (typeof pullAllRemote === 'function') {
        pullAllRemote(function (changed) {
          if (changed) {
            try { saveState(); } catch (e) { /* ignore */ }
            if (typeof renderAll === 'function') renderAll();
          }
        });
      }
    }).catch(function (e) {
      btn.disabled = false;
      btn.textContent = '连接';
      if (e && e.status === 401) {
        errBox.textContent = '口令不对，再试一次';
      } else {
        errBox.textContent = '连不上服务器：' + ((e && e.message) || '网络异常') + '。请检查地址、端口和网络。';
      }
    });
  }

  btn.onclick = submit;
  input.onkeydown = function (ev) { if (ev.key === 'Enter' || ev.keyCode === 13) submit(); };
  setTimeout(function () { try { input.focus(); } catch (e) { /* ignore */ } }, 80);
}

/* ------------------------------ 离线队列 ------------------------------ */
function lwQueueRead() {
  try { return JSON.parse(localStorage.getItem('lw_queue') || '[]'); } catch (e) { return []; }
}
function lwQueueWrite(q) {
  try { localStorage.setItem('lw_queue', JSON.stringify(q)); } catch (e) { /* ignore */ }
}
function lwQueueCount() { return lwQueueRead().length; }

var lwFlushing = false;
function lwFlushQueue() {
  if (!ONLINE || lwFlushing) return;
  var q = lwQueueRead();
  if (!q.length) return;
  lwFlushing = true;
  var i = 0;

  function step() {
    if (i >= q.length) {
      lwFlushing = false;
      lwQueueWrite([]);
      lwToast('离线期间的改动已全部同步', 'ok');
      if (typeof pullAllRemote === 'function') {
        pullAllRemote(function (changed) {
          if (changed) {
            try { saveState(); } catch (e) { /* ignore */ }
            if (typeof renderAll === 'function') renderAll();
          }
        });
      }
      return;
    }
    var it = q[i];
    var p;
    if (it.op === 'delete') {
      p = lwRequest('DELETE', '/api/t/' + encodeURIComponent(it.table) + '/' + encodeURIComponent(it.recordId));
    } else if (it.op === 'update') {
      p = lwRequest('PATCH', '/api/t/' + encodeURIComponent(it.table) + '/' + encodeURIComponent(it.recordId), { properties: it.props });
    } else {
      p = lwRequest('POST', '/api/t/' + encodeURIComponent(it.table), { properties: it.props });
    }
    p.then(function () { i++; step(); }).catch(function () {
      // 保留没成功的部分，等下次再推
      lwQueueWrite(q.slice(i));
      lwFlushing = false;
    });
  }
  step();
}

/* --------------------------- 与原 SDK 同签名的四个函数 --------------------------- */
var LW_WRAPPERS = ['text', 'number', 'date', 'currency', 'select', 'multiSelect'];

function lwFlatten(props) {
  var out = {};
  if (!props || typeof props !== 'object') return out;
  Object.keys(props).forEach(function (k) {
    var v = props[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      var ks = Object.keys(v);
      if (ks.length === 1 && LW_WRAPPERS.indexOf(ks[0]) >= 0) { out[k] = v[ks[0]]; return; }
    }
    out[k] = v;
  });
  return out;
}

function dbFetchAll(databaseId, cb) {
  if (!ONLINE || LOCAL_ONLY) { if (cb) cb(null); return; }
  lwRequest('GET', '/api/t/' + encodeURIComponent(databaseId) + '?limit=10000')
    .then(function (data) {
      var rows = (data && data.records) || [];
      // 落一份缓存，断网时至少能看到上次的数据
      try { localStorage.setItem('lw_cache_' + databaseId, JSON.stringify(rows)); } catch (e) { /* 超配额就放弃缓存 */ }
      if (cb) cb(rows);
    })
    .catch(function (err) {
      if (err && err.status === 401) { if (cb) cb(null); return; }
      var cached = null;
      try {
        var raw = localStorage.getItem('lw_cache_' + databaseId);
        cached = raw ? JSON.parse(raw) : null;
      } catch (e) { cached = null; }
      lwToast(
        '读取「' + (LW_TABLE_NAMES[databaseId] || databaseId) + '」失败：' + ((err && err.message) || '网络异常') +
        (cached ? '（当前显示本地缓存）' : '（可在网络恢复后重新打开页面重试）'),
        'error'
      );
      if (cb) cb(cached);
    });
}

function dbAdd(databaseId, props, cb) {
  if (!ONLINE || LOCAL_ONLY) { if (cb) cb(null); return; }
  var flat = lwFlatten(props);
  lwRequest('POST', '/api/t/' + encodeURIComponent(databaseId), { properties: flat })
    .then(function (data) {
      if (cb) cb((data && data.record_id) || null);
    })
    .catch(function (err) {
      if (err && err.status === 401) { if (cb) cb(null); return; }
      lwQueueWrite(lwQueueRead().concat([{ table: databaseId, op: 'add', recordId: null, props: flat, at: Date.now() }]));
      lwToast('「' + (LW_TABLE_NAMES[databaseId] || databaseId) + '」保存失败，已暂存本地，联网后会自动补传', 'warn');
      if (cb) cb(null);
    });
}

function dbUpdate(databaseId, recordId, props) {
  if (!ONLINE || LOCAL_ONLY || !recordId) return;
  var flat = lwFlatten(props);
  lwRequest('PATCH', '/api/t/' + encodeURIComponent(databaseId) + '/' + encodeURIComponent(recordId), { properties: flat })
    .catch(function (err) {
      if (err && err.status === 401) return;
      lwQueueWrite(lwQueueRead().concat([{ table: databaseId, op: 'update', recordId: recordId, props: flat, at: Date.now() }]));
      lwToast('修改未同步，已暂存本地，联网后会自动补传', 'warn');
    });
}

function dbDelete(databaseId, recordId) {
  if (!ONLINE || LOCAL_ONLY || !recordId) return;
  lwRequest('DELETE', '/api/t/' + encodeURIComponent(databaseId) + '/' + encodeURIComponent(recordId))
    .catch(function (err) {
      if (err && err.status === 401) return;
      lwQueueWrite(lwQueueRead().concat([{ table: databaseId, op: 'delete', recordId: recordId, props: null, at: Date.now() }]));
      lwToast('删除未同步，已暂存本地，联网后会自动补传', 'warn');
    });
}

/* ------------------------------ 启动钩子 ------------------------------ */
window.addEventListener('online', function () { setTimeout(lwFlushQueue, 800); });

setInterval(function () {
  if (lwQueueCount() > 0) lwFlushQueue();
}, 20000);

setTimeout(function () {
  if (!ONLINE) return;
  if (!LW_TOKEN) lwAskLogin();
  else lwFlushQueue();
}, 1400);

/* 调试口子：控制台里 window.lw.state() 看状态，window.lw.base('http://x:8080') 改地址 */
window.lw = {
  state: function () {
    return {
      apiBase: API_BASE,
      online: ONLINE,
      localOnly: LOCAL_ONLY,
      hasToken: !!LW_TOKEN,
      queued: lwQueueCount()
    };
  },
  base: function (v) {
    if (v === undefined) return API_BASE;
    API_BASE = String(v || '').replace(/\/+$/, '');
    try { localStorage.setItem('lw_api_base', API_BASE); } catch (e) { /* ignore */ }
    return API_BASE;
  },
  token: function (v) {
    if (v === undefined) return LW_TOKEN;
    lwSaveToken(v);
    return LW_TOKEN;
  },
  login: function () { lwAskLogin(true); },
  flush: lwFlushQueue
};

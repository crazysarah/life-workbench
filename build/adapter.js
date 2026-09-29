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

/* ==================== 服务端地址：装完 App 也能自己改 ====================
   解析优先级：**用户在设置面板里存的地址** > 构建时注入的默认地址。
   所以同一个 APK 可以连任意一台服务器，不必为了换地址重新打包。

   地址为空时的行为分两种：
     · 浏览器里（自托管 Web 版）→ 同源模式，请求走相对路径 /api/...
     · 套壳 App 里（Capacitor）→ 还没配置，启动后自动弹设置面板引导填写
   ====================================================================== */
var LW_KEY_BASE = 'lw_api_base';
var LW_KEY_TOKEN = 'lw_token';
var LW_KEY_SKIP = 'lw_setup_skipped';

function lwStoreGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lwStoreSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
function lwStoreDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }

/* 地址容错：允许只填 10.0.0.5 或 10.0.0.5:8080；
   自动补协议、去尾斜杠、去掉手滑加上的 /api（请求时本来就会拼 /api） */
function lwNormalizeBase(v) {
  var s = String(v == null ? '' : v).trim().replace(/\s+/g, '');
  if (!s) return '';
  if (!/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(s)) s = 'http://' + s;
  s = s.replace(/\/+$/, '').replace(/\/api$/i, '');
  return s;
}

/* 是否跑在套壳 App 里。Capacitor 容器的页面 origin 是 https://localhost，
   那里没有同源后端可用，所以没填地址就一定要引导用户去填。 */
function lwIsNativeApp() {
  try {
    var c = window.Capacitor;
    if (c) {
      if (typeof c.isNativePlatform === 'function') return !!c.isNativePlatform();
      if (typeof c.getPlatform === 'function') {
        var p = c.getPlatform();
        return p === 'android' || p === 'ios';
      }
    }
    if (location.protocol === 'https:' &&
        (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      return true;
    }
  } catch (e) { /* ignore */ }
  return false;
}

var LW_NATIVE = lwIsNativeApp();

var LW_INJECTED = (typeof window.__LW_CONFIG__ === 'object' && window.__LW_CONFIG__) ? window.__LW_CONFIG__ : null;
var LW_DEFAULT_BASE = '';
if (LW_INJECTED && typeof LW_INJECTED.apiBase === 'string') {
  LW_DEFAULT_BASE = lwNormalizeBase(LW_INJECTED.apiBase);
}

var API_BASE = '';
var LW_NEEDS_SETUP = false;   /* App 里还没填地址 */
var ONLINE = false;

function lwResolveConfig() {
  var saved = lwStoreGet(LW_KEY_BASE);
  API_BASE = (saved !== null) ? lwNormalizeBase(saved) : LW_DEFAULT_BASE;
  LW_NEEDS_SETUP = !API_BASE && LW_NATIVE;
  ONLINE = !!API_BASE || !LW_NATIVE;
}
lwResolveConfig();

var LOCAL_ONLY = false;
var LW_TOKEN = lwStoreGet(LW_KEY_TOKEN) || '';

/* 换服务器后旧缓存（上一台服务器的数据）会显示成「当前数据」，必须清掉 */
function lwClearCaches() {
  try {
    var kill = [], i;
    for (i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf('lw_cache_') === 0) kill.push(k);
    }
    for (i = 0; i < kill.length; i++) localStorage.removeItem(kill[i]);
  } catch (e) { /* ignore */ }
}

/* 保存地址并立即生效。返回地址是否真的变了。
   地址变了意味着换了一台服务器：旧口令是旧服务器签发的（留着只会一直 401），
   旧缓存也是旧服务器的数据 —— 两者都清掉，但**不清离线队列**（那是用户没同步的改动，不能丢）。 */
function lwSetBase(v) {
  var b = lwNormalizeBase(v);
  var changed = (b !== API_BASE);
  API_BASE = b;
  if (b) { lwStoreSet(LW_KEY_BASE, b); lwStoreDel(LW_KEY_SKIP); } else { lwStoreDel(LW_KEY_BASE); }
  LW_NEEDS_SETUP = !b && LW_NATIVE;
  ONLINE = !!b || !LW_NATIVE;
  if (changed && b) {
    lwSaveToken('');
    lwClearCaches();
  }
  return changed;
}

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
  if (LW_TOKEN) lwStoreSet(LW_KEY_TOKEN, LW_TOKEN); else lwStoreDel(LW_KEY_TOKEN);
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

/* ------------------------ 探活（/api/health 不需要口令） ------------------------ */
function lwProbe(base, timeoutMs) {
  return new Promise(function (resolve) {
    var addr = lwNormalizeBase(base);
    if (!addr) { resolve({ ok: false, status: 0, error: '地址为空' }); return; }
    /* AbortController 用来做超时。某些老 WebView 上它有但不完整，
       所以这里全程防御 —— 拿不到可用实例就退化成「没超时控制」，不要连探活都做不了。 */
    var ctl = null;
    if (typeof AbortController === 'function') {
      try {
        var c = new AbortController();
        if (c && c.signal) ctl = c;
      } catch (e) { ctl = null; }
    }
    var done = false;
    var timer = setTimeout(function () {
      if (done) return;
      done = true;
      if (ctl) { try { ctl.abort(); } catch (e) { /* ignore */ } }
      resolve({ ok: false, status: 0, error: '超时（' + ((timeoutMs || 8000) / 1000) + ' 秒无响应）' });
    }, timeoutMs || 8000);

    fetch(addr + '/api/health', { method: 'GET', signal: ctl ? ctl.signal : undefined })
      .then(function (res) {
        return res.text().then(function (txt) {
          var d = null;
          try { d = txt ? JSON.parse(txt) : null; } catch (e) { d = null; }
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve({ ok: res.ok, status: res.status, data: d });
        });
      })
      .catch(function (e) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, status: 0, error: (e && e.message) || '网络异常' });
      });
  });
}

/* ------------------------------ 登录浮层 ------------------------------ */
function lwAskLogin(force) {
  if (document.getElementById('lw-login')) return;
  /* 还没配地址就先去配地址，弹登录没有意义 */
  if (!ONLINE) { lwOpenSettings(LW_NEEDS_SETUP); return; }

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
  hint.style.cssText = 'margin-top:12px;font-size:11px;color:#b3aa9e;line-height:1.7;word-break:break-all;';
  hint.appendChild(document.createTextNode('服务器：' + (API_BASE || '未设置')));
  var editLink = document.createElement('a');
  editLink.href = '#';
  editLink.textContent = '修改地址';
  editLink.style.cssText = 'margin-left:8px;color:#b65f42;font-weight:700;text-decoration:none;';
  editLink.onclick = function (ev) {
    ev.preventDefault();
    if (mask.parentNode) mask.parentNode.removeChild(mask);
    lwOpenSettings(false);
  };
  hint.appendChild(editLink);

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
      lwRefreshAll();
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

/* ============================ 服务器设置面板 ============================
   装好 App 之后随时能改服务器地址 —— 右下角常驻一个小齿轮（在语言切换按钮上方）。
   没配地址的 App 启动时会自动弹出来引导填。
   ======================================================================= */
var LW_GEAR_STYLE_ID = 'lw-gear-style';

function lwEnsureGearStyle() {
  if (document.getElementById(LW_GEAR_STYLE_ID)) return;
  var st = document.createElement('style');
  st.id = LW_GEAR_STYLE_ID;
  st.textContent =
    // 常驻悬浮按钮：实心品牌色 + 明显投影，一眼能看到；移动端再放大一档方便点按
    '#lw-gear{position:fixed;right:18px;bottom:66px;z-index:91;width:46px;height:46px;padding:0;' +
    'display:flex;align-items:center;justify-content:center;border-radius:50%;cursor:pointer;' +
    'border:1px solid rgba(77,48,69,.92);background:#4d3047;color:#fffdfa;' +
    'box-shadow:0 8px 22px rgba(77,48,69,.32);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);' +
    'opacity:1;transition:transform .15s,box-shadow .2s,background .2s;-webkit-tap-highlight-color:transparent}' +
    '#lw-gear:active,#lw-gear:hover,#lw-gear.lw-on{background:#3d2639;transform:translateY(-1px);' +
    'box-shadow:0 11px 28px rgba(77,48,69,.4)}' +
    '#lw-gear svg{width:24px;height:24px;fill:none;stroke:currentColor}' +
    '#lw-gear.lw-alert{border-color:#b44d43;background:#b44d43;color:#fff;animation:lwGearPulse 2.4s infinite}' +
    '@keyframes lwGearPulse{50%{box-shadow:0 0 0 7px rgba(180,77,67,.22)}}' +
    '@media(max-width:860px){#lw-gear{right:14px;bottom:calc(130px + env(safe-area-inset-bottom));' +
    'width:54px;height:54px}#lw-gear svg{width:27px;height:27px}}';
  (document.head || document.documentElement).appendChild(st);
}

function lwMountGear() {
  if (!document.body) return;
  lwEnsureGearStyle();
  var b = document.getElementById('lw-gear');
  if (!b) {
    b = document.createElement('button');
    b.id = 'lw-gear';
    b.type = 'button';
    b.title = '服务器设置';
    b.setAttribute('aria-label', '服务器设置');
    b.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="12" cy="12" r="3.2"/>' +
      '<path d="M19.1 14.6a1.5 1.5 0 0 0 .3 1.65l.06.06a1.8 1.8 0 1 1-2.55 2.55l-.06-.06a1.5 1.5 0 0 0-1.65-.3 1.5 1.5 0 0 0-.9 1.37v.17a1.8 1.8 0 1 1-3.6 0v-.09a1.5 1.5 0 0 0-.98-1.37 1.5 1.5 0 0 0-1.65.3l-.06.06A1.8 1.8 0 1 1 4.46 16.4l.06-.06a1.5 1.5 0 0 0 .3-1.65 1.5 1.5 0 0 0-1.37-.9H3a1.8 1.8 0 1 1 0-3.6h.09a1.5 1.5 0 0 0 1.37-.98 1.5 1.5 0 0 0-.3-1.65l-.06-.06A1.8 1.8 0 1 1 6.65 4.95l.06.06a1.5 1.5 0 0 0 1.65.3h.08a1.5 1.5 0 0 0 .9-1.37V3.8a1.8 1.8 0 1 1 3.6 0v.09a1.5 1.5 0 0 0 .9 1.37 1.5 1.5 0 0 0 1.65-.3l.06-.06a1.8 1.8 0 1 1 2.55 2.55l-.06.06a1.5 1.5 0 0 0-.3 1.65v.08a1.5 1.5 0 0 0 1.37.9h.17a1.8 1.8 0 1 1 0 3.6h-.09a1.5 1.5 0 0 0-1.37.9z"/>' +
      '</svg>';
    b.onclick = function () { lwOpenSettings(false); };
    document.body.appendChild(b);
  }
  // 还没配地址的 App，齿轮变红提醒用户去点
  b.className = LW_NEEDS_SETUP ? 'lw-alert' : '';
}

/* 换完地址后统一收尾：补推离线队列 + 重新拉一遍远端数据 */
function lwRefreshAll() {
  if (!ONLINE || LOCAL_ONLY) return;
  lwFlushQueue();
  if (typeof pullAllRemote === 'function') {
    pullAllRemote(function (changed) {
      if (changed) {
        try { saveState(); } catch (e) { /* ignore */ }
        if (typeof renderAll === 'function') renderAll();
      }
    });
  }
}

/* 页面侧暴露的示例数据统计（见 build/make_client.py 里的页面补丁）。
   页面没提供这个能力时返回 -1，设置面板会把整块「数据维护」隐藏掉。 */
function lwSampleTotal() {
  if (typeof window.lwClearSamples !== 'function' || typeof window.lwSampleStatus !== 'function') return -1;
  try {
    var s = window.lwSampleStatus() || {};
    return (Number(s.total) || 0) + (Number(s.habits) || 0);
  } catch (e) { return -1; }
}

function lwOpenSettings(guide) {
  var prev = document.getElementById('lw-settings');
  if (prev && prev.parentNode) prev.parentNode.removeChild(prev);

  function el(tag, css, text) {
    var n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;
    return n;
  }

  var mask = el('div', 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(28,24,20,.62);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);z-index:100004;display:flex;align-items:center;justify-content:center;padding:20px;');
  mask.id = 'lw-settings';

  var box = el('div', 'background:#fffdfa;border-radius:20px;padding:22px 20px 20px;max-width:430px;width:100%;box-shadow:0 24px 70px rgba(0,0,0,.28);box-sizing:border-box;max-height:88vh;overflow:auto;color:#2a2622;-webkit-overflow-scrolling:touch;');

  var head = el('div', 'display:flex;align-items:flex-start;justify-content:space-between;gap:12px;');
  head.appendChild(el('div', 'font-size:17px;font-weight:600;color:#2a2622;', guide ? '先连接你的服务器' : '服务器设置'));
  var closeBtn = el('button', 'flex:0 0 auto;width:32px;height:32px;padding:0;border:1px solid #ded7cd;border-radius:10px;background:#faf7f2;color:#746d63;font-size:20px;line-height:1;cursor:pointer;', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', '关闭');
  head.appendChild(closeBtn);

  var desc = el('div', 'font-size:12.5px;color:#8a8177;line-height:1.65;margin:8px 0 16px;',
    guide ? 'App 的页面是内置在手机里的，数据存在你自己的服务器上。填一次地址就行，以后随时能在右下角的齿轮里改。'
          : '改完点「保存并连接」立刻生效，不用重装 App。如果地址换成了另一台服务器，本机口令会被清掉，需要重新登录。');

  var addrLabel = el('div', 'font-size:12px;font-weight:700;color:#746d63;margin-bottom:6px;', '服务器地址');
  var addrInput = el('input', 'width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #ded7cd;border-radius:12px;font-size:16px;outline:none;background:#faf8f5;color:#2a2622;');
  addrInput.type = 'text';
  addrInput.setAttribute('inputmode', 'url');
  addrInput.setAttribute('autocapitalize', 'off');
  addrInput.setAttribute('autocorrect', 'off');
  addrInput.setAttribute('autocomplete', 'off');
  addrInput.spellcheck = false;
  addrInput.placeholder = 'http://你的服务器IP:8080';
  addrInput.value = API_BASE;
  var addrHint = el('div', 'margin-top:6px;font-size:11px;color:#b3aa9e;line-height:1.6;',
    '只填 IP 或 IP:端口也行（会自动补 http://）；结尾带不带 /api 都认。');

  var pwLabel = el('div', 'font-size:12px;font-weight:700;color:#746d63;margin:15px 0 6px;', '访问口令');
  var pwInput = el('input', 'width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #ded7cd;border-radius:12px;font-size:16px;outline:none;background:#faf8f5;color:#2a2622;');
  pwInput.type = 'password';
  pwInput.setAttribute('autocomplete', 'current-password');
  pwInput.placeholder = '留空表示不改口令';

  var btnRow = el('div', 'display:flex;gap:8px;margin-top:16px;');
  var testBtn = el('button', 'flex:1;padding:12px;border:1px solid #ded7cd;border-radius:12px;background:#faf7f2;color:#2a2622;font-size:14px;font-weight:600;cursor:pointer;', '测试连接');
  var saveBtn = el('button', 'flex:1.4;padding:12px;border:none;border-radius:12px;background:#2a2622;color:#fff;font-size:15px;font-weight:600;cursor:pointer;', '保存并连接');
  testBtn.type = 'button';
  saveBtn.type = 'button';
  btnRow.appendChild(testBtn);
  btnRow.appendChild(saveBtn);

  var msg = el('div', 'margin-top:12px;font-size:12.5px;line-height:1.6;min-height:20px;color:#8a8177;word-break:break-word;');
  var statusLine = el('div', 'margin-top:14px;padding-top:12px;border-top:1px solid #f0e9df;font-size:11px;color:#b3aa9e;line-height:1.8;word-break:break-all;');

  var subRow = el('div', 'margin-top:10px;display:flex;flex-wrap:wrap;gap:16px;font-size:12px;font-weight:700;');
  var clearToken = el('a', 'color:#b65f42;text-decoration:none;cursor:pointer;', '清除本机口令');
  clearToken.href = '#';
  clearToken.onclick = function (ev) {
    ev.preventDefault();
    lwSaveToken('');
    setMsg('已清除本机口令，下次联网操作会要求重新登录。', 'ok');
    refreshStatus();
  };
  subRow.appendChild(clearToken);
  if (LW_DEFAULT_BASE) {
    var resetAddr = el('a', 'color:#b65f42;text-decoration:none;cursor:pointer;', '填回内置默认地址');
    resetAddr.href = '#';
    resetAddr.onclick = function (ev) {
      ev.preventDefault();
      addrInput.value = LW_DEFAULT_BASE;
      setMsg('已填回打包时内置的地址，点「保存并连接」生效。');
    };
    subRow.appendChild(resetAddr);
  }

  /* ---- 数据维护：清空内置示例数据 ----
     原本是 topbar 上的一颗垃圾桶按钮（手机上又小又容易误触），收进设置里更清爽。 */
  var sampleTotal = lwSampleTotal();
  var maint = null;
  if (sampleTotal >= 0) {
    maint = el('div', 'margin-top:16px;padding-top:14px;border-top:1px solid #f0e9df;');
    maint.appendChild(el('div', 'font-size:12px;font-weight:700;color:#746d63;', '数据维护'));
    if (sampleTotal > 0) {
      var clearSampleBtn = el('button', 'margin-top:10px;width:100%;padding:12px;border:1px solid #e3d0c7;' +
        'border-radius:12px;background:#fdf4f0;color:#b65f42;font-size:14px;font-weight:600;cursor:pointer;',
        '清空示例数据（' + sampleTotal + ' 条）');
      clearSampleBtn.type = 'button';
      clearSampleBtn.onclick = function () {
        if (window.lwClearSamples() === false) { setMsg('已经没有示例数据了。'); return; }
        close();
        lwToast('示例数据已清空，你自己记的内容都还在', 'ok');
      };
      maint.appendChild(clearSampleBtn);
      maint.appendChild(el('div', 'margin-top:8px;font-size:11px;color:#b3aa9e;line-height:1.7;',
        '只会删掉内置的示例记录、示例打卡和示例收藏，你自己录入的内容不受影响。'));
    } else {
      maint.appendChild(el('div', 'margin-top:8px;font-size:11.5px;color:#b3aa9e;line-height:1.7;',
        '示例数据已经清空，没有需要维护的内容。'));
    }
  }

  var skip = null;
  if (guide) {
    skip = el('button', 'margin-top:14px;width:100%;padding:11px;border:1px dashed #ded7cd;border-radius:12px;background:transparent;color:#8a8177;font-size:13px;font-weight:600;cursor:pointer;', '暂时不连，先用本地模式');
    skip.type = 'button';
    skip.onclick = function () {
      lwStoreSet(LW_KEY_SKIP, '1');
      close();
      lwToast('没连服务器，数据只存在本机。想连的时候点右下角齿轮。', 'warn');
    };
  }

  var busy = false;
  function setMsg(t, kind) {
    if (!t) { msg.textContent = ''; return; }
    msg.style.color = kind === 'err' ? '#b3261e' : (kind === 'ok' ? '#1f6f43' : '#8a8177');
    msg.textContent = t;
  }
  function refreshStatus() {
    var mode = LW_NEEDS_SETUP ? '待配置' : (ONLINE ? '在线模式' : '纯本地模式');
    statusLine.textContent = '当前地址：' + (API_BASE || '未设置') + '｜' + mode + '｜待同步 ' + lwQueueCount() + ' 条';
  }
  function setBusy(on, label) {
    busy = !!on;
    saveBtn.disabled = !!on;
    testBtn.disabled = !!on;
    saveBtn.textContent = on ? (label || '处理中…') : '保存并连接';
    saveBtn.style.opacity = on ? '.7' : '1';
    testBtn.style.opacity = on ? '.7' : '1';
  }
  function close() {
    if (mask.parentNode) mask.parentNode.removeChild(mask);
    lwMountGear();
  }

  function doTest() {
    if (busy) return;
    var addr = lwNormalizeBase(addrInput.value);
    if (!addr) { setMsg('请先填服务器地址，例如 http://你的服务器IP:8080', 'err'); return; }
    setBusy(true, '测试中…');
    setMsg('正在访问 ' + addr + '/api/health …');
    lwProbe(addr).then(function (r) {
      setBusy(false);
      if (r.ok) {
        setMsg('连接正常：' + addr + ' 服务端在跑，可以点「保存并连接」了。', 'ok');
      } else if (r.status) {
        setMsg('能连上 ' + addr + '，但它返回 HTTP ' + r.status +
               ((r.data && r.data.message) ? '（' + r.data.message + '）' : '') +
               '。这个地址可能不是本工作台的服务端。', 'err');
      } else {
        setMsg('连不上 ' + addr + '：' + (r.error || '网络异常') +
               '。检查地址端口、服务端是否启动、防火墙有没有放开。', 'err');
      }
    });
  }

  function doSave() {
    if (busy) return;
    var addr = lwNormalizeBase(addrInput.value);
    var pw = pwInput.value;

    if (!addr) {
      if (LW_NATIVE) { setMsg('请填服务器地址，例如 http://你的服务器IP:8080', 'err'); return; }
      setMsg('留空表示同源模式（浏览器直接打开服务端地址时用）。');
      lwSetBase('');
      refreshStatus();
      close();
      lwRefreshAll();
      return;
    }

    lwSetBase(addr);   // 地址变了会自动清掉旧口令 / 旧缓存
    refreshStatus();

    if (pw) {
      setBusy(true, '连接中…');
      lwRequest('POST', '/api/login', { password: pw }, true).then(function (data) {
        if (!data || !data.token) throw new Error('服务端返回异常');
        lwSaveToken(data.token);
        setBusy(false);
        close();
        lwToast('已连接 ' + addr, 'ok');
        lwRefreshAll();
      }).catch(function (e) {
        setBusy(false);
        if (e && e.status === 401) {
          setMsg('口令不对。地址已保存，改好口令再点一次「保存并连接」。', 'err');
        } else {
          setMsg('连不上：' + ((e && e.message) || '网络异常') +
                 '。地址已保存，可以先点「测试连接」排查。', 'err');
        }
      });
      return;
    }

    close();
    if (lwQueueCount() > 0) {
      lwToast('本机还有 ' + lwQueueCount() + ' 条没同步的改动，登录后会补传', 'warn');
    }
    lwRefreshAll();
    if (!LW_TOKEN) setTimeout(function () { lwAskLogin(true); }, 260);
  }

  box.appendChild(head);
  box.appendChild(desc);
  box.appendChild(addrLabel);
  box.appendChild(addrInput);
  box.appendChild(addrHint);
  box.appendChild(pwLabel);
  box.appendChild(pwInput);
  box.appendChild(btnRow);
  box.appendChild(msg);
  box.appendChild(statusLine);
  box.appendChild(subRow);
  if (maint) box.appendChild(maint);
  if (skip) box.appendChild(skip);
  mask.appendChild(box);
  document.body.appendChild(mask);

  refreshStatus();
  closeBtn.onclick = close;
  testBtn.onclick = doTest;
  saveBtn.onclick = doSave;
  addrInput.onkeydown = function (ev) { if (ev.key === 'Enter' || ev.keyCode === 13) doSave(); };
  pwInput.onkeydown = function (ev) { if (ev.key === 'Enter' || ev.keyCode === 13) doSave(); };
  mask.onclick = function (ev) { if (ev.target === mask && !guide) close(); };
  if (guide) setTimeout(function () { try { addrInput.focus(); } catch (e) { /* ignore */ } }, 120);
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

/* 齿轮尽早出现，不等下面那 1.4 秒的启动检查 */
if (document.body) lwMountGear();
else document.addEventListener('DOMContentLoaded', lwMountGear);

setTimeout(function () {
  lwMountGear();
  /* App 里还没填服务器地址 → 直接把设置面板弹出来，别让用户对着空数据发呆 */
  if (LW_NEEDS_SETUP && !lwStoreGet(LW_KEY_SKIP)) { lwOpenSettings(true); return; }
  if (!ONLINE) return;
  if (!LW_TOKEN) lwAskLogin();
  else lwFlushQueue();
}, 1400);

/* 调试口子：window.lw.state() 看状态，window.lw.settings() 打开设置面板，
   window.lw.base('http://x:8080') 直接改地址（等价于在设置面板里保存） */
window.lw = {
  state: function () {
    return {
      apiBase: API_BASE,
      defaultBase: LW_DEFAULT_BASE,
      nativeApp: LW_NATIVE,
      needsSetup: LW_NEEDS_SETUP,
      online: ONLINE,
      localOnly: LOCAL_ONLY,
      hasToken: !!LW_TOKEN,
      queued: lwQueueCount()
    };
  },
  settings: function () { lwOpenSettings(false); },
  probe: lwProbe,
  base: function (v) {
    if (v === undefined) return API_BASE;
    lwSetBase(v);
    lwMountGear();
    return API_BASE;
  },
  token: function (v) {
    if (v === undefined) return LW_TOKEN;
    lwSaveToken(v);
    return LW_TOKEN;
  },
  login: function () { lwAskLogin(true); },
  flush: lwFlushQueue,
  refresh: lwRefreshAll,
  clearCaches: lwClearCaches
};

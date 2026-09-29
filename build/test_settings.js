#!/usr/bin/env node
/*
 * 服务端地址设置逻辑的离线自测（不需要浏览器 / 真机 / 服务端）。
 *
 * 用最小 DOM stub 把 build/adapter.js 跑起来，验证「设置面板」这条链路：
 * 地址容错、换服务器清态、探活、面板 DOM、首次引导。
 *
 * 端到端（真服务端）见 build/test_settings_e2e.js
 *
 * 用法：node build/test_settings.js
 */

'use strict';

const {
  createAsserts, fakeRes, loadAdapter, openSettingsViaUi, findAll, allText
} = require('./_harness');

const { ok, eq, report } = createAsserts();

(async function main() {

  /* ---- 1. 地址容错 ---- */
  {
    const { sandbox } = loadAdapter();
    const N = sandbox.lwNormalizeBase;
    eq('只填 IP:端口 自动补 http://', N('192.0.2.10:8080'), 'http://192.0.2.10:8080');
    eq('只填裸 IP 自动补 http://', N('192.0.2.10'), 'http://192.0.2.10');
    eq('去掉结尾斜杠', N('http://a.b:8080/'), 'http://a.b:8080');
    eq('去掉多个结尾斜杠', N('http://a.b:8080///'), 'http://a.b:8080');
    eq('去掉手滑加的 /api', N('http://a.b:8080/api'), 'http://a.b:8080');
    eq('去掉 /api/ 结尾', N('https://life.example.com/api/'), 'https://life.example.com');
    eq('去掉首尾空格', N('  http://a.b:1  '), 'http://a.b:1');
    eq('保留 https', N('https://life.example.com'), 'https://life.example.com');
    eq('空串保持空', N(''), '');
    eq('null 保持空', N(null), '');
    eq('undefined 保持空', N(undefined), '');
    eq('保留带路径的反代前缀', N('http://a.b/lw'), 'http://a.b/lw');
  }

  /* ---- 2. 浏览器里没配地址 = 同源模式 ---- */
  {
    const { sandbox, lw } = loadAdapter({ location: { protocol: 'http:', hostname: '1.2.3.4' } });
    eq('浏览器（非 App）空地址 → 走同源', lw.state().online, true);
    eq('浏览器（非 App）不算 needsSetup', lw.state().needsSetup, false);
    eq('非原生容器判定', sandbox.LW_NATIVE, false);
  }

  /* ---- 3. App 里没配地址 = 需要引导配置 ---- */
  {
    const { lw } = loadAdapter({ capacitor: { isNativePlatform: () => true } });
    eq('App 里空地址 → needsSetup', lw.state().needsSetup, true);
    eq('App 里空地址 → 不假装在线', lw.state().online, false);
  }

  /* ---- 4. 构建时注入的内置地址会被采用 ---- */
  {
    const { lw } = loadAdapter({ config: { apiBase: '203.0.113.7:8080' } });
    eq('采用构建时注入的地址', lw.state().apiBase, 'http://203.0.113.7:8080');
    eq('保留内置默认值以便「填回」', lw.state().defaultBase, 'http://203.0.113.7:8080');
    eq('有地址就不需要引导', lw.state().needsSetup, false);
  }

  /* ---- 5. 用户保存的地址优先于内置默认值 ---- */
  {
    const { lw } = loadAdapter({
      config: { apiBase: 'http://built-in:8080' },
      storage: { lw_api_base: 'http://user-set:9000' }
    });
    eq('用户设置覆盖内置默认值', lw.state().apiBase, 'http://user-set:9000');
  }

  /* ---- 6. App 里用户改地址：旧口令 / 旧缓存要清 ---- */
  {
    const { lw, store } = loadAdapter({
      capacitor: { isNativePlatform: () => true },
      storage: { lw_api_base: 'http://old-server:8080', lw_token: 'OLD_TOKEN', lw_cache_money: '[{"a":1}]' }
    });
    eq('换地址前 token 在', lw.state().hasToken, true);
    const changed = lw.base('192.0.2.50:8080');
    eq('返回值是规范化后的地址', changed, 'http://192.0.2.50:8080');
    eq('地址已写入本地存储', store.getItem('lw_api_base'), 'http://192.0.2.50:8080');
    eq('换服务器后旧口令被清', lw.state().hasToken, false);
    eq('换服务器后旧口令 key 被删', store.getItem('lw_token'), null);
    eq('换服务器后旧缓存被清', store.getItem('lw_cache_money'), null);
    eq('换完地址不再需要引导', lw.state().needsSetup, false);
    eq('换完地址进入在线模式', lw.state().online, true);
  }

  /* ---- 7. 同一个地址重复保存：不该清口令 ---- */
  {
    const { lw } = loadAdapter({
      capacitor: { isNativePlatform: () => true },
      storage: { lw_api_base: 'http://same:8080', lw_token: 'KEEP_ME' }
    });
    lw.base('http://same:8080/');
    eq('地址没变则保留口令', lw.state().hasToken, true);
  }

  /* ---- 8. 离线队列不因换地址被清（用户没同步的改动不能丢） ---- */
  {
    const { lw, store } = loadAdapter({
      capacitor: { isNativePlatform: () => true },
      storage: { lw_api_base: 'http://old:8080', lw_queue: '[{"op":"add"}]' }
    });
    lw.base('http://new:8080');
    eq('离线队列保留', store.getItem('lw_queue'), '[{"op":"add"}]');
    eq('待同步条数仍可见', lw.state().queued, 1);
  }

  /* ---- 9. 探活：正常 / 非本服务 / 连不上 / 空地址 ---- */
  {
    const { lw } = loadAdapter({ fetch: () => Promise.resolve(fakeRes(200, '{"ok":true,"service":"life-workbench"}')) });
    const r = await lw.probe('203.0.113.9:8080');
    eq('探活成功', r.ok, true);
    ok('探活成功带服务端信息', r.data && r.data.service === 'life-workbench', JSON.stringify(r.data));
  }
  {
    const { lw } = loadAdapter({ fetch: () => Promise.resolve(fakeRes(404, '{"message":"Not Found"}')) });
    const r = await lw.probe('http://wrong-host:8080');
    eq('指到别的服务时探活失败', r.ok, false);
    eq('能区分「连上了但不是它」', r.status, 404);
  }
  {
    const { lw } = loadAdapter({ fetch: () => Promise.reject(new Error('Failed to fetch')) });
    const r = await lw.probe('http://dead-host:8080');
    eq('连不上时探活失败', r.ok, false);
    eq('连不上时错误信息可读', r.error, 'Failed to fetch');
  }
  {
    const { lw } = loadAdapter();
    const r = await lw.probe('');
    eq('空地址不发请求', r.ok, false);
    eq('空地址给出提示', r.error, '地址为空');
  }

  /* ---- 10. 首次引导面板（App 里还没填地址时弹的那个） ---- */
  {
    const { sandbox, dom } = loadAdapter({ capacitor: { isNativePlatform: () => true } });
    const ui = openSettingsViaUi(sandbox, dom, true);
    ok('引导面板已挂到页面', !!ui.panel);
    ok('面板里有地址 + 口令两个输入框', !!ui.addr && !!ui.pw);
    eq('地址框是文本输入', ui.addr.type, 'text');
    eq('口令框是密码输入', ui.pw.type, 'password');
    ok('地址框带 url 键盘提示', ui.addr.attrs.inputmode === 'url');
    eq('手机端输入框字号 ≥16px 防缩放', /font-size:16px/.test(ui.addr.style.cssText), true);
    ok('有测试连接按钮', !!ui.testBtn);
    ok('有保存并连接按钮', !!ui.saveBtn);
    ok('引导面板给了「先用本地模式」逃生口', !!ui.skipBtn);
    ui.panel.onclick({ target: ui.panel });
    ok('引导模式下点遮罩不会误关', !!dom.doc.getElementById('lw-settings'));
  }

  /* ---- 11. 非引导模式：可关闭、无逃生口、有兜底操作 ---- */
  {
    const { sandbox, dom } = loadAdapter({ config: { apiBase: 'http://a.b:8080' } });
    const ui = openSettingsViaUi(sandbox, dom, false);
    ok('普通设置面板不出现「先用本地模式」', !ui.texts().some(t => t.indexOf('先用本地模式') >= 0));
    ok('普通设置面板有清除口令入口', ui.texts().some(t => t.indexOf('清除本机口令') >= 0));
    ok('普通设置面板有填回内置地址入口', ui.texts().some(t => t.indexOf('填回内置默认地址') >= 0));
    ok('状态行显示当前地址与模式', ui.texts().some(t => t.indexOf('当前地址：http://a.b:8080') >= 0), ui.texts().join(' | '));
    ui.panel.onclick({ target: ui.panel });
    eq('点遮罩能关掉面板', dom.doc.getElementById('lw-settings'), null);
  }

  /* ---- 12. 齿轮按钮：没配地址时高亮提醒 ---- */
  {
    const { dom } = loadAdapter({ capacitor: { isNativePlatform: () => true } });
    const gear = dom.doc.getElementById('lw-gear');
    ok('齿轮按钮已挂上', !!gear);
    eq('App 未配地址时齿轮高亮', gear.className, 'lw-alert');
  }
  {
    const { dom } = loadAdapter({ config: { apiBase: 'http://a.b:8080' } });
    const gear = dom.doc.getElementById('lw-gear');
    ok('齿轮按钮已挂上', !!gear);
    eq('已配地址时齿轮不高亮', gear.className, '');
  }

  /* ---- 13. 面板里保存地址（不填口令）：立刻改状态并落盘 ---- */
  {
    const { sandbox, dom, store } = loadAdapter({ capacitor: { isNativePlatform: () => true } });
    const ui = openSettingsViaUi(sandbox, dom, true);
    ui.addr.value = '192.0.2.9:8080';
    ui.saveBtn.onclick();
    eq('保存后地址生效', sandbox.lw.state().apiBase, 'http://192.0.2.9:8080');
    eq('保存后写入本地存储', store.getItem('lw_api_base'), 'http://192.0.2.9:8080');
    eq('保存后面板关闭', dom.doc.getElementById('lw-settings'), null);
    eq('保存后不再是待配置', sandbox.lw.state().needsSetup, false);
  }

  /* ---- 14. 面板里留空地址（App 内）：拒绝保存并提示 ---- */
  {
    const { sandbox, dom } = loadAdapter({ capacitor: { isNativePlatform: () => true } });
    const ui = openSettingsViaUi(sandbox, dom, true);
    ui.addr.value = '   ';
    ui.saveBtn.onclick();
    ok('空地址被拒绝，仍处于待配置',
       sandbox.lw.state().apiBase === '' && sandbox.lw.state().needsSetup,
       String(sandbox.lw.state().apiBase));
    ok('面板保持打开', !!dom.doc.getElementById('lw-settings'));
    ok('给出了填写示例', ui.texts().some(t => t.indexOf('你的服务器IP') >= 0), ui.texts().join(' | '));
  }

  /* ---- 15. 点「测试连接」的反馈文案 ---- */
  {
    const { sandbox, dom } = loadAdapter({ fetch: () => Promise.resolve(fakeRes(200, '{"ok":true}')) });
    const ui = openSettingsViaUi(sandbox, dom, false);
    ui.addr.value = '203.0.113.9:8080';
    ui.testBtn.onclick();
    await new Promise(r => setImmediate(r));
    ok('探活成功后给出「连接正常」反馈', ui.texts().some(t => t.indexOf('连接正常') >= 0), ui.texts().join(' | '));
    ok('探活成功文案里带上地址', ui.texts().some(t => t.indexOf('http://203.0.113.9:8080') >= 0));
  }
  {
    const { sandbox, dom } = loadAdapter({ fetch: () => Promise.resolve(fakeRes(404, '{}')) });
    const ui = openSettingsViaUi(sandbox, dom, false);
    ui.addr.value = 'http://wrong:8080';
    ui.testBtn.onclick();
    await new Promise(r => setImmediate(r));
    ok('HTTP 404 时提示「可能不是本工作台的服务端」',
       ui.texts().some(t => t.indexOf('可能不是本工作台的服务端') >= 0), ui.texts().join(' | '));
  }
  {
    const { sandbox, dom } = loadAdapter({ fetch: () => Promise.reject(new Error('boom')) });
    const ui = openSettingsViaUi(sandbox, dom, false);
    ui.addr.value = 'http://dead:8080';
    ui.testBtn.onclick();
    await new Promise(r => setImmediate(r));
    ok('连不上时提示排查方向',
       ui.texts().some(t => t.indexOf('连不上') >= 0 && t.indexOf('防火墙') >= 0), ui.texts().join(' | '));
  }

  /* ---- 16. 「清除本机口令」 ---- */
  {
    const { sandbox, dom, store } = loadAdapter({
      config: { apiBase: 'http://a.b:8080' },
      storage: { lw_token: 'TOKEN_X' }
    });
    const ui = openSettingsViaUi(sandbox, dom, false);
    const clearLink = findAll(ui.panel, 'A').find(a => a.textContent === '清除本机口令');
    ok('找到清除口令入口', !!clearLink);
    clearLink.onclick({ preventDefault() {} });
    eq('口令已从内存清掉', sandbox.lw.state().hasToken, false);
    eq('口令已从本地存储清掉', store.getItem('lw_token'), null);
  }

  /* ---- 17. 「填回内置默认地址」 ---- */
  {
    const { sandbox, dom } = loadAdapter({
      config: { apiBase: 'http://built-in:8080' },
      storage: { lw_api_base: 'http://user:9000' }
    });
    const ui = openSettingsViaUi(sandbox, dom, false);
    eq('初值显示用户设置过的地址', ui.addr.value, 'http://user:9000');
    const resetLink = findAll(ui.panel, 'A').find(a => a.textContent === '填回内置默认地址');
    ok('找到填回入口', !!resetLink);
    resetLink.onclick({ preventDefault() {} });
    eq('填回后输入框变成内置地址', ui.addr.value, 'http://built-in:8080');
    eq('填回只是改输入框，未保存前不生效', sandbox.lw.state().apiBase, 'http://user:9000');
  }

  /* ---- 18. 登录浮层里的「修改地址」入口 ---- */
  {
    const { sandbox, dom } = loadAdapter({ config: { apiBase: 'http://a.b:8080' } });
    sandbox.lwAskLogin(true);
    const login = dom.doc.getElementById('lw-login');
    ok('登录浮层已弹出', !!login);
    const link = findAll(login, 'A').find(a => a.textContent === '修改地址');
    ok('登录浮层有「修改地址」入口', !!link);
    link.onclick({ preventDefault() {} });
    eq('点它关掉登录浮层', dom.doc.getElementById('lw-login'), null);
    ok('并打开服务器设置', !!dom.doc.getElementById('lw-settings'));
  }

  /* ---- 19. 没配地址时要求登录 → 直接引导去配置，而不是弹登录 ---- */
  {
    const { sandbox, dom } = loadAdapter({ capacitor: { isNativePlatform: () => true } });
    sandbox.lwAskLogin(true);
    eq('没有登录浮层', dom.doc.getElementById('lw-login'), null);
    ok('改成打开引导面板', !!dom.doc.getElementById('lw-settings'));
  }

  /* ---- 20. 调试口子仍在 ---- */
  {
    const { lw } = loadAdapter({
      config: { apiBase: 'http://a.b:8080' },
      location: { protocol: 'http:', hostname: '1.2.3.4' }
    });
    const st = lw.state();
    ok('state() 带 nativeApp', st.nativeApp === false);
    ok('state() 带 defaultBase', 'defaultBase' in st);
    ok('state() 带 needsSetup', 'needsSetup' in st);
    ok('settings() 可调用', typeof lw.settings === 'function');
    ok('probe() 可调用', typeof lw.probe === 'function');
    ok('clearCaches() 可调用', typeof lw.clearCaches === 'function');
    ok('base() 仍可读', lw.base() === 'http://a.b:8080');
  }

  process.exit(report('test_settings') ? 0 : 1);
})();

/**
 * 测试脚手架：最小 DOM / localStorage / vm 装载器。
 *
 * 本机没有浏览器也没有真机，但 build/adapter.js 是一个纯前端片段，
 * 用这套 stub 就能在 Node 里把它整个跑起来，直接验证行为。
 *
 * 被 build/test_settings.js 和 build/test_settings_e2e.js 共用。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ADAPTER = path.join(__dirname, 'adapter.js');

/* ------------------------------ 断言收集 ------------------------------ */
function createAsserts() {
  const state = { passed: 0, failed: [] };
  function ok(name, cond, extra) {
    if (cond) { state.passed++; return; }
    state.failed.push(name + (extra ? '  →  ' + extra : ''));
  }
  function eq(name, actual, expected) {
    ok(name, actual === expected,
       '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
  }
  function report(label) {
    console.log('[%s] 通过 %d 项', label, state.passed);
    if (state.failed.length) {
      console.log('[%s] 失败 %d 项：', label, state.failed.length);
      state.failed.forEach(f => console.log('  ✗ %s', f));
      return false;
    }
    console.log('[%s] 全部通过', label);
    return true;
  }
  return { ok, eq, report, state };
}

/* ------------------------------ 最小 DOM ------------------------------ */
function makeDom() {
  const byId = new Map();

  function makeEl(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      id: '',
      style: { cssText: '' },
      children: [],
      parentNode: null,
      textContent: '',
      innerHTML: '',
      className: '',
      value: '',
      type: '',
      disabled: false,
      checked: false,
      attrs: {},
      onkeydown: null,
      onclick: null,
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) {
        return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
      },
      appendChild(c) {
        c.parentNode = this;
        this.children.push(c);
        if (c.id) byId.set(c.id, c);
        return c;
      },
      removeChild(c) {
        const i = this.children.indexOf(c);
        if (i >= 0) this.children.splice(i, 1);
        c.parentNode = null;
        if (c.id && byId.get(c.id) === c) byId.delete(c.id);
        return c;
      },
      addEventListener() { /* noop */ },
      focus() { this._focused = true; },
      remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    };
  }

  const body = makeEl('body');
  const head = makeEl('head');
  const doc = {
    body,
    head,
    documentElement: makeEl('html'),
    createElement: makeEl,
    createTextNode(text) {
      return {
        tagName: '#TEXT',
        id: '',
        textContent: String(text),
        children: [],
        parentNode: null,
        style: { cssText: '' },
        appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
        removeChild(c) {
          const i = this.children.indexOf(c);
          if (i >= 0) this.children.splice(i, 1);
          return c;
        }
      };
    },
    getElementById(id) { return byId.get(id) || null; },
    addEventListener() { /* noop */ }
  };
  return { doc, byId, makeEl };
}

function findAll(root, tag) {
  const out = [];
  (function walk(n) {
    n.children.forEach(function (c) {
      if (c.tagName === tag) out.push(c);
      walk(c);
    });
  })(root);
  return out;
}

function allText(root) {
  const out = [];
  (function walk(n) {
    if (n.textContent) out.push(n.textContent);
    n.children.forEach(walk);
  })(root);
  return out;
}

/* ------------------------------ 最小 localStorage ------------------------------ */
function makeStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    map,
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    key(i) { return Array.from(map.keys())[i]; },
    get length() { return map.size; }
  };
}

function fakeRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text() { return Promise.resolve(body); }
  };
}

/* ------------------------------ 装载 adapter.js ------------------------------ */
/**
 * @param {object} opts
 *   capacitor  模拟 Capacitor 容器（{ isNativePlatform: () => true }）
 *   config     等价于页面里的 window.__LW_CONFIG__
 *   storage    预置 localStorage 内容
 *   fetch      替换 fetch（默认返回 200 {"ok":true}）；端到端测试传真 fetch
 *   location   替换 location
 *   realTimers true 时短定时器走真时间（登录浮层的 260ms 延迟弹窗需要），
 *              但 ≥1000ms 的仍然拦住 —— 启动钩子在 1400ms，让它执行会打乱用例状态。
 */
function loadAdapter(opts) {
  opts = opts || {};
  const dom = makeDom();
  const store = makeStorage(opts.storage);
  const timers = [];
  const hostSetTimeout = setTimeout;

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: dom.doc,
    location: opts.location || { protocol: 'https:', hostname: 'localhost', href: 'https://localhost/' },
    localStorage: store,
    addEventListener() { /* noop */ },
    removeEventListener() { /* noop */ },
    fetch: opts.fetch || function () { return Promise.resolve(fakeRes(200, '{"ok":true}')); },
    // 用宿主真实的 AbortController：stub 出来的假 signal 过不了真 fetch 的参数校验
    AbortController: typeof AbortController === 'function' ? AbortController : undefined,
    setTimeout(fn, ms) {
      if (opts.realTimers && ms < 1000) return hostSetTimeout(fn, ms);
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout() { /* noop */ },
    setInterval() { return 0; },
    clearInterval() { /* noop */ }
  };

  vm.createContext(sandbox);
  sandbox.window = sandbox;
  sandbox.window.__LW_CONFIG__ = opts.config || { apiBase: '' };
  if (opts.capacitor) sandbox.window.Capacitor = opts.capacitor;

  vm.runInContext(fs.readFileSync(ADAPTER, 'utf8'), sandbox, { filename: 'adapter.js' });
  return { sandbox, lw: sandbox.window.lw, dom, store, timers };
}

/* 模拟「用户打开设置面板、填字段、点按钮」——返回面板上的控件句柄 */
function openSettingsViaUi(sandbox, dom, guide) {
  if (guide) sandbox.lwOpenSettings(true);
  else sandbox.lw.settings();
  const panel = dom.doc.getElementById('lw-settings');
  if (!panel) return null;
  const inputs = findAll(panel, 'INPUT');
  const buttons = findAll(panel, 'BUTTON');
  return {
    panel,
    closeBtn: buttons.find(b => b.textContent === '×'),
    addr: inputs[0],
    pw: inputs[1],
    testBtn: buttons.find(b => b.textContent === '测试连接'),
    saveBtn: buttons.find(b => b.textContent === '保存并连接'),
    skipBtn: buttons.find(b => b.textContent && b.textContent.indexOf('先用本地模式') >= 0),
    texts: () => allText(panel)
  };
}

module.exports = {
  ADAPTER,
  createAsserts,
  makeDom,
  makeStorage,
  fakeRes,
  loadAdapter,
  openSettingsViaUi,
  findAll,
  allText
};

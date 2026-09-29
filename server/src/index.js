'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');

const { openDatabase, createStore } = require('./db');
const { TABLES, isValidTable, tableName, flattenProperties } = require('./tables');
const { createAuth, deriveToken } = require('./auth');

const PORT = Number(process.env.PORT || 8080);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'workbench.db');
const CLIENT_DIR = process.env.CLIENT_DIR || path.join(__dirname, '..', '..', 'client');
const SECRET = process.env.APP_SECRET || 'lw-default-secret-change-me';

let PASSWORD = process.env.APP_PASSWORD || '';
let generatedPassword = false;
if (!PASSWORD) {
  PASSWORD = crypto.randomBytes(4).toString('hex');
  generatedPassword = true;
}

const db = openDatabase(DB_FILE);
const store = createStore(db);
const auth = createAuth(PASSWORD, SECRET);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));

// CORS：Capacitor 里 WebView 的 origin 是 https://localhost（Android）或 capacitor://localhost（iOS），
// 属于跨域请求，这里回显 origin 并允许携带 Authorization。
app.use(function (req, res, next) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function fail(res, code, message, extra) {
  return res.status(code).json(Object.assign({ ok: false, error: message }, extra || {}));
}

/* ------------------------------ 公开接口 ------------------------------ */

app.get('/api/health', function (req, res) {
  res.json({ ok: true, service: 'life-workbench', time: Date.now() });
});

app.post('/api/login', function (req, res) {
  const password = (req.body && req.body.password) || '';
  if (!auth.checkPassword(password)) {
    return fail(res, 401, 'invalid_password', { message: '口令不对' });
  }
  res.json({ ok: true, token: deriveToken(PASSWORD, SECRET) });
});

/* ---------------------------- 以下均需认证 ---------------------------- */

app.use('/api', auth.middleware);

app.get('/api/tables', function (req, res) {
  const counts = store.counts();
  res.json({
    ok: true,
    tables: TABLES.map(function (t) {
      return { key: t.key, name: t.name, fields: t.fields, count: counts[t.key] || 0 };
    })
  });
});

function requireTable(req, res, next) {
  if (!isValidTable(req.params.table)) {
    return fail(res, 404, 'unknown_table', { message: '没有这张表：' + req.params.table });
  }
  next();
}

app.get('/api/t/:table', requireTable, function (req, res) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 1000, 1), 10000);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  res.json({
    ok: true,
    table: req.params.table,
    name: tableName(req.params.table),
    count: store.count(req.params.table),
    records: store.list(req.params.table, limit, offset)
  });
});

app.post('/api/t/:table', requireTable, function (req, res) {
  const props = flattenProperties(req.body && req.body.properties);
  const recordId = store.add(req.params.table, props);
  res.status(201).json({ ok: true, record_id: recordId });
});

app.patch('/api/t/:table/:recordId', requireTable, function (req, res) {
  const props = flattenProperties(req.body && req.body.properties);
  const updated = store.update(req.params.table, req.params.recordId, props);
  if (!updated) return fail(res, 404, 'record_not_found', { message: '记录不存在或已被删除' });
  res.json({ ok: true });
});

app.delete('/api/t/:table/:recordId', requireTable, function (req, res) {
  const removed = store.remove(req.params.table, req.params.recordId);
  if (!removed) return fail(res, 404, 'record_not_found', { message: '记录不存在或已被删除' });
  res.json({ ok: true });
});

/** 批量导入 / 迁移用；rows 是已拍平的属性数组 */
app.post('/api/t/:table/import', requireTable, function (req, res) {
  const rows = (req.body && req.body.rows) || [];
  if (!Array.isArray(rows)) return fail(res, 400, 'bad_payload', { message: 'rows 必须是数组' });
  const inserted = store.importRows(req.params.table, rows.map(flattenProperties));
  res.json({ ok: true, inserted: inserted });
});

/** 清空一张表（前端「清空」按钮用，需显式带 confirm=true 防误触） */
app.post('/api/t/:table/clear', requireTable, function (req, res) {
  if (!req.body || req.body.confirm !== true) {
    return fail(res, 400, 'confirm_required', { message: '需要 confirm: true 才能清空' });
  }
  const removed = store.clear(req.params.table);
  res.json({ ok: true, removed: removed });
});

/* --------------------------- 静态托管工作台 --------------------------- */

if (fs.existsSync(CLIENT_DIR)) {
  app.use(express.static(CLIENT_DIR, { index: 'index.html', extensions: ['html'] }));
}

app.use(function (req, res) {
  fail(res, 404, 'not_found', { message: 'no route: ' + req.method + ' ' + req.path });
});

app.use(function (err, req, res, next) {
  console.error('[error]', err && err.message);
  if (res.headersSent) return next(err);
  fail(res, 500, 'internal_error', { message: err && err.message ? err.message : '服务端异常' });
});

const server = app.listen(PORT, '0.0.0.0', function () {
  console.log('[life-workbench] listening on 0.0.0.0:' + PORT);
  console.log('[life-workbench] db file: ' + DB_FILE);
  if (generatedPassword) {
    console.log('[life-workbench] APP_PASSWORD 未设置，本次随机口令：' + PASSWORD);
    console.log('[life-workbench] 请在 .env 里固定 APP_PASSWORD，否则重启后客户端要重新登录。');
  }
});

function shutdown(signal) {
  console.log('[life-workbench] ' + signal + ' received, closing...');
  server.close(function () {
    try {
      db.close();
    } catch (e) {
      /* ignore */
    }
    process.exit(0);
  });
  setTimeout(function () {
    process.exit(0);
  }, 5000).unref();
}

process.on('SIGTERM', function () {
  shutdown('SIGTERM');
});
process.on('SIGINT', function () {
  shutdown('SIGINT');
});

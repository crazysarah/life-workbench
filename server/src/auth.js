'use strict';

const crypto = require('crypto');

/**
 * 单用户口令认证。
 * token 是从口令派生的稳定值（HMAC），所以服务重启后客户端的登录态依然有效，
 * 不需要引入 session 存储或 JWT 依赖。
 */
function deriveToken(password, secret) {
  return crypto.createHmac('sha256', String(secret)).update('lw-token:' + String(password)).digest('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a));
  const bb = Buffer.from(String(b == null ? '' : b));
  if (ba.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ba, bb);
  } catch (e) {
    return false;
  }
}

/**
 * 从请求里取 token：优先 Authorization: Bearer，其次 ?token= （方便 curl 冒烟测试）
 */
function extractToken(req) {
  const h = req.headers.authorization || '';
  if (h.slice(0, 7).toLowerCase() === 'bearer ') return h.slice(7).trim();
  if (typeof req.query.token === 'string' && req.query.token) return req.query.token;
  return '';
}

function createAuth(password, secret) {
  const expected = deriveToken(password, secret);

  function checkPassword(input) {
    return safeEqual(input, password);
  }

  function middleware(req, res, next) {
    if (safeEqual(extractToken(req), expected)) return next();
    res.status(401).json({ ok: false, error: 'unauthorized', message: '未登录或口令已变更' });
  }

  return { expected, checkPassword, middleware };
}

module.exports = { createAuth, deriveToken, extractToken, safeEqual };

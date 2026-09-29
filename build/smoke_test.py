#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
服务端端到端冒烟测试：把六张表的读写链路、认证、批量导入、清空全跑一遍。

用法：
    python build/smoke_test.py [base_url] [password]
默认 http://127.0.0.1:18080 / smoke123
"""

import json
import sys
import urllib.error
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:18080'
PASSWORD = sys.argv[2] if len(sys.argv) > 2 else 'smoke123'

TOKEN = ''
PASSED = 0
FAILED = []


def call(method, path, body=None, token=None, expect=200):
    url = BASE + path
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Content-Type', 'application/json')
    tk = TOKEN if token is None else token
    if tk:
        req.add_header('Authorization', 'Bearer ' + tk)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            code, raw = r.status, r.read().decode('utf-8')
    except urllib.error.HTTPError as e:
        code, raw = e.code, e.read().decode('utf-8')
    except Exception as e:
        return 0, {'error': str(e)}
    try:
        return code, (json.loads(raw) if raw else {})
    except json.JSONDecodeError:
        return code, {'raw': raw}


def check(name, cond, detail=''):
    global PASSED
    if cond:
        PASSED += 1
        print('  [OK]   %s' % name)
    else:
        FAILED.append(name)
        print('  [FAIL] %s  %s' % (name, detail))


print('=' * 60)
print('冒烟测试 -> %s' % BASE)
print('=' * 60)

# ---- 1. 健康检查（免认证） ----
print('\n[1] 健康检查')
code, body = call('GET', '/api/health')
check('GET /api/health 返回 200', code == 200, 'got %s %s' % (code, body))
check('health.ok == true', body.get('ok') is True, str(body))

# ---- 2. 认证 ----
print('\n[2] 认证')
code, body = call('GET', '/api/tables')
check('未带 token 访问 /api/tables 被拒 401', code == 401, 'got %s' % code)

code, body = call('POST', '/api/login', {'password': 'wrong-password'})
check('错误口令登录被拒 401', code == 401, 'got %s %s' % (code, body))

code, body = call('POST', '/api/login', {'password': PASSWORD})
check('正确口令登录成功', code == 200 and body.get('token'), str(body)[:120])
TOKEN = body.get('token', '')
if not TOKEN:
    print('\n拿不到 token，后续测试无法继续')
    sys.exit(1)

code, body = call('GET', '/api/tables')
check('带 token 可以访问 /api/tables', code == 200, 'got %s' % code)
tables = {t['key']: t for t in body.get('tables', [])}
check('六张表都在', set(tables) == {'money', 'habit', 'plan', 'fitness', 'shopping', 'media'},
      str(sorted(tables)))

code, body = call('GET', '/api/t/nonexistent')
check('不存在的表返回 404', code == 404, 'got %s' % code)

# ---- 3. 六张表增改删 ----
SAMPLES = {
    'money': {'日期': '2026-09-29', '分类': '餐饮', '金额': 32.5, '备注': '午饭'},
    'habit': {'日期': '2026-09-29', '习惯': '喝水', '数值': 6, '备注': '杯'},
    'plan': {'日期': '2026-09-29', '内容': '写周报', '类型': '工作', '状态': '待完成'},
    'fitness': {'日期': '2026-09-29', '体重': 72.4, '体脂率': 19.8, '备注': '晨起'},
    'shopping': {'物品名称': '洗衣液', '数量': 2, '预估价格': 39, '是否已买': '待买', '备注': ''},
    'media': {'标题': '宇宙探索编辑部', '类型': '电影', '状态': '看过', '评分': 4, '短评': '好看'},
}

print('\n[3] 六张表 CRUD')
created = {}
for key, props in SAMPLES.items():
    # 模拟前端：属性带类型包装，服务端应自动拍平
    wrapped = {}
    for k, v in props.items():
        if isinstance(v, bool):
            wrapped[k] = {'select': str(v)}
        elif isinstance(v, (int, float)):
            wrapped[k] = {'number': v}
        else:
            wrapped[k] = {'text': v}
    code, body = call('POST', '/api/t/%s' % key, {'properties': wrapped})
    ok = code == 201 and body.get('record_id')
    created[key] = body.get('record_id')
    check('新增 %-8s' % key, ok, 'got %s %s' % (code, body))

print()
for key, props in SAMPLES.items():
    code, body = call('GET', '/api/t/%s' % key)
    rows = body.get('records', [])
    hit = [r for r in rows if r.get('record_id') == created.get(key)]
    check('读回 %-8s' % key, code == 200 and len(hit) == 1, 'got %s rows=%d' % (code, len(rows)))
    if hit:
        r = hit[0]
        mismatched = [k for k, v in props.items() if r.get(k) != v]
        check('字段值正确 %-8s' % key, not mismatched,
              '不一致字段 %s -> %s' % (mismatched, {k: r.get(k) for k in mismatched})) if mismatched else None

print('\n[4] 部分更新（只带变更字段，其余应保留）')
code, body = call('PATCH', '/api/t/money/%s' % created['money'], {'properties': {'金额': 45.8}})
check('PATCH 返回 200', code == 200, 'got %s %s' % (code, body))
code, body = call('GET', '/api/t/money')
row = [r for r in body.get('records', []) if r.get('record_id') == created['money']]
ok = row and row[0].get('金额') == 45.8 and row[0].get('分类') == '餐饮' and row[0].get('备注') == '午饭'
check('金额已更新且其它字段保留', bool(ok), str(row[:1]))

code, body = call('PATCH', '/api/t/money/rec_does_not_exist', {'properties': {'金额': 1}})
check('改不存在的记录返回 404', code == 404, 'got %s' % code)

print('\n[5] 删除')
code, body = call('DELETE', '/api/t/media/%s' % created['media'])
check('DELETE 返回 200', code == 200, 'got %s %s' % (code, body))
code, body = call('GET', '/api/t/media')
left = [r for r in body.get('records', []) if r.get('record_id') == created['media']]
check('记录确实没了', not left, 'still there: %s' % left)
code, body = call('DELETE', '/api/t/media/rec_does_not_exist')
check('删不存在的记录返回 404', code == 404, 'got %s' % code)

print('\n[6] 批量导入')
code, body = call('POST', '/api/t/habit/import', {
    'rows': [{'日期': '2026-09-%02d' % d, '习惯': '喝水', '数值': d % 8} for d in range(1, 11)]
})
check('import 插入 10 条', code == 200 and body.get('inserted') == 10, 'got %s %s' % (code, body))
code, body = call('GET', '/api/t/habit')
check('habit 表现在有 11 条', body.get('count') == 11, 'count=%s' % body.get('count'))

print('\n[7] 清空')
code, body = call('POST', '/api/t/habit/clear', {})
check('不带 confirm 被拒 400', code == 400, 'got %s' % code)
code, body = call('POST', '/api/t/habit/clear', {'confirm': True})
check('带 confirm 清空成功', code == 200 and body.get('removed') == 11, 'got %s %s' % (code, body))
code, body = call('GET', '/api/t/habit')
check('habit 表已空', body.get('count') == 0, 'count=%s' % body.get('count'))

print('\n[8] 静态页面托管')
try:
    req = urllib.request.Request(BASE + '/')
    with urllib.request.urlopen(req, timeout=10) as r:
        page = r.read().decode('utf-8', 'ignore')
    check('GET / 返回页面', r.status == 200 and 'dbFetchAll' in page, 'len=%d' % len(page))
    check('页面内注入的 apiBase 为空（同源）', 'apiBase: ""' in page, '')
except Exception as e:
    check('GET / 返回页面', False, str(e))

print('\n' + '=' * 60)
if FAILED:
    print('结果：%d 项通过，%d 项失败' % (PASSED, len(FAILED)))
    for f in FAILED:
        print('  失败：%s' % f)
    sys.exit(1)
print('结果：全部 %d 项通过' % PASSED)

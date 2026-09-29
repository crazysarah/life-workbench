#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
对构建出来的客户端页面做静态自检：
  1. 抽出所有 <script> 块，逐块做 JS 语法检查（调 node --check）
  2. 断言关键函数/配置存在，旧 SDK 痕迹不存在
  3. 检查 API 调用点是否都指向自建接口

用法：python build/check_client.py [client/index.html]
"""

import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

MUST_HAVE = [
    'window.__LW_CONFIG__',
    'function dbFetchAll',
    'function dbAdd',
    'function dbUpdate',
    'function dbDelete',
    'function pullAllRemote',
    'function mergeMoney',
    'function mergeHabit',
    'function mergePlan',
    'function mergeFitness',
    'function mergeShopping',
    'function mergeMedia',
    "var DB_MONEY = 'money'",
    '/api/t/',
]

MUST_NOT_HAVE = [
    '__SMART_PAGE__',
    'data-sp-database-id',
    'data-page-node-id',
    'R3tOBq2PgKfc2Vu0uf1Inp',
    'UlAWUbiHzQiw93hps3z0lG',
    '/page/page_comm/inject.js',
]


def find_node():
    for cand in [
        os.environ.get('NODE_BIN', ''),
        r'C:\Users\panwr\.workbuddy\binaries\node\versions\22.22.2-3\node.exe',
        'node',
    ]:
        if not cand:
            continue
        try:
            subprocess.run([cand, '-v'], capture_output=True, check=True)
            return cand
        except Exception:
            continue
    return None


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(REPO, 'client', 'index.html')
    if not os.path.isfile(path):
        sys.exit('[check] 找不到 %s' % path)

    with open(path, 'r', encoding='utf-8') as f:
        html = f.read()

    fails = []
    warns = []

    # ---- 1. 关键内容断言 ----
    for token in MUST_HAVE:
        if token not in html:
            fails.append('缺少必需内容：%s' % token)
    for token in MUST_NOT_HAVE:
        if token in html:
            fails.append('残留旧痕迹：%s' % token)

    print('[check] 文件：%s（%d 字符）' % (path, len(html)))
    print('[check] 必需内容 %d 项 / 禁止内容 %d 项' % (len(MUST_HAVE), len(MUST_NOT_HAVE)))

    # ---- 2. 抽 script 做语法检查 ----
    script_re = re.compile(r'<script\b([^>]*)>(.*?)</script>', re.S | re.I)
    blocks = []
    for i, m in enumerate(script_re.finditer(html)):
        attrs, body = m.group(1), m.group(2)
        if 'src=' in attrs.lower():
            warns.append('第 %d 个 script 是外链（应为零外部依赖）' % (i + 1))
            continue
        if not body.strip():
            continue
        blocks.append((i + 1, body))

    print('[check] 内联 script 块：%d 个' % len(blocks))

    node = find_node()
    if not node:
        warns.append('没找到 node，跳过 JS 语法检查')
    else:
        for idx, body in blocks:
            with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False, encoding='utf-8') as tf:
                tf.write(body)
                tmp = tf.name
            try:
                r = subprocess.run([node, '--check', tmp], capture_output=True, text=True)
                if r.returncode != 0:
                    fails.append('script #%d 语法错误：\n%s' % (idx, (r.stderr or '').strip()[:800]))
                else:
                    print('[check]   script #%d 语法 OK（%d 字符）' % (idx, len(body)))
            finally:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass

    # ---- 3. 外部依赖检查 ----
    ext = re.findall(r'(?:src|href)="(https?://[^"]+)"', html)
    ext = [u for u in ext if 'w3.org' not in u]
    if ext:
        fails.append('存在外部依赖：%s' % ', '.join(ext[:5]))
    else:
        print('[check] 外部依赖：0（页面自包含）')

    # ---- 4. API 调用点统计 ----
    api_calls = re.findall(r"/api/[a-z/:'\s+.\w()\[\]]*", html)
    hits = re.findall(r"'/api/[^']*'", html)
    print('[check] 自建接口调用点字面量：%d 处' % len(hits))
    for h in sorted(set(hits)):
        print('[check]   %s' % h)

    print()
    for w in warns:
        print('[check][WARN] %s' % w)
    if fails:
        for x in fails:
            print('[check][FAIL] %s' % x)
        sys.exit(1)
    print('[check] 全部通过')


if __name__ == '__main__':
    main()

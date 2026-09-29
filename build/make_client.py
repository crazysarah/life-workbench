#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把资料库导出的原始单文件工作台，改造成指向自建后端的版本。

做三件事：
  1. 把「Database SDK Integration」整段替换成自研 API 适配器（build/adapter.js）
  2. 在 <head> 注入移动端 / PWA 所需 meta，以及服务端地址配置
  3. 输出到 client/index.html

用法：
    python build/make_client.py                        # 同源模式（浏览器直接开服务器地址）
    python build/make_client.py --api-base http://203.0.113.10:8080   # 给 APK 用
"""

import argparse
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

SRC_HTML = os.path.join(REPO, '_src', 'life-all-in-one.html')
ADAPTER = os.path.join(HERE, 'adapter.js')
OUT_HTML = os.path.join(REPO, 'client', 'index.html')

START_MARK = '/* ================= Database SDK Integration ================= */'
END_MARK = 'function pullAllRemote(cb){'

HEAD_BLOCK = """  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <meta name="theme-color" content="#faf8f5">
  <meta name="color-scheme" content="light">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="\u751f\u6d3b\u5de5\u4f5c\u53f0">
  <link rel="manifest" href="manifest.webmanifest">
  <script>window.__LW_CONFIG__ = { apiBase: "__LW_API_BASE__" };</script>
"""


def read(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--api-base', default='',
                    help='服务端地址，如 http://203.0.113.10:8080（换成你自己的）；留空表示同源')
    ap.add_argument('--src', default=SRC_HTML)
    ap.add_argument('--out', default=OUT_HTML)
    args = ap.parse_args()

    if not os.path.isfile(args.src):
        sys.exit('[make_client] 找不到源文件：%s' % args.src)

    html = read(args.src)
    adapter = read(ADAPTER).rstrip() + '\n'

    # ---------- 1. 替换数据层 ----------
    try:
        start = html.index(START_MARK)
        end = html.index(END_MARK, start)
    except ValueError:
        sys.exit('[make_client] 找不到替换锚点，源文件结构可能变了。\n'
                 '  起点标记：%s\n  终点标记：%s' % (START_MARK, END_MARK))

    replaced = html[:start] + adapter + '\n  ' + html[end:]
    print('[make_client] 数据层已替换：%d 字符 -> %d 字符' % (end - start, len(adapter)))

    # ---------- 2. 注入 head ----------
    head_block = HEAD_BLOCK.replace('__LW_API_BASE__', args.api_base)

    # 干掉原有的 viewport，避免两份冲突
    replaced, n_viewport = re.subn(
        r'<meta[^>]*name=["\']viewport["\'][^>]*>\s*',
        '',
        replaced,
        count=1,
        flags=re.IGNORECASE,
    )
    if n_viewport:
        print('[make_client] 已移除原有 viewport meta')

    if '</head>' not in replaced:
        sys.exit('[make_client] 源文件里没有 </head>')
    replaced = replaced.replace('</head>', head_block + '</head>', 1)
    print('[make_client] head 注入完成（apiBase=%r）' % args.api_base)

    # ---------- 3. 清掉资料库编辑器的绑定属性 ----------
    # 这些是宿主页面编辑器用的（节点 id、数据表绑定），自建版里是无意义的死属性，
    # 留着还会暴露旧的数据表 id。
    dead_attrs = [
        r'\s+data-page-node-id="[^"]*"',
        r'\s+data-pnid-children="[^"]*"',
        r'\s+data-sp-bindable="[^"]*"',
        r'\s+data-sp-database-id="[^"]*"',
        r'\s+data-sp-[a-z-]+="[^"]*"',
    ]
    removed_total = 0
    for pat in dead_attrs:
        replaced, n = re.subn(pat, '', replaced)
        removed_total += n
    print('[make_client] 清理宿主绑定属性 %d 处' % removed_total)

    # ---------- 3b. 移除宿主注入的脚本 ----------
    # 资料库容器会往页面里塞 <script src="/page/page_comm/inject.js">，
    # 自建环境里这个路径不存在（会 404），而且它是宿主 SDK 的注入入口，必须去掉。
    replaced, n_host = re.subn(
        r'<script\s+src="/(?:page|static)/[^"]*"\s*>\s*</script>\s*',
        '',
        replaced,
        flags=re.IGNORECASE,
    )
    print('[make_client] 移除宿主注入脚本 %d 个' % n_host)

    # ---------- 4. 输出 ----------
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w', encoding='utf-8', newline='') as f:
        f.write(replaced)

    size = os.path.getsize(args.out)
    print('[make_client] 输出：%s（%d bytes）' % (args.out, size))

    # 自检
    for token in ['__LW_CONFIG__', 'function dbFetchAll', 'function dbAdd',
                  'function dbUpdate', 'function dbDelete', 'function pullAllRemote']:
        if token not in replaced:
            print('[make_client][WARN] 产物里缺少 %s' % token)
    for legacy in ['__SMART_PAGE__', 'R3tOBq2PgKfc2Vu0uf1Inp', 'UlAWUbiHzQiw93hps3z0lG']:
        if legacy in replaced:
            print('[make_client][WARN] 产物里仍残留 %s' % legacy)
    print('[make_client] 完成')


if __name__ == '__main__':
    main()

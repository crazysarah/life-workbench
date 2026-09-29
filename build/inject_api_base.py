#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
给已构建好的 client/index.html 注入服务端地址，产出 mobile/www/index.html。

为什么需要这一步：APK 里的前端是内嵌的，服务端地址必须在构建时写进去。
仓库里放的是成品 client/index.html（已不含任何资料库残留），
所以构建时只需换掉 apiBase 这一个值，不必重新从原始页面生成。

要从原始页面完整重建 client/index.html（比如改了 build/adapter.js 之后），
用 build/make_client.py —— 但那需要自备资料库导出的原始页面
（源码库不收录它，因为它带着资料库的数据库 id）。

用法：
    python build/inject_api_base.py --api-base http://203.0.113.10:8080
    python build/inject_api_base.py --api-base ""     # 同源模式（浏览器直接开服务器地址）
"""

import argparse
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

SRC = os.path.join(REPO, 'client', 'index.html')
OUT = os.path.join(REPO, 'mobile', 'www', 'index.html')

# 只认这一处配置，不做泛匹配 —— 匹配数不等于 1 就直接报错退出，
# 避免改错位置后悄悄产出一个连不上服务器的包。
PATTERN = re.compile(r'(window\.__LW_CONFIG__\s*=\s*\{\s*apiBase:\s*)"[^"]*"')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--api-base', default='',
                    help='服务端地址，如 http://203.0.113.10:8080（换成你自己的）；留空表示同源')
    ap.add_argument('--src', default=SRC)
    ap.add_argument('--out', default=OUT)
    args = ap.parse_args()

    if not os.path.isfile(args.src):
        sys.exit('[inject] 找不到 %s\n'
                 '  请先确认 client/index.html 已入库（git ls-files client/）' % args.src)

    with open(args.src, 'r', encoding='utf-8') as f:
        html = f.read()

    # 用 lambda 替换，避免地址里的特殊字符被当成反向引用
    new_html, n = PATTERN.subn(lambda m: m.group(1) + '"' + args.api_base + '"', html)

    if n != 1:
        sys.exit('[inject] 期望匹配 1 处 apiBase，实际匹配 %d 处，已放弃（不改比改错好）\n'
                 '  源文件：%s\n'
                 '  预期形如：window.__LW_CONFIG__ = { apiBase: "" };' % (n, args.src))

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w', encoding='utf-8', newline='') as f:
        f.write(new_html)

    print('[inject] apiBase = %r' % args.api_base)
    print('[inject] 输出：%s（%d bytes）' % (args.out, os.path.getsize(args.out)))

    # 产物自检：注入后这个值必须出现，且只出现一次
    with open(args.out, 'r', encoding='utf-8') as f:
        out_html = f.read()
    if args.api_base and out_html.count('apiBase: "%s"' % args.api_base) != 1:
        sys.exit('[inject] 产物自检失败：注入后的地址不是恰好出现 1 次')


if __name__ == '__main__':
    main()

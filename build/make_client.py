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


# --------------------------------------------------------------------------
# 页面功能补丁
#
# 「清空示例」原先是 topbar 上的一颗垃圾桶按钮：手机上又小又容易误触，
# 而且它只是「示例数据」的清理入口，不该占着首屏。改成由设置面板
# （build/adapter.js）提供入口，页面这里只把「能力」暴露出去：
#     window.lwSampleStatus()  -> 还有多少示例数据
#     window.lwClearSamples()  -> 执行清空（自带二次确认），返回 false 表示没得清
#
# 每条补丁都严格校验命中次数：源页面改版导致补丁打不上时**直接报错退出**，
# 不会静默产出一个功能缺失的包。
# --------------------------------------------------------------------------

PAGE_PATCH_REGEX = [
    (
        '移除 topbar 的清空示例按钮',
        r'[ \t]*<button[^>]*\bid="clearSamplesBtn"[^\n]*\n',
        '',
    ),
    (
        'renderBackupStatus 不再维护该按钮的显隐',
        r"[ \t]*function renderBackupStatus\(\)\{document\.getElementById\('clearSamplesBtn'\)\.hidden=[^\n]*\n",
        '  /* 清空示例入口已移入设置面板（见 build/adapter.js），这里不再维护按钮显隐 */\n'
        '  function renderBackupStatus(){}\n',
    ),
    (
        '清空示例改为暴露给设置面板调用',
        r"[ \t]*document\.getElementById\('clearSamplesBtn'\)\.addEventListener\('click',[^\n]*\n",
        '    /* 清空示例数据：入口在设置面板里，这里只暴露能力给它调 */\n'
        '    window.lwSampleStatus=function(){const records=state.records.filter(r=>r.sample).length,'
        'media=state.mediaItems.filter(item=>item.sample).length;'
        'return{records:records,media:media,habits:state.habits.filter(h=>h.sample).length,'
        'total:records+media};};\n'
        '    window.lwClearSamples=function(){const s=window.lwSampleStatus();'
        'if(!s.total&&!s.habits)return false;'
        'if(!confirm(`将清空 ${s.total} 条示例记录和示例打卡，你自己的内容会保留。是否继续？`))return false;'
        'state.records=state.records.filter(r=>!r.sample);'
        'state.mediaItems=state.mediaItems.filter(item=>!item.sample);'
        'state.habits.forEach(h=>{if(h.sample){h.entries={};h.sample=false;}});'
        'state.settings.weeklyPlan=DEFAULT_PLAN.map(x=>({...x}));'
        'const saved=saveState();renderAll();if(saved)toast(\'示例内容已清空\');return true;};\n',
    ),
]

PAGE_PATCH_LITERAL = [
    (
        '移动端 topbar 不再给已删按钮留格子',
        '.top-actions{width:100%;min-width:0;display:grid;'
        'grid-template-columns:48px minmax(0,1fr) minmax(0,1.35fr)}'
        '.top-actions .save-state{display:none}'
        '.top-actions:has(#clearSamplesBtn[hidden]){grid-template-columns:minmax(0,1fr) minmax(0,1.35fr)}'
        '.top-actions .btn{width:100%;min-width:0;min-height:46px;padding:0 8px;white-space:nowrap}'
        '.top-actions #clearSamplesBtn span{display:none}',
        '.top-actions{display:none}',
    ),
]


def apply_page_patches(html):
    for name, pattern, repl in PAGE_PATCH_REGEX:
        html, n = re.subn(pattern, repl, html)
        if n != 1:
            sys.exit('[make_client] 页面补丁「%s」命中 %d 处（期望 1 处）。\n'
                     '  源页面结构可能已经变化，请核对 build/make_client.py 里的锚点。' % (name, n))
        print('[make_client] 页面补丁：%s' % name)

    for name, old, new in PAGE_PATCH_LITERAL:
        n = html.count(old)
        if n != 1:
            sys.exit('[make_client] 页面补丁「%s」命中 %d 处（期望 1 处）。\n'
                     '  源页面结构可能已经变化，请核对 build/make_client.py 里的锚点。' % (name, n))
        html = html.replace(old, new)
        print('[make_client] 页面补丁：%s' % name)

    # 补丁打完后不该再有任何地方引用旧按钮
    if 'clearSamplesBtn' in html:
        sys.exit('[make_client] 页面补丁执行后仍残留 clearSamplesBtn 引用，已中止。')
    for fn in ['window.lwSampleStatus', 'window.lwClearSamples']:
        if fn not in html:
            sys.exit('[make_client] 页面补丁执行后缺少 %s，已中止。' % fn)
    return html


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

    # ---------- 3c. 页面功能补丁 ----------
    replaced = apply_page_patches(replaced)

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

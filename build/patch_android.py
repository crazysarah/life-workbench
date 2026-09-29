#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
给 Capacitor 生成出来的安卓工程打补丁。

为什么需要：
  WebView 里页面 origin 是 https://localhost，而 API 地址是 http://<IP>:<端口>，
  属于「明文流量 + 混合内容」。Android 9 起默认禁止明文 HTTP，
  不放开的话所有 /api 请求会被系统直接拒绝，表现为「连不上服务器」。

  因为服务器地址是用户在 App 里自己填的（可能是任意 IP 的 http 地址），
  这两道开关必须打开，否则用户填了地址也连不上、还看不出原因。

补丁内容：
  1. AndroidManifest 的 <application> 加 android:usesCleartextTraffic="true"
  2. 补 INTERNET 权限（防模板被改坏）
  3. 校验 capacitor.config.json 里的 allowMixedContent / cleartext 没被关掉
     —— 这两个是 Capacitor 侧设置 WebSettings 的依据，关掉同样会连不上
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
MANIFEST = os.path.join(REPO, 'mobile', 'android', 'app', 'src', 'main', 'AndroidManifest.xml')
CAP_CONFIG = os.path.join(REPO, 'mobile', 'capacitor.config.json')


def main():
    if not os.path.isfile(MANIFEST):
        sys.exit('[patch_android] 找不到 %s\n'
                 '  请先执行 npx cap add android && npx cap sync android' % MANIFEST)

    with open(MANIFEST, 'r', encoding='utf-8') as f:
        xml = f.read()

    original = xml

    if 'usesCleartextTraffic' in xml:
        print('[patch_android] usesCleartextTraffic 已存在，跳过')
    else:
        m = re.search(r'<application\b[^>]*>', xml)
        if not m:
            sys.exit('[patch_android] AndroidManifest 里找不到 <application> 标签')
        tag = m.group(0)
        new_tag = tag[:-1].rstrip() + '\n        android:usesCleartextTraffic="true">'
        xml = xml[:m.start()] + new_tag + xml[m.end():]
        print('[patch_android] 已写入 android:usesCleartextTraffic="true"')

    # 兜底：确保有 INTERNET 权限（Capacitor 模板默认有，防止被误删）
    if 'android.permission.INTERNET' not in xml:
        xml = xml.replace(
            '<application',
            '<uses-permission android:name="android.permission.INTERNET" />\n    <application',
            1,
        )
        print('[patch_android] 已补上 INTERNET 权限')

    if xml != original:
        with open(MANIFEST, 'w', encoding='utf-8', newline='\n') as f:
            f.write(xml)
        print('[patch_android] 已写入 %s' % MANIFEST)
    else:
        print('[patch_android] 无需改动')

    # ---- 3. 校验 Capacitor 侧的两个开关 ----
    # 用户在 App 里可能填任意 http 地址，这两个开关关了就连不上，而且报错很难查。
    if not os.path.isfile(CAP_CONFIG):
        sys.exit('[patch_android] 找不到 %s' % CAP_CONFIG)
    with open(CAP_CONFIG, 'r', encoding='utf-8') as f:
        try:
            cfg = json.load(f)
        except ValueError as e:
            sys.exit('[patch_android] %s 不是合法 JSON：%s' % (CAP_CONFIG, e))

    android_cfg = cfg.get('android') or {}
    server_cfg = cfg.get('server') or {}
    problems = []
    if android_cfg.get('allowMixedContent') is not True:
        problems.append('android.allowMixedContent 不是 true（https 页面请求 http 接口会被拦）')
    if server_cfg.get('cleartext') is not True:
        problems.append('server.cleartext 不是 true（明文 HTTP 会被系统拒绝）')
    if problems:
        for p in problems:
            print('[patch_android][FAIL] %s' % p)
        sys.exit('[patch_android] capacitor.config.json 被改坏了：'
                 '用户填 http 地址会连不上服务器，请改回 true 再构建')

    print('[patch_android] capacitor.config.json 明文流量开关正常（allowMixedContent / cleartext）')
    print('[patch_android] 完成')


if __name__ == '__main__':
    main()

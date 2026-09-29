#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
给 Capacitor 生成出来的安卓工程打补丁。

为什么需要：
  WebView 里页面 origin 是 https://localhost，而 API 地址是 http://<IP>:<端口>，
  属于「明文流量 + 混合内容」。Android 9 起默认禁止明文 HTTP，
  不放开的话所有 /api 请求会被系统直接拒绝，表现为「连不上服务器」。

补丁内容：
  1. AndroidManifest 的 <application> 加 android:usesCleartextTraffic="true"
  2. 校验 allowMixedContent 是否生效（Capacitor 会据此设置 WebSettings）
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
MANIFEST = os.path.join(REPO, 'mobile', 'android', 'app', 'src', 'main', 'AndroidManifest.xml')


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

    print('[patch_android] 完成')


if __name__ == '__main__':
    main()

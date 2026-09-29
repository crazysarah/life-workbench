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
  4. 注入固定签名配置（signingConfigs），并保证密钥文件就位
     —— 不固定签名的话，CI 每次新机器都会现场随机生成一把密钥，
        每个包签名都不同，手机上装新版直接报「签名不一致，无法覆盖安装」
"""

import json
import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
MANIFEST = os.path.join(REPO, 'mobile', 'android', 'app', 'src', 'main', 'AndroidManifest.xml')
CAP_CONFIG = os.path.join(REPO, 'mobile', 'capacitor.config.json')
APP_DIR = os.path.join(REPO, 'mobile', 'android', 'app')
GRADLE = os.path.join(APP_DIR, 'build.gradle')
# 安卓工程是 gitignore 的现场生成目录，所以密钥得在构建时拷进来
KEYSTORE_NAME = 'lw-debug.p12'
KEYSTORE_DST = os.path.join(APP_DIR, KEYSTORE_NAME)
# 本地生成的私钥位置（同样被 .gitignore 排除）；CI 里由 Secret 还原
KEYSTORE_LOCAL = os.path.join(HERE, KEYSTORE_NAME)

# 这几个值必须和 build/make_signing_key.py 生成密钥时用的一致
SIGNING_ALIAS = 'androiddebugkey'
SIGNING_STORE_PASSWORD = 'android'
SIGNING_KEY_PASSWORD = 'android'

SIGNING_BLOCK = """
    // ↓↓ 由 build/patch_android.py 注入：固定签名密钥 ↓↓
    // 不固定的话，CI 每次都是新机器，Gradle 会找 ~/.android/debug.keystore，
    // 找不到就现场随机生成一把 —— 结果每个包签名都不同，手机装新版直接报
    // 「签名不一致，无法覆盖安装」，只能卸载重装。
    signingConfigs {
        debug {
            storeFile file("%s")
            storeType "PKCS12"
            storePassword "%s"
            keyAlias "%s"
            keyPassword "%s"
        }
    }
    // ↑↑ 注入结束 ↑↑
""" % (KEYSTORE_NAME, SIGNING_STORE_PASSWORD, SIGNING_ALIAS, SIGNING_KEY_PASSWORD)


def ensure_keystore():
    """把签名密钥放到安卓工程里（CI 已提前还原好就直接用）。"""
    if os.path.isfile(KEYSTORE_DST):
        print('[patch_android] 签名密钥已就位：%s' % KEYSTORE_DST)
        return

    candidates = []
    if os.environ.get('LW_KEYSTORE'):
        candidates.append(os.environ['LW_KEYSTORE'])
    candidates.append(KEYSTORE_LOCAL)

    for src in candidates:
        if src and os.path.isfile(src):
            shutil.copyfile(src, KEYSTORE_DST)
            print('[patch_android] 已拷贝签名密钥 %s -> %s' % (src, KEYSTORE_DST))
            return

    sys.exit(
        '[patch_android][FAIL] 找不到签名密钥 %s\n'
        '  本地构建：先跑 python3 build/make_signing_key.py 生成 build/%s\n'
        '  CI 构建：检查仓库 Secret「LW_DEBUG_KEYSTORE」是否配置，'
        '以及 workflow 里的「还原签名密钥」步骤有没有执行成功' % (KEYSTORE_NAME, KEYSTORE_NAME))


def patch_signing_config():
    """把 signingConfigs 注入 app/build.gradle（幂等）。"""
    if not os.path.isfile(GRADLE):
        sys.exit('[patch_android] 找不到 %s\n'
                 '  请先执行 npx cap add android && npx cap sync android' % GRADLE)

    with open(GRADLE, 'r', encoding='utf-8') as f:
        src = f.read()

    if KEYSTORE_NAME in src:
        print('[patch_android] 签名配置已存在，跳过')
        return

    m = re.search(r'^[ \t]*android[ \t]*\{', src, re.M)
    if not m:
        sys.exit('[patch_android] build.gradle 里找不到 android { } 块，注入签名配置失败')

    out = src[:m.end()] + '\n' + SIGNING_BLOCK + src[m.end():]

    # release 也复用同一把密钥：这样 debug / release 包能互相覆盖安装
    r = re.search(r'^([ \t]*)release[ \t]*\{', out, re.M)
    if r:
        indent = r.group(1) + '    '
        out = out[:r.end()] + '\n%s// 与 debug 用同一签名，避免两种包互相盖不上\n%ssigningConfig signingConfigs.debug' % (
            indent, indent) + out[r.end():]
        print('[patch_android] 已给 buildTypes.release 指定同一签名')
    else:
        print('[patch_android][WARN] build.gradle 里没有 release 块，release 包不会被签名')

    with open(GRADLE, 'w', encoding='utf-8', newline='\n') as f:
        f.write(out)
    print('[patch_android] 已注入固定签名配置到 %s' % GRADLE)


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

    # ---- 4. 固定签名（否则每个包签名都不同，装不上旧版本）----
    ensure_keystore()
    patch_signing_config()

    print('[patch_android] 完成')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把仓库根目录 VERSION 里的版本号注入 Capacitor 生成的安卓工程。

为什么必须「注入」而不是直接改 build.gradle：
  mobile/android/ 是 `npx cap add android` 现场生成的，而且被 .gitignore 忽略、
  不进版本控制。脚手架给的是固定默认值 versionCode 1 / versionName "1.0" ——
  所以每个包在系统里都显示 1.0，用户装了新版完全看不出来，
  同一个 versionCode 反复安装也会被当成同一个版本。
  换句话说：改本地那份 build.gradle 一律无效，CI 每次都是全新的脚手架。

单一来源：仓库根目录 VERSION（内容形如 1.0.2）。版本号只在这里改，别处不要动。
  versionName = VERSION 原样                         给人看的
  versionCode = major*10000 + minor*100 + patch      给系统比大小的
                必须严格递增 —— Android 只接受「同号覆盖」或「升号安装」，
                降号会被直接拒绝安装。

用法：
  python3 build/set_version.py                   # 按 VERSION 注入
  python3 build/set_version.py --check           # 只校验不写（CI 用）
  python3 build/set_version.py --version 1.2.3   # 临时指定（绕过单一来源，慎用）
  python3 build/set_version.py --gradle <路径>    # 换一个 build.gradle（自测用）
"""

import argparse
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

VERSION_FILE = os.path.join(REPO, 'VERSION')
GRADLE = os.path.join(REPO, 'mobile', 'android', 'app', 'build.gradle')

# build.gradle 里这两行各出现一次、独占一行
CODE_RE = re.compile(r'^([ \t]*)versionCode[ \t]+(\d+)[ \t]*$', re.M)
NAME_RE = re.compile(r'^([ \t]*)versionName[ \t]+"([^"]*)"[ \t]*$', re.M)
SEMVER_RE = re.compile(r'^(\d+)\.(\d+)\.(\d+)$')

CODE_STRIDE_MINOR = 10000
CODE_STRIDE_PATCH = 100


def rel(path):
    try:
        return os.path.relpath(path, REPO).replace('\\', '/')
    except ValueError:
        return path


def read_version_file(path):
    """取第一条有效行，忽略空行与 # 注释。"""
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            s = line.strip()
            if s and not s.startswith('#'):
                return s
    sys.exit('[version] %s 里没有有效内容' % path)


def parse_version(raw):
    text = (raw or '').strip().lstrip('vV').strip()
    m = SEMVER_RE.match(text)
    if not m:
        sys.exit('[version] VERSION 内容应为 X.Y.Z（例如 1.0.2），实际是 %r' % raw)
    major, minor, patch = (int(x) for x in m.groups())
    if minor > 99 or patch > 99:
        sys.exit('[version] minor / patch 不能超过 99（受 versionCode 编码规则限制）：%s' % text)
    return text, major * CODE_STRIDE_MINOR + minor * CODE_STRIDE_PATCH + patch


def main():
    ap = argparse.ArgumentParser(description='把 VERSION 注入安卓工程的 build.gradle')
    ap.add_argument('--version', help='直接指定版本号（默认读 VERSION 文件）')
    ap.add_argument('--version-file', default=VERSION_FILE)
    ap.add_argument('--gradle', default=GRADLE)
    ap.add_argument('--check', action='store_true', help='只校验，不写入')
    args = ap.parse_args()

    # 用 is not None 而不是真值判断：`--version ""` 是「显式传了个空值」，
    # 应该报错，而不是静默回落到 VERSION 文件
    if args.version is not None:
        raw = args.version
    else:
        if not os.path.isfile(args.version_file):
            sys.exit('[version] 找不到 %s' % args.version_file)
        raw = read_version_file(args.version_file)

    name, code = parse_version(raw)

    if not os.path.isfile(args.gradle):
        sys.exit('[version] 找不到 %s\n'
                 '  安卓工程要先生成：cd mobile && npx cap add android\n'
                 '  或者直接跑 bash build/sync_mobile.sh' % args.gradle)

    with open(args.gradle, 'r', encoding='utf-8') as f:
        src = f.read()

    code_hits = CODE_RE.findall(src)
    name_hits = NAME_RE.findall(src)
    if len(code_hits) != 1 or len(name_hits) != 1:
        sys.exit('[version] %s 里 versionCode/versionName 命中数异常'
                 '（versionCode %d 处、versionName %d 处，应各 1 处）\n'
                 '  Capacitor 模板可能变了，先人工确认再构建'
                 % (rel(args.gradle), len(code_hits), len(name_hits)))

    cur_code = int(code_hits[0][1])
    cur_name = name_hits[0][1]

    print('[version] VERSION      %s' % name)
    print('[version] versionName  %s  ->  %s' % (cur_name, name))
    print('[version] versionCode  %s  ->  %s' % (cur_code, code))
    print('[version] 目标文件     %s' % rel(args.gradle))

    if cur_code == code and cur_name == name:
        print('[version] 已是目标值，无需改动')
        return

    if args.check:
        print('[version][FAIL] build.gradle 与 VERSION 不一致')
        print('[version] 修复：python3 build/set_version.py')
        sys.exit(1)

    out = CODE_RE.sub(lambda m: '%sversionCode %d' % (m.group(1), code), src, count=1)
    out = NAME_RE.sub(lambda m: '%sversionName "%s"' % (m.group(1), name), out, count=1)
    if out == src:
        sys.exit('[version] 替换没有生效，请检查 %s' % rel(args.gradle))

    with open(args.gradle, 'w', encoding='utf-8', newline='\n') as f:
        f.write(out)
    print('[version] 已写入 versionCode %d / versionName "%s"' % (code, name))


if __name__ == '__main__':
    main()

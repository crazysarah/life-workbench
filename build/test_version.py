#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
版本号注入的自检。

盯住两件事：
  1. versionCode 的换算规则（1.0.2 → 10002）不能漂 —— 换错了会导致
     覆盖安装被系统拒绝（新号比旧号小）
  2. 注入的边界情况：幂等、只动该动的两行、命中数异常要拒绝而不是默默改错地方

check_apk_version.py 对真包的解析由构建流程本身持续验证（CI 每出一个包就跑一次），
这里不重复造 APK。

用法：python3 build/test_version.py
"""

import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from set_version import parse_version  # noqa: E402

PY = sys.executable
SET_VERSION = os.path.join(HERE, 'set_version.py')

# Capacitor 脚手架的原始样子（8 空格缩进）
SCAFFOLD = (
    "apply plugin: 'com.android.application'\n"
    "\n"
    "android {\n"
    "    namespace \"com.example.app\"\n"
    "    defaultConfig {\n"
    "        applicationId \"com.example.app\"\n"
    "        versionCode 1\n"
    "        versionName \"1.0\"\n"
    "        testInstrumentationRunner \"androidx.test.runner.AndroidJUnitRunner\"\n"
    "    }\n"
    "}\n"
)

passed = 0
fails = []


def check(name, ok, detail=''):
    global passed
    if ok:
        passed += 1
        print('[test_version] OK   %s' % name)
    else:
        fails.append(name)
        print('[test_version] FAIL %s%s' % (name, ('  —— ' + detail) if detail else ''))


def run(args):
    env = dict(os.environ, PYTHONIOENCODING='utf-8')
    return subprocess.run([PY, SET_VERSION] + args, capture_output=True,
                          text=True, encoding='utf-8', errors='replace', env=env)


def write(path, text):
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)


def read(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


def main():
    # ---- 1. versionCode 换算规则 ----
    for raw, expect_name, expect_code in [
        ('1.0.0', '1.0.0', 10000),
        ('1.0.2', '1.0.2', 10002),
        ('1.2.3', '1.2.3', 10203),
        ('2.0.0', '2.0.0', 20000),
        ('10.5.99', '10.5.99', 100599),
        ('v1.0.3', '1.0.3', 10003),      # 容忍 v 前缀
    ]:
        name, code = parse_version(raw)
        check('%s -> versionCode %d' % (raw, expect_code),
              (name, code) == (expect_name, expect_code), '实际 %s / %s' % (name, code))

    # 递增性：新版本号必须比旧的大，否则覆盖安装会被系统拒绝
    seq = ['1.0.0', '1.0.1', '1.0.2', '1.1.0', '2.0.0']
    codes = [parse_version(v)[1] for v in seq]
    check('版本号递增时 versionCode 同步递增', codes == sorted(codes) and len(set(codes)) == len(codes),
          '%s' % list(zip(seq, codes)))

    tmp = tempfile.mkdtemp(prefix='lw-version-test-')
    try:
        g = os.path.join(tmp, 'build.gradle')

        # ---- 2. 注入脚手架默认值 ----
        write(g, SCAFFOLD)
        r = run(['--version', '1.0.2', '--gradle', g])
        txt = read(g)
        check('注入成功（退出码 0）', r.returncode == 0, (r.stdout + r.stderr).strip()[:200])
        check('versionCode 改成 10002', 'versionCode 10002' in txt)
        check('versionName 改成 "1.0.2"', 'versionName "1.0.2"' in txt)
        check('缩进保持 8 空格', '\n        versionCode 10002' in txt)
        check('其它内容一字未动',
              txt.replace('versionCode 10002', 'versionCode 1')
                 .replace('versionName "1.0.2"', 'versionName "1.0"') == SCAFFOLD)

        # ---- 3. 幂等 ----
        r = run(['--version', '1.0.2', '--gradle', g])
        check('幂等：重复注入不改动', r.returncode == 0 and '已是目标值' in r.stdout)
        check('幂等：文件内容不变', read(g) == txt)

        # ---- 4. --check ----
        r = run(['--version', '1.0.2', '--gradle', g, '--check'])
        check('--check 对已注入的通过', r.returncode == 0, (r.stdout + r.stderr).strip()[:200])

        write(g, SCAFFOLD)
        r = run(['--version', '1.0.2', '--gradle', g, '--check'])
        check('--check 对未注入的失败', r.returncode == 1)
        check('--check 失败时给出修复命令', 'set_version.py' in (r.stdout + r.stderr))
        check('--check 不写文件', read(g) == SCAFFOLD)

        # ---- 5. 命中数异常必须拒绝（不能猜着改）----
        write(g, SCAFFOLD.replace('        versionCode 1\n',
                                  '        versionCode 1\n        versionCode 7\n'))
        r = run(['--version', '1.0.2', '--gradle', g])
        check('versionCode 出现两次 -> 拒绝',
              r.returncode == 1 and '命中数异常' in (r.stdout + r.stderr))
        check('拒绝后文件未被改动', 'versionCode 7' in read(g))

        # ---- 6. 非法输入 ----
        write(g, SCAFFOLD)
        for bad in ['1.0', 'v1', 'abc', '1.0.2.3', '']:
            r = run(['--version', bad, '--gradle', g])
            check('非法版本号 %r 被拒绝' % bad, r.returncode == 1)
        r = run(['--version', '1.0.100', '--gradle', g])
        check('patch 超过 99 被拒绝（versionCode 编码不了）', r.returncode == 1)

        # ---- 7. 找不到 build.gradle 时给可执行提示 ----
        r = run(['--version', '1.0.2', '--gradle', os.path.join(tmp, 'nope.gradle')])
        check('缺 build.gradle -> 拒绝并提示 cap add android',
              r.returncode == 1 and 'cap add android' in (r.stdout + r.stderr))

        # ---- 8. 真实 VERSION 文件能用 ----
        r = run(['--gradle', g])
        check('默认读仓库根目录 VERSION', r.returncode == 0, (r.stdout + r.stderr).strip()[:200])
        check('VERSION 里的版本号已写入', 'versionName "%s"' % parse_version(read(os.path.join(REPO, 'VERSION')))[0] in read(g))

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    print('[test_version] 通过 %d 项' % passed)
    if fails:
        for f in fails:
            print('[test_version][FAIL] %s' % f)
        sys.exit(1)
    print('[test_version] 全部通过')


if __name__ == '__main__':
    main()

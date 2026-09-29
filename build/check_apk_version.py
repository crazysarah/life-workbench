#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
校验 APK 里**真实**的版本号 —— 系统安装时看到的那两个值。

为什么不能只看构建配置：
  set_version.py 改的是 build.gradle，AGP 有没有把它写进最终的包是另一回事
  （改错文件、被 cap sync 覆盖、模板变了，都会静默失败）。
  这个脚本直接解开 APK 读里面的二进制 AndroidManifest.xml（AXML），
  等价于 aapt dump badging 做的那件事，但不需要装 Android SDK。

输入：
  *.apk                  → 解包读 AndroidManifest.xml（最可信，推荐）
  output-metadata.json   → 读 AGP 构建元数据（CI 里当兜底）

期望值默认来自仓库根目录 VERSION，versionCode 换算规则与 set_version.py 共用。

用法：
  python3 build/check_apk_version.py dist/app-debug.apk
  python3 build/check_apk_version.py mobile/android/app/build/outputs/apk/debug/output-metadata.json
  python3 build/check_apk_version.py --expect 1.0.2 dist/*.apk
  python3 build/check_apk_version.py            # 不给参数就自动找常见产物位置
"""

import argparse
import glob
import json
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
VERSION_FILE = os.path.join(REPO, 'VERSION')

sys.path.insert(0, HERE)
from set_version import parse_version, read_version_file  # noqa: E402

# AXML chunk 类型
CHUNK_STRING_POOL = 0x0001
CHUNK_START_ELEMENT = 0x0102
# typed value 的 dataType
TYPE_STRING = 0x03
TYPE_INT_DEC = 0x10
TYPE_INT_HEX = 0x11
NO_INDEX = 0xFFFFFFFF


# ---------- AXML（Android 二进制 XML）解析 ----------

def _u16(b, o):
    return b[o] | (b[o + 1] << 8)


def _u32(b, o):
    return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)


def _len8(b, o):
    """UTF-8 字符串长度：首字节高位为 1 时用两字节（高 7 位 << 8 | 次字节）。"""
    first = b[o]
    if first & 0x80:
        return ((first & 0x7F) << 8) | b[o + 1], 2
    return first, 1


def _len16(b, o):
    """UTF-16 字符串长度：同样的两段式编码，读出来是字符数。"""
    first = _u16(b, o)
    if first & 0x8000:
        return ((first & 0x7FFF) << 16) | _u16(b, o + 2), 4
    return first, 2


def parse_string_pool(buf, start):
    header_size = _u16(buf, start + 2)
    count = _u32(buf, start + 8)
    flags = _u32(buf, start + 16)
    strings_start = _u32(buf, start + 20)
    utf8 = bool(flags & (1 << 8))
    base = start + strings_start

    out = []
    for i in range(count):
        off = _u32(buf, start + header_size + i * 4)
        p = base + off
        if utf8:
            _, n1 = _len8(buf, p)
            _, n2 = _len8(buf, p + n1)
            body = p + n1 + n2
            out.append(buf[body:body + n2].decode('utf-8', 'replace'))
        else:
            n, n1 = _len16(buf, p)
            body = p + n1
            out.append(buf[body:body + n * 2].decode('utf-16-le', 'replace'))
    return out, _u32(buf, start + 4)


def _read_attrs(buf, off, header_size, pool):
    attr_start = _u16(buf, off + 24)
    attr_size = _u16(buf, off + 26)
    attr_count = _u16(buf, off + 28)
    if attr_size <= 0:
        raise ValueError('AXML 属性尺寸为 0，文件可能损坏')

    p = off + header_size + attr_start
    out = {}
    for i in range(attr_count):
        a = p + i * attr_size
        name_idx = _u32(buf, a + 4)
        raw_idx = _u32(buf, a + 8)
        dtype = buf[a + 15]
        data = _u32(buf, a + 16)

        if name_idx >= len(pool):
            continue
        key = pool[name_idx]
        if not key:
            continue

        if dtype == TYPE_STRING:
            out[key] = pool[data] if data < len(pool) else ''
        elif dtype in (TYPE_INT_DEC, TYPE_INT_HEX):
            out[key] = data
        elif raw_idx != NO_INDEX and raw_idx < len(pool):
            out[key] = pool[raw_idx]
    return out


def read_manifest_attrs(axml):
    """从 AXML 字节里取出 <manifest> 元素的所有属性。"""
    if len(axml) < 8:
        raise ValueError('AXML 太短（%d 字节）' % len(axml))
    if _u16(axml, 0) != 0x0003:
        raise ValueError('不是 AXML：magic=%#06x' % _u16(axml, 0))

    pool = []
    off = _u16(axml, 2)  # 文件头 headerSize，通常 8
    while off + 8 <= len(axml):
        ctype = _u16(axml, off)
        header_size = _u16(axml, off + 2)
        csize = _u32(axml, off + 4)
        if csize <= 0:
            break

        if ctype == CHUNK_STRING_POOL:
            pool, _ = parse_string_pool(axml, off)
        elif ctype == CHUNK_START_ELEMENT:
            name_idx = _u32(axml, off + 20)
            name = pool[name_idx] if name_idx < len(pool) else ''
            if name == 'manifest':
                return _read_attrs(axml, off, header_size, pool)

        off += csize

    raise ValueError('AXML 里找不到 <manifest> 元素')


# ---------- 两种输入 ----------

def version_from_apk(path):
    with zipfile.ZipFile(path) as z:
        if 'AndroidManifest.xml' not in z.namelist():
            raise ValueError('包里没有 AndroidManifest.xml')
        data = z.read('AndroidManifest.xml')
    attrs = read_manifest_attrs(data)
    code = attrs.get('versionCode')
    return (int(code) if isinstance(code, int) else None), attrs.get('versionName')


def version_from_metadata(path):
    with open(path, 'r', encoding='utf-8') as f:
        doc = json.load(f)
    els = doc.get('elements') or []
    if not els:
        raise ValueError('metadata 里没有 elements')
    e = els[0]
    code = e.get('versionCode')
    return (int(code) if isinstance(code, int) else None), e.get('versionName')


def read_one(path):
    if path.lower().endswith('.apk'):
        return version_from_apk(path)
    if path.lower().endswith('.json'):
        return version_from_metadata(path)
    raise ValueError('不支持的文件类型：%s（只认 .apk 或 .json）' % path)


def auto_discover():
    pats = [
        os.path.join(REPO, 'mobile', 'android', 'app', 'build', 'outputs', 'apk', '**', '*metadata.json'),
        os.path.join(REPO, 'dist', '*.apk'),
        os.path.join(REPO, 'mobile', 'android', 'app', 'build', 'outputs', 'apk', '**', '*.apk'),
    ]
    found = []
    for p in pats:
        found.extend(glob.glob(p, recursive=True))
        if found:
            break
    return found


def main():
    ap = argparse.ArgumentParser(description='校验 APK 内的真实版本号')
    ap.add_argument('paths', nargs='*', help='APK 或 output-metadata.json（可多个）')
    ap.add_argument('--expect', help='期望的 versionName（默认读 VERSION）')
    ap.add_argument('--version-file', default=VERSION_FILE)
    args = ap.parse_args()

    if args.expect:
        raw = args.expect
    else:
        if not os.path.isfile(args.version_file):
            sys.exit('[apk-version] 找不到 %s，也没有 --expect' % args.version_file)
        raw = read_version_file(args.version_file)
    exp_name, exp_code = parse_version(raw)

    targets = args.paths or auto_discover()
    if not targets:
        sys.exit('[apk-version] 没找到可校验的文件，请在参数里指明 APK 或 metadata 路径')

    print('[apk-version] 期望  versionName "%s" / versionCode %d' % (exp_name, exp_code))

    fails = []
    for path in targets:
        label = os.path.basename(path)
        try:
            code, name = read_one(path)
        except Exception as e:  # noqa: BLE001 - 解析失败也要报清楚是哪个文件
            print('[apk-version][FAIL] %s：解析失败 —— %s' % (label, e))
            fails.append('%s：解析失败' % label)
            continue

        shown = 'versionName %s / versionCode %s' % (
            '"%s"' % name if name is not None else '(无)', code if code is not None else '(无)')
        if name == exp_name and code == exp_code:
            print('[apk-version] %-34s %s  ✓ 一致' % (label, shown))
        else:
            print('[apk-version][FAIL] %-29s %s' % (label, shown))
            fails.append('%s 里是 %s，与 VERSION 的 "%s" / %d 不一致'
                         % (label, shown, exp_name, exp_code))

    if fails:
        print()
        for x in fails:
            print('[apk-version][FAIL] %s' % x)
        print('[apk-version] 版本号没进包 —— 检查构建流程里有没有跑 set_version.py')
        sys.exit(1)
    print('[apk-version] 全部通过')


if __name__ == '__main__':
    main()

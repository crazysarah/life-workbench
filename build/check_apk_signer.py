#!/usr/bin/env python3
"""校验 APK 的签名证书指纹，和仓库里记录的固定指纹比对。

## 为什么要校验

签名决定了「能不能覆盖安装」。CI 每次都是新机器，如果签名密钥没固定下来，
Gradle 会现场随机生成一把 —— 打出来的包一个都盖不上上一个。这类故障在本地
完全看不出来（构建日志一切正常，只有手机拒绝安装），所以必须在流水线里拦。

## 怎么读

Android 的签名证书藏在包里的 `META-INF/*.RSA`，是一段 DER 编码的 PKCS#7
SignedData，证书就在里面。这里手写了个最小 DER 解析（只用标准库，CI 上不用装
cryptography），取到证书的 DER 字节后算 SHA-256 —— 这正是 `apksigner verify
--print-certs` 打出来的那个指纹。

## 用法

    python3 build/check_apk_signer.py dist/app-debug.apk
    python3 build/check_apk_signer.py --expect <hex> a.apk b.apk
    python3 build/check_apk_signer.py --expect build/signing-cert.sha256 a.apk
    python3 build/check_apk_signer.py --show-only a.apk     # 只打印，不比对

`--expect` 既接受 64 位十六进制指纹，也接受「指纹文件」路径（`#` 注释行会被忽略）——
后者就是 `build/signing-cert.sha256`，省得手抄一长串十六进制抄错。

退出码：全部一致 0，任一不一致 1。
"""

import argparse
import hashlib
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FINGERPRINT_FILE = ROOT / 'build' / 'signing-cert.sha256'

SIG_SUFFIXES = ('.RSA', '.DSA', '.EC')
TAG_SEQUENCE = 0x30
TAG_CONTEXT_0 = 0xA0        # certificates [0] IMPLICIT
TAG_CONTEXT_1 = 0xA1        # crls [1] IMPLICIT


TAG_INTEGER = 0x02
TAG_OID = 0x06
TAG_UTF8 = 0x0C            # UTF8String
TAG_PRINTABLE = 0x13       # PrintableString
TAG_T61 = 0x14             # TeletexString
TAG_IA5 = 0x16             # IA5String
TAG_BMP = 0x1E             # BMPString
TAG_SET = 0x31

# 证书 subject 里常见的 OID → 短名。不认识的按点分形式原样打出来。
OID_SHORT = {
    '2.5.4.3': 'CN',
    '2.5.4.4': 'SN',
    '2.5.4.5': 'serialNumber',
    '2.5.4.6': 'C',
    '2.5.4.7': 'L',
    '2.5.4.8': 'ST',
    '2.5.4.10': 'O',
    '2.5.4.11': 'OU',
    '2.5.4.12': 'title',
    '1.2.840.113549.1.9.1': 'E',
}

STR_TAGS = (TAG_UTF8, TAG_PRINTABLE, TAG_T61, TAG_IA5)


class DerError(Exception):
    pass


def read_oid(value: bytes) -> str:
    """把 OID 的内容字节还原成点分字符串。"""
    if not value:
        return ''
    first = value[0]
    parts = [str(first // 40), str(first % 40)]
    cur = 0
    for b in value[1:]:
        cur = (cur << 7) | (b & 0x7F)
        if not b & 0x80:
            parts.append(str(cur))
            cur = 0
    return '.'.join(parts)


def decode_str(tag: int, value: bytes) -> str:
    if tag == TAG_BMP:
        return value.decode('utf-16-be', 'replace')
    return value.decode('latin-1', 'replace')


def read_tlv(buf: bytes, off: int):
    """读一个 DER TLV，返回 (tag, value, next_offset, raw_bytes)。"""
    start = off
    if off + 2 > len(buf):
        raise DerError('TLV 头部越界')
    tag = buf[off]
    off += 1
    first = buf[off]
    off += 1
    if first & 0x80:
        n = first & 0x7F
        if n == 0 or n > 4 or off + n > len(buf):
            raise DerError('长度字段不合法')
        length = int.from_bytes(buf[off:off + n], 'big')
        off += n
    else:
        length = first
    if off + length > len(buf):
        raise DerError('内容超出缓冲区（声明 %d，剩余 %d）' % (length, len(buf) - off))
    return tag, buf[off:off + length], off + length, buf[start:off + length]


def certs_from_pkcs7(der: bytes):
    """从 PKCS#7 SignedData 里取出所有证书的 DER 字节。"""
    tag, content_info, _, _ = read_tlv(der, 0)          # ContentInfo ::= SEQUENCE
    if tag != TAG_SEQUENCE:
        raise DerError('不是 SEQUENCE 开头，可能不是 PKCS#7')

    _, _, off, _ = read_tlv(content_info, 0)            # contentType OID
    tag, explicit, _, _ = read_tlv(content_info, off)   # content [0] EXPLICIT
    if tag != TAG_CONTEXT_0:
        raise DerError('拿不到 content [0]，结构不认识')

    tag, signed_data, _, _ = read_tlv(explicit, 0)      # SignedData ::= SEQUENCE
    if tag != TAG_SEQUENCE:
        raise DerError('SignedData 不是 SEQUENCE')

    certs = []
    off = 0
    while off < len(signed_data):
        tag, value, off, _ = read_tlv(signed_data, off)
        if tag == TAG_CONTEXT_0:                        # certificates [0]
            inner = 0
            while inner < len(value):
                ctag, _, inner, craw = read_tlv(value, inner)
                if ctag == TAG_SEQUENCE:                # Certificate
                    certs.append(craw)
        elif tag == TAG_CONTEXT_1:                      # crls [1]，跳过
            continue
    if not certs:
        raise DerError('SignedData 里没找到证书')
    return certs


def subject_rdns(cert_der: bytes):
    """按结构取出证书 subject 里的 (短名, 值)，纯粹为了让人看懂是谁的证书。

    为什么不用「扫一遍可打印字符」那种土办法：ASN.1 的 tag 字节里，
    SEQUENCE(0x30)、SET(0x31) 本身就在 ASCII 可打印区间，会被当成 '0'、'1'
    黏在字符串尾巴上（`life-workbench1`、`Life Workbench Debug0 `）。
    这里老老实实走结构：Certificate → tbsCertificate → subject。
    """
    tag, cert_body, _, _ = read_tlv(cert_der, 0)         # Certificate ::= SEQUENCE
    if tag != TAG_SEQUENCE:
        raise DerError('Certificate 不是 SEQUENCE')
    tag, tbs, _, _ = read_tlv(cert_body, 0)              # tbsCertificate ::= SEQUENCE
    if tag != TAG_SEQUENCE:
        raise DerError('tbsCertificate 不是 SEQUENCE')

    off = 0
    tag, _, off, _ = read_tlv(tbs, off)                 # [0] version，可选
    if tag != TAG_CONTEXT_0:
        off = 0                                          # 没有 version 字段，退回起点
    _, _, off, _ = read_tlv(tbs, off)                   # serialNumber
    _, _, off, _ = read_tlv(tbs, off)                   # signature
    _, _, off, _ = read_tlv(tbs, off)                   # issuer
    _, _, off, _ = read_tlv(tbs, off)                   # validity
    tag, subject, _, _ = read_tlv(tbs, off)             # subject SEQUENCE
    if tag != TAG_SEQUENCE:
        raise DerError('subject 不是 SEQUENCE')

    out = []
    off = 0
    while off < len(subject):
        tag, rdn, off, _ = read_tlv(subject, off)
        if tag != TAG_SET:                              # RelativeDistinguishedName
            continue
        inner = 0
        while inner < len(rdn):
            tag, atv, inner, _ = read_tlv(rdn, inner)   # AttributeTypeAndValue
            if tag != TAG_SEQUENCE:
                continue
            _, oid_raw, aoff, _ = read_tlv(atv, 0)
            tag, val, _, _ = read_tlv(atv, aoff)
            if tag not in STR_TAGS and tag != TAG_BMP:
                continue
            oid = read_oid(oid_raw)
            out.append((OID_SHORT.get(oid, oid), decode_str(tag, val)))
    if not out:
        raise DerError('subject 里没读到字符串')
    return out


def printable_hint(cert_der: bytes) -> str:
    """证书 subject 的可读摘要；结构不认识时退化成粗略扫字符串。"""
    try:
        return ', '.join('%s=%s' % kv for kv in subject_rdns(cert_der))
    except DerError:
        runs = re.findall(rb'[\x20-\x7e]{4,}', cert_der)
        picks = []
        for r in runs:
            s = r.decode('ascii')
            if s in picks or len(s) > 40:
                continue
            picks.append(s)
        return ' / '.join(picks[:4])


def collect_signers(apk: Path):
    """返回 [(来源, 指纹, 可读信息)]。"""
    out = []
    with zipfile.ZipFile(apk) as z:
        names = [n for n in z.namelist()
                 if n.upper().startswith('META-INF/') and n.upper().endswith(SIG_SUFFIXES)]
        if not names:
            raise DerError('包里没有 META-INF/*.RSA —— 未签名，或者只用了 v2/v3 '
                           '签名块（本脚本暂不解析，请改用 apksigner verify --print-certs）')
        for n in sorted(names):
            blob = z.read(n)
            for cert in certs_from_pkcs7(blob):
                out.append((n, hashlib.sha256(cert).hexdigest(), printable_hint(cert)))
    return out


def load_expected(path: Path) -> str:
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if line and not line.startswith('#'):
            return line.lower()
    raise SystemExit('%s 里没有指纹' % path)


def resolve_expected(value: str) -> str:
    """把 --expect 的值规整成 64 位小写十六进制。

    既接受直接写的指纹（允许带 ':' 分隔），也接受指纹**文件**路径 ——
    手抄一长串十六进制太容易抄错，指一下 build/signing-cert.sha256 更省事。
    """
    text = value.strip()
    candidate = Path(text)
    if candidate.is_file():
        text = load_expected(candidate)
    return text.strip().lower().replace(':', '')


def main():
    ap = argparse.ArgumentParser(description='校验 APK 签名证书指纹')
    ap.add_argument('apks', nargs='+', help='一个或多个 APK')
    ap.add_argument('--expect', help='期望的证书指纹，或指纹文件路径'
                                    '（默认读 build/signing-cert.sha256）')
    ap.add_argument('--show-only', action='store_true', help='只打印，不做判定')
    args = ap.parse_args()

    expected = None
    if not args.show_only:
        if args.expect:
            expected = resolve_expected(args.expect)
        else:
            expected = load_expected(FINGERPRINT_FILE).strip().lower().replace(':', '')
        if not re.fullmatch(r'[0-9a-f]{64}', expected):
            raise SystemExit('期望指纹格式不对：%r' % expected)

    if expected:
        print('期望签名指纹 : %s' % expected)
        print()

    bad = 0
    for item in args.apks:
        p = Path(item)
        print('%-46s %s' % (p.name, '(%.2f MB)' % (p.stat().st_size / 1048576)))
        try:
            signers = collect_signers(p)
        except (DerError, zipfile.BadZipFile, OSError) as e:
            print('   [FAIL] 读不出签名：%s' % e)
            bad += 1
            continue

        seen = set()
        for src, fp, hint in signers:
            seen.add(fp)
            if expected is None:
                mark = ''
            elif fp == expected:
                mark = '  ✓ 一致'
            else:
                mark = '  ✗ 不一致'
                bad += 1
            print('   来源 : %s' % src)
            print('   指纹 : %s%s' % (fp, mark))
            if hint:
                print('   证书 : %s' % hint)
        if len(seen) > 1:
            print('   [FAIL] 同一个包里有 %d 种签名证书，不正常' % len(seen))
            bad += 1
        print()

    if args.show_only:
        return 0
    if bad:
        print('[FAIL] 有 %d 处签名不一致 —— 这样的包装不上旧版本，'
              '检查 CI 是否还原了固定签名密钥（仓库变量 LW_DEBUG_KEYSTORE）' % bad)
        return 1
    print('[OK] 签名指纹全部一致')
    return 0


if __name__ == '__main__':
    sys.exit(main())

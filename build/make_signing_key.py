#!/usr/bin/env python3
"""生成一把**固定**的 APK 签名密钥（只在本地跑一次，不要在 CI 里跑）。

## 为什么需要它

Android 规定：同一个包名，**签名必须一致**才能覆盖安装。签名不同时系统会直接拒绝
（报「签名不一致 / 与上一个版本冲突」），只能先卸载再装。

用 `assembleDebug` 构建时，Gradle 用的是 `~/.android/debug.keystore`。CI（GitHub
Actions）每次都是全新的机器，那个文件不存在 —— Gradle 不会报错，而是**现场随机
生成一把**，于是每次构建出来的包签名都不一样，一个都盖不上。

修法：本地生成一把固定密钥，私钥放进仓库变量（构建时还原），指纹写进仓库
（公开无害，用于构建后校验）。这样包签名恒定，以后可以一路覆盖升级。

**为什么是「仓库变量」而不是 Secret**：2026-09-29 实测，本仓库引用一个「存在的」
secret 会让 workflow 直接 startup_failure（1 秒结束、没有任何日志）；把同一份值
放进仓库变量就正常。细节见 README「固定签名」一节。

## 用法

    python3 build/make_signing_key.py                  # 生成 build/lw-debug.p12
    python3 build/make_signing_key.py --fingerprint    # 只打印现有密钥的指纹

生成后：

    base64 -w0 build/lw-debug.p12 > /tmp/ks.b64        # 存成仓库变量 LW_DEBUG_KEYSTORE
    # 提交 build/signing-cert.sha256（脚本会自动写）

`build/lw-debug.p12` 是私钥，**已经被 .gitignore 排除，绝对不要提交**。
"""

import argparse
import base64
import datetime as dt
import hashlib
import sys
from pathlib import Path

try:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives.serialization import pkcs12
    from cryptography.x509.oid import NameOID
except ImportError:  # pragma: no cover
    print('需要 cryptography：pip install cryptography', file=sys.stderr)
    sys.exit(2)

# 这些值必须和 build/patch_android.py 注入的 signingConfigs 完全一致。
ALIAS = 'androiddebugkey'
STORE_PASSWORD = 'android'
KEY_PASSWORD = 'android'
FRIENDLY_NAME = ALIAS          # PKCS12 里 Java 读到的 alias 就是 friendlyName

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / 'build' / 'lw-debug.p12'
FINGERPRINT_FILE = ROOT / 'build' / 'signing-cert.sha256'


def cert_fingerprint(cert) -> str:
    """证书 DER 的 SHA-256，就是 Android 系统的「签名指纹」。"""
    return hashlib.sha256(cert.public_bytes(serialization.Encoding.DER)).hexdigest()


def load_fingerprint(p12_path: Path) -> str:
    key, cert, _ = pkcs12.load_key_and_certificates(
        p12_path.read_bytes(), STORE_PASSWORD.encode())
    if cert is None:
        raise SystemExit('%s 里没有证书' % p12_path)
    return cert_fingerprint(cert)


def generate(out: Path, years: int) -> str:
    now = dt.datetime.now(dt.timezone.utc)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, 'CN'),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, 'life-workbench'),
        x509.NameAttribute(NameOID.COMMON_NAME, 'Life Workbench Debug'),
    ])
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(days=1))
        # Android 11+ 要求签名证书在 2033 年之后仍然有效，给足 30 年
        .not_valid_after(now + dt.timedelta(days=365 * years))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    blob = pkcs12.serialize_key_and_certificates(
        name=FRIENDLY_NAME.encode(),
        key=key,
        cert=cert,
        cas=None,
        encryption_algorithm=serialization.BestAvailableEncryption(
            STORE_PASSWORD.encode()),
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(blob)
    return cert_fingerprint(cert)


def main():
    ap = argparse.ArgumentParser(description='生成固定 APK 签名密钥')
    ap.add_argument('--out', default=str(DEFAULT_OUT), help='输出 p12 路径')
    ap.add_argument('--years', type=int, default=30, help='证书有效期（默认 30 年）')
    ap.add_argument('--fingerprint', action='store_true', help='只打印现有密钥指纹')
    ap.add_argument('--force', action='store_true', help='已存在时覆盖（会换签名！）')
    args = ap.parse_args()

    out = Path(args.out)

    if args.fingerprint:
        if not out.exists():
            raise SystemExit('没有 %s，先不带 --fingerprint 跑一次' % out)
        fp = load_fingerprint(out)
        print('密钥    : %s' % out)
        print('alias   : %s' % ALIAS)
        print('指纹    : %s' % fp)
        return 0

    if out.exists() and not args.force:
        raise SystemExit(
            '已存在 %s —— 不覆盖。\n'
            '换密钥意味着签名变化，手机上必须卸载重装才能装新版；\n'
            '确实要换再加 --force，并记得同步更新仓库变量。' % out)

    fp = generate(out, args.years)

    FINGERPRINT_FILE.parent.mkdir(parents=True, exist_ok=True)
    FINGERPRINT_FILE.write_text(
        '# APK 签名证书指纹（SHA-256），由 build/make_signing_key.py 生成。\n'
        '# 构建后由 build/check_apk_signer.py 拿它比对，确保每个包的签名都一样。\n'
        '# 只有指纹，没有私钥 —— 可以公开。\n'
        '%s\n' % fp,
        encoding='utf-8')

    print('已生成 %s（私钥，别提交）' % out)
    print('alias   : %s' % ALIAS)
    print('store/key 口令 : %s / %s' % (STORE_PASSWORD, KEY_PASSWORD))
    print('证书指纹 : %s' % fp)
    print('指纹已写入 %s' % FINGERPRINT_FILE)

    # 顺手把 base64 也打出来，方便直接贴进仓库变量
    b64 = base64.b64encode(out.read_bytes()).decode()
    print()
    print('下一步 —— 把它存成仓库变量 LW_DEBUG_KEYSTORE（base64 全文）：')
    print('  base64 -w0 %s' % out)
    print('  长度 %d 字符' % len(b64))
    return 0


if __name__ == '__main__':
    sys.exit(main())

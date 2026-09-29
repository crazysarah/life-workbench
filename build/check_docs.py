#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
README 双语文档自检。

仓库有两份 README，分头维护：
    README.md        英文（精简 Quick Start，GitHub 首页默认展示）
    README.zh-CN.md  中文（完整文档）

最大的风险是「只改了一份」。这个脚本盯住最基本的几条：

  1. 两份都在，各自只有一个 H1
  2. 两份都在开头给了互相跳转的语言链接（链接藏在文末不算数）
  3. 英文版不残留整段中文（连续 4 个以上汉字）—— 语言链接那一行除外
  4. 两份都保留了各自的必需章节
  5. 正文里点名的仓库文件真实存在（防止重构之后文档变成谎话）

用法：
    python3 build/check_docs.py
"""

import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

EN = 'README.md'
ZH = 'README.zh-CN.md'

# 语言链接必须出现在开头这几行内
LANG_LINK_MAX_LINE = 12

# 每份文档必须保留的章节关键词（防止误删/写空）
REQUIRED_EN = ['Architecture', 'Deploy the server', 'Build the APK',
               'Changing the server address', 'Troubleshooting', 'Full documentation']
REQUIRED_ZH = ['架构', '服务端部署', '构建 APK', '常见问题', '项目结构', '安全提醒']

# 生成物目录：文档里提到它们是对的，但它们不在仓库里，不该算「文件不存在」
GENERATED_PREFIXES = ('mobile/www/', 'mobile/android/', 'dist/')

# 扩展名必须按长度降序排，否则 `x.config.json` 会先被 `.js` 命中（回溯到 config.
# 时 `js` 已能匹配 json 开头两字），截出一个根本不存在的 `x.config.js`。
# 末尾的 (?![A-Za-z0-9]) 是第二道保险。
PATH_RE = re.compile(
    r'(?<![\w/.-])'
    r'((?:build|server|client|deploy|mobile|\.github)/'
    r'[A-Za-z0-9_][A-Za-z0-9_./-]*\.'
    r'(?:webmanifest|json|yaml|yml|html|svg|py|js|sh|md))'
    r'(?![A-Za-z0-9])'
)

# 连续 4 个以上汉字 = 一段中文正文（「中文 / EN」这种两字 UI 字样不算）
CJK_RUN_RE = re.compile(u'[\u4e00-\u9fff]{4,}')

H1_RE = re.compile(r'^#[ \t]+\S', re.M)


def read(path):
    with io.open(path, encoding='utf-8') as f:
        return f.read()


class Report(object):
    def __init__(self):
        self.fails = []
        self.checks = 0

    def check(self, name, ok, detail=''):
        self.checks += 1
        if ok:
            print('[docs]   OK   %s' % name)
        else:
            print('[docs]   FAIL %s%s' % (name, ('  —— ' + detail) if detail else ''))
            self.fails.append(name)


def without_lang_lines(text):
    """去掉语言切换相关的行，避免「简体中文」这四个字被当成未翻译的正文。"""
    keep = []
    for line in text.split('\n'):
        if 'README.zh-CN.md' in line or u'简体中文' in line:
            continue
        keep.append(line)
    return '\n'.join(keep)


def without_code_blocks(text):
    """把围栏代码块内容清空（保留行数）。

    代码块里的 shell 注释本来就以 `#` 开头，不排除的话会被当成 H1 标题 ——
    中文版里就有十几条 `# 服务器上：…`，一数就是十几个 H1。
    """
    out = []
    inside = False
    for line in text.split('\n'):
        if line.lstrip().startswith('```'):
            inside = not inside
            out.append('')
            continue
        out.append('' if inside else line)
    return '\n'.join(out)


def head_lines(text, n):
    return text.split('\n')[:n]


def has_lang_link(lines, link, lang_token):
    """开头是否有一行「语言切换链接」。

    不能只找文件名：正文里本来就会提到另一份文档（「完整文档见 README.zh-CN.md」），
    把语言切换那一行删掉也照样能搜到文件名。这里要求同一行里既有链接、又有语言名。
    """
    for line in lines:
        if link in line and lang_token in line:
            return True
    return False


def referenced_paths(text):
    found = []
    for m in PATH_RE.finditer(text):
        p = m.group(1)
        if p.startswith(GENERATED_PREFIXES):
            continue
        if p not in found:
            found.append(p)
    return found


def main():
    r = Report()
    files = {EN: os.path.join(REPO, EN), ZH: os.path.join(REPO, ZH)}

    # ---- 1. 两份都在 ----
    missing = [n for n, p in files.items() if not os.path.isfile(p)]
    r.check('两份 README 都存在', not missing,
            '找不到：%s' % ', '.join(missing) if missing else '')
    if missing:
        print()
        print('[docs][FAIL] 缺少文档，后面的检查无法进行')
        sys.exit(1)

    text = {n: read(p) for n, p in files.items()}
    for n in (EN, ZH):
        print('[docs] %s：%d 行 / %d 字符' % (n, text[n].count('\n') + 1, len(text[n])))

    # ---- 2. 各自只有一个 H1 ----
    for n in (EN, ZH):
        h1 = H1_RE.findall(without_code_blocks(text[n]))
        r.check('%s 只有一个 H1 标题' % n, len(h1) == 1, '实际 %d 个' % len(h1))

    # ---- 3. 开头的语言互链 ----
    head_en = head_lines(text[EN], LANG_LINK_MAX_LINE)
    head_zh = head_lines(text[ZH], LANG_LINK_MAX_LINE)
    r.check('README.md 开头有中文版切换链接',
            has_lang_link(head_en, 'README.zh-CN.md', u'简体中文'))
    r.check('README.zh-CN.md 开头有英文版切换链接',
            has_lang_link(head_zh, '(README.md)', 'English'))
    r.check('README.zh-CN.md 里英文版链接说的是「精简版」而非等价全文',
            u'精简' in '\n'.join(head_zh))

    # ---- 4. 英文版不残留整段中文 ----
    runs = CJK_RUN_RE.findall(without_lang_lines(text[EN]))
    r.check('英文版没有残留的中文正文', not runs,
            '命中：%s' % '、'.join(runs[:5]) if runs else '')

    # ---- 5. 必需章节 ----
    for n, need in ((EN, REQUIRED_EN), (ZH, REQUIRED_ZH)):
        gone = [k for k in need if k not in text[n]]
        r.check('%s 必需章节齐全' % n, not gone,
                '缺失：%s' % ', '.join(gone) if gone else '')

    # ---- 6. 正文点名的仓库文件真实存在 ----
    for n in (EN, ZH):
        refs = referenced_paths(text[n])
        absent = [p for p in refs if not os.path.exists(os.path.join(REPO, p))]
        print('[docs] %s 正文引用仓库文件 %d 个' % (n, len(refs)))
        r.check('%s 引用的文件都存在' % n, not absent,
                '不存在：%s' % ', '.join(absent) if absent else '')

    print()
    print('[docs] 共 %d 项检查' % r.checks)
    if r.fails:
        for f in r.fails:
            print('[docs][FAIL] %s' % f)
        sys.exit(1)
    print('[docs] 全部通过')


if __name__ == '__main__':
    main()

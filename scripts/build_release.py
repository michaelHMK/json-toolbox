#!/usr/bin/env python3
"""检查并打包 Chrome Web Store 发布文件，仅使用 Python 标准库。"""

import argparse
import hashlib
import json
from pathlib import Path
import posixpath
import re
import struct
import zipfile


PROJECT_ROOT = Path(__file__).resolve().parents[1]
ROOT = PROJECT_ROOT / 'src'
RUNTIME_FILES = (
    'manifest.json', 'background.js', 'styles/app.css',
    'styles/themes.css', 'styles/base.css', 'styles/layout.css',
    'styles/components/navigation.css', 'styles/components/theme-picker.css',
    'styles/components/controls.css', 'styles/components/editor.css',
    'styles/components/tree.css', 'styles/components/text-view.css',
    'styles/pages/formatter.css', 'styles/pages/compare.css',
    'formatter.html', 'compare.html', 'minify.html', 'escape.html', 'unescape.html',
    'pages/formatter.js', 'pages/compare.js', 'pages/transform.js',
    'shared/page.js', 'shared/navigation.js', 'shared/i18n.js', 'shared/theme.js',
    'shared/worker-client.js', 'shared/worker-protocol.js', 'shared/feedback.js',
    'shared/session-guard.js', 'shared/document-session.js', 'shared/comparison-session.js',
    'shared/file-import.js', 'shared/text-input.js',
    'shared/large-input-editor.js', 'vendor/codemirror.js', 'vendor/codemirror.LICENSE.txt',
    'shared/clipboard.js',
    'shared/virtual-tree.js', 'shared/remote-tree.js', 'shared/virtual-text.js',
    'worker/index.js', 'worker/tasks.js', 'worker/tree-tasks.js',
    'core/json.js', 'core/json-path.js', 'core/parse-error.js', 'core/preview.js',
    'core/tree-model.js', 'core/escape.js', 'core/search.js',
    'core/structural-diff.js', 'core/text-diff.js', 'core/text-lines.js',
)

FORBIDDEN_MANIFEST_KEYS = (
    'permissions', 'optional_permissions', 'host_permissions',
    'optional_host_permissions', 'content_scripts',
    'web_accessible_resources', 'externally_connectable',
)
REQUIRED_EXACT_CSP = {
    'default-src': {"'none'"},
    'script-src': {"'self'"},
    'worker-src': {"'self'"},
    'img-src': {"'self'"},
    'font-src': {"'self'"},
    'connect-src': {"'none'"},
    'object-src': {"'none'"},
    'base-uri': {"'none'"},
    'form-action': {"'none'"},
    'frame-src': {"'none'"},
    'frame-ancestors': {"'none'"},
}
JS_TOKEN_RE = re.compile(
    r'"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'|`(?:\\.|[^`\\])*`|/\*[\s\S]*?\*/|//[^\n]*'
)


def strip_js_comments(source):
    def replace(match):
        token = match.group(0)
        if token.startswith('//') or token.startswith('/*'):
            return '\n' * token.count('\n')
        return token
    return JS_TOKEN_RE.sub(replace, source)


def check_manifest_security(manifest):
    for key in FORBIDDEN_MANIFEST_KEYS:
        if manifest.get(key):
            raise ValueError(f'隐私门禁拒绝 manifest 字段: {key}')
    csp = manifest.get('content_security_policy', {}).get('extension_pages', '')
    if not isinstance(csp, str) or not csp.strip():
        raise ValueError('manifest.json 缺少 content_security_policy.extension_pages')
    directives = {}
    for raw in csp.split(';'):
        parts = raw.strip().split()
        if not parts:
            continue
        name = parts[0].lower()
        values = set(parts[1:])
        if name in directives:
            raise ValueError(f'CSP 存在重复指令: {name}')
        directives[name] = values
    for directive, expected in REQUIRED_EXACT_CSP.items():
        if directives.get(directive) != expected:
            raise ValueError(f'CSP 指令 {directive} 必须为 {" ".join(sorted(expected))}')
    style_src = directives.get('style-src', set())
    if "'self'" not in style_src or not style_src.issubset({"'self'", "'unsafe-inline'"}):
        raise ValueError("CSP 指令 style-src 仅允许 'self' 与必要的 'unsafe-inline'")
    for directive, values in directives.items():
        for value in values:
            lower = value.lower()
            if lower in ("'unsafe-eval'", "'wasm-unsafe-eval'", '*') or lower.startswith(('http:', 'https:', 'data:', 'blob:')):
                raise ValueError(f'CSP 指令 {directive} 包含禁止来源: {value}')


def check_reference(name, ref, files):
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), ref))
    if resolved not in files:
        raise ValueError(f'{name} 引用了未打包的文件: {ref}')


def check_css_references(name, source, files):
    # 项目只使用静态本地路径；每条引用相对于所在样式表，而不是 HTML 入口。
    source = re.sub(r'/\*.*?\*/', '', source, flags=re.DOTALL)
    imports = re.findall(r'@import\s+[\"\']([^\"\']+)[\"\']', source, flags=re.IGNORECASE)
    urls = re.findall(
        r'\burl\(\s*(?:"([^"]+)"|\'([^\']+)\'|([^\s)]+))\s*\)',
        source, flags=re.IGNORECASE,
    )
    for ref in imports + [next(value for value in groups if value) for groups in urls]:
        check_reference(name, ref, files)


def check_html_security(name, source):
    for attrs, body in re.findall(r'<script\b([^>]*)>([\s\S]*?)</script>', source, flags=re.IGNORECASE):
        if not re.search(r'\bsrc\s*=', attrs, flags=re.IGNORECASE) or body.strip():
            raise ValueError(f'{name} 禁止包含内联 <script>')
    if re.search(r'\bon[a-z]+\s*=', source, flags=re.IGNORECASE):
        raise ValueError(f'{name} 禁止包含内联事件属性')
    theme_pos = source.find('<script src="shared/theme.js"></script>')
    css_pos = source.find('<link rel="stylesheet" href="styles/app.css">')
    if theme_pos < 0 or css_pos < 0 or theme_pos > css_pos:
        raise ValueError(f'{name} 必须在 styles/app.css 之前同步加载 shared/theme.js')


def release_file(name):
    if (not isinstance(name, str) or '\\' in name or ':' in name
            or any(part in ('', '.', '..') for part in name.split('/'))):
        raise ValueError(f'发布文件必须使用包内相对路径: {name}')
    path = ROOT.resolve() / name
    if path.resolve() != path or not path.is_file():
        raise ValueError(f'发布文件缺失或为符号链接: {name}')
    return path


def check_release():
    manifest_raw = release_file('manifest.json').read_text(encoding='utf-8')
    manifest = json.loads(manifest_raw)
    if manifest.get('manifest_version') != 3:
        raise ValueError('发布包必须使用 Manifest V3')
    check_manifest_security(manifest)
    version = manifest['version']
    if not re.fullmatch(r'(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){0,3}', version):
        raise ValueError('version 必须是 1–4 段不含前导零的整数')
    numbers = [int(part) for part in version.split('.')]
    if not any(numbers) or any(part > 65535 for part in numbers):
        raise ValueError('version 分段必须在 0–65535 之间，且不能全部为零')

    files = set(RUNTIME_FILES)
    catalogs = {}
    for path in sorted((ROOT / '_locales').glob('*/messages.json')):
        name = path.relative_to(ROOT).as_posix()
        catalogs[path.parent.name] = json.loads(release_file(name).read_text(encoding='utf-8'))
        files.add(name)
    default = catalogs[manifest['default_locale']]
    for locale, catalog in catalogs.items():
        if catalog.keys() != default.keys():
            raise ValueError(f'{locale}: 翻译键与默认语言不一致')
        for key, message in catalog.items():
            if not isinstance(message.get('message'), str):
                raise ValueError(f'{locale}: {key} 缺少翻译文本')
        for field, limit in [('name', 75), ('description', 132)]:
            value = manifest[field]
            match = re.fullmatch(r'__MSG_(\w+)__', value)
            if match:
                value = catalog[match[1]]['message']
            if not 1 <= len(value) <= limit:
                raise ValueError(f'{locale}: {field} 长度为 {len(value)}，上限 {limit}')
        print(f'✓ {locale}: 名称、简介和 {len(catalog)} 个翻译键检查通过')

    for icons in (manifest['icons'], manifest.get('action', {}).get('default_icon', {})):
        for size, name in icons.items():
            data = release_file(name).read_bytes()
            if data[:8] != b'\x89PNG\r\n\x1a\n' or struct.unpack('>II', data[16:24]) != (int(size), int(size)):
                raise ValueError(f'{name}: PNG 尺寸不匹配')
            files.add(name)

    if manifest['background']['service_worker'] not in files:
        raise ValueError('发布清单未包含 Service Worker')

    used_i18n_keys = set(re.findall(r'__MSG_(\w+)__', manifest_raw))
    for name in sorted(files):
        path = release_file(name)
        if path.suffix == '.html':
            source = path.read_text(encoding='utf-8')
            check_html_security(name, source)
            for ref in re.findall(r'(?:src|href)=[\"\']([^\"\']+)', source):
                check_reference(name, ref, files)
            for key in re.findall(r'data-i18n(?:-title|-placeholder|-aria-label)?=[\"\']([^\"\']+)', source):
                if key not in default:
                    raise ValueError(f'{name} 引用了缺失的翻译: {key}')
                used_i18n_keys.add(key)
        elif path.suffix == '.js':
            raw_source = path.read_text(encoding='utf-8')
            source = strip_js_comments(raw_source)
            # 验证静态 ES module 导入、字面量动态 import() 及 new URL(..., import.meta.url)。
            static_imports = re.findall(
                r'\b(?:import|export)\s+(?:[^;]*?\s+from\s+)?[\"\']([^\"\']+)[\"\']',
                source,
            )
            dynamic_imports = re.findall(
                r'\bimport\(\s*[\"\']([^\"\']+)[\"\']\s*\)',
                source,
            )
            urls = re.findall(
                r'new\s+URL\(\s*[\"\']([^\"\']+)[\"\']\s*,\s*import\.meta\.url\s*\)',
                source,
            )
            for ref in static_imports + dynamic_imports + urls:
                check_reference(name, ref, files)
            if not name.startswith('vendor/'):
                for token in re.findall(r'[\"\']([A-Za-z][A-Za-z0-9_]*)[\"\']', source):
                    if token in default:
                        used_i18n_keys.add(token)
        elif path.suffix == '.css':
            check_css_references(name, path.read_text(encoding='utf-8'), files)

    # 阻断未纳入白名单的孤立运行时文件滞留在 src/。
    root_resolved = ROOT.resolve()
    for disk_path in sorted(root_resolved.rglob('*')):
        if not disk_path.is_file():
            continue
        rel = disk_path.relative_to(root_resolved).as_posix()
        if rel.startswith(('_locales/', 'icons/')):
            continue
        if rel not in files:
            raise ValueError(f'发现未登记到 RUNTIME_FILES 的孤立文件: {rel}')

    unused_keys = sorted(set(default.keys()) - used_i18n_keys)
    if unused_keys:
        raise ValueError(f'存在未使用的翻译键: {", ".join(unused_keys)}')

    print(f'✓ Manifest、图标与 {len(files)} 个发布文件检查通过')
    return version, sorted(files)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='仅检查，不生成 ZIP')
    args = parser.parse_args()
    try:
        version, files = check_release()
        if args.check:
            return
        output = PROJECT_ROOT / 'dist' / f'json-toolbox-{version}.zip'
        output.parent.mkdir(exist_ok=True)
        # 固定元数据；相同源文件可重现相同 ZIP 和校验值。
        with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for name in files:
                info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                archive.writestr(info, release_file(name).read_bytes())
        with zipfile.ZipFile(output) as archive:
            if archive.testzip() is not None:
                raise ValueError('ZIP 完整性校验失败')
        checksum = hashlib.sha256(output.read_bytes()).hexdigest()
        output.with_suffix('.zip.sha256').write_text(f'{checksum}  {output.name}\n', encoding='utf-8')
        print(f'✓ {output} ({output.stat().st_size:,} bytes)\nSHA-256: {checksum}')
    except (ValueError, KeyError, OSError, struct.error) as error:
        parser.exit(1, f'发布检查失败: {error}\n')


if __name__ == '__main__':
    main()

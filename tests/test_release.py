import contextlib
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import call, patch
import zipfile

from scripts import build_release, upload_release


class ReleaseTests(unittest.TestCase):
    def check(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return build_release.check_release()

    def test_all_runtime_dependencies_are_packaged_without_dev_files(self):
        _, files = self.check()
        self.assertIn('worker/index.js', files)
        self.assertIn('core/json.js', files)
        self.assertNotIn('package.json', files)
        self.assertFalse(any(name.startswith('tests/') for name in files))

    def test_archive_is_loadable_from_its_root_and_written_to_project_dist(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            root = project / 'src'
            shutil.copytree(build_release.ROOT, root)
            manifest_path = root / 'manifest.json'
            manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
            manifest['action']['default_icon']['16'] = 'icons/action16.png'
            manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
            shutil.copyfile(root / 'icons/icon16.png', root / 'icons/action16.png')
            with patch.object(build_release, 'PROJECT_ROOT', project), \
                    patch.object(build_release, 'ROOT', root), \
                    patch('sys.argv', ['build_release.py']), \
                    contextlib.redirect_stdout(io.StringIO()):
                build_release.main()

            archive_path, = (project / 'dist').glob('*.zip')
            self.assertTrue(archive_path.with_suffix('.zip.sha256').is_file())
            with zipfile.ZipFile(archive_path) as archive:
                names = archive.namelist()
                self.assertIn('manifest.json', names)
                self.assertIn('worker/index.js', names)
                self.assertIn('formatter.html', names)
                self.assertFalse(any(name.startswith(('src/', 'scripts/', 'tests/', 'bench/')) for name in names))
                self.assertEqual(archive.read('manifest.json'), manifest_path.read_bytes())
                for name in ['icons/icon16.png', 'icons/action16.png']:
                    self.assertEqual(archive.read(name), (root / name).read_bytes())

    def test_icon_must_be_a_regular_file_inside_the_extension(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'src'
            shutil.copytree(build_release.ROOT, root)
            outside = Path(directory) / 'external-icons'
            outside.mkdir()
            shutil.copyfile(root / 'icons/icon16.png', outside / 'icon16.png')
            (root / 'linked-icons').symlink_to(outside, target_is_directory=True)
            manifest_path = root / 'manifest.json'
            manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
            for name in ['../external-icons/icon16.png', str(outside / 'icon16.png'), 'linked-icons/icon16.png']:
                with self.subTest(name=name), patch.object(build_release, 'ROOT', root):
                    manifest['icons']['16'] = name
                    manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
                    with self.assertRaisesRegex(ValueError, '包内相对路径|符号链接'):
                        self.check()

    def test_upload_preserves_existing_assets_and_fills_gaps(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'package.zip'
            checksum = Path(directory) / 'package.zip.sha256'
            archive.write_bytes(b'zip')
            checksum.write_bytes(b'checksum')
            assets = [{'name': path.name, 'state': 'uploaded',
                       'digest': 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest()}
                      for path in (archive, checksum)]
            for existing, missing in [([], [archive, checksum]), (assets, []),
                                      (assets[:1], [checksum]), (assets[1:], [archive])]:
                with self.subTest(existing=existing), \
                        patch('subprocess.check_output', return_value=json.dumps([existing])), \
                        patch('subprocess.run') as upload, contextlib.redirect_stdout(io.StringIO()):
                    upload_release.upload_release('owner/repo', 1, 'v1', [archive, checksum])
                    if missing:
                        upload.assert_called_once_with(
                            ['gh', 'release', 'upload', '--repo', 'owner/repo', '--', 'v1', *missing], check=True)
                    else:
                        upload.assert_not_called()

            # A missing ZIP must not be uploaded alongside a conflicting legacy checksum.
            legacy = {'name': checksum.name, 'id': 7, 'state': 'uploaded'}
            with patch('subprocess.check_output', side_effect=[json.dumps([[legacy]]), b'old']), \
                    patch('subprocess.run') as upload, self.assertRaisesRegex(ValueError, checksum.name):
                upload_release.upload_release('owner/repo', 1, 'v1', [archive, checksum])
            upload.assert_not_called()

    def test_retry_recovers_a_failed_upload_without_deleting_other_uploads(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'package.zip'
            archive.write_bytes(b'zip')
            args = ('owner/repo', 1, 'v1', [archive])
            upload = ['gh', 'release', 'upload', '--repo', 'owner/repo', '--', 'v1', archive]
            failed = subprocess.CalledProcessError(1, upload, stderr='HTTP 502')
            with patch('subprocess.check_output', return_value='[[]]'), \
                    patch('subprocess.run', side_effect=failed), self.assertRaises(subprocess.CalledProcessError):
                upload_release.upload_release(*args)

            starter = {'id': 8, 'name': archive.name, 'state': 'starter', 'size': 0,
                       'uploader': {'login': 'github-actions[bot]'}}
            listed = json.dumps([[starter]])
            for digest in [None, 'sha256:' + hashlib.sha256(b'').hexdigest()]:
                empty = {**starter, 'digest': digest}
                with self.subTest(digest=digest), \
                        patch('subprocess.check_output', side_effect=[json.dumps([[empty]]), json.dumps(empty)]), \
                        patch('subprocess.run') as mutate:
                    upload_release.upload_release(*args)
                self.assertEqual(mutate.call_args_list, [
                    call(['gh', 'api', '--method', 'DELETE', 'repos/owner/repo/releases/assets/8'], check=True),
                    call(upload, check=True),
                ])

            for change in [{'state': 'uploaded'}, {'name': 'renamed'}, {'size': 42},
                           {'digest': 'sha256:' + hashlib.sha256(b'data').hexdigest()},
                           {'uploader': None}, {'uploader': {'login': 'maintainer'}}]:
                with self.subTest(change=change), \
                        patch('subprocess.check_output', side_effect=[listed, json.dumps({**starter, **change})]), \
                        patch('subprocess.run') as mutate, self.assertRaises(ValueError):
                    upload_release.upload_release(*args)
                mutate.assert_not_called()

    def test_omitted_import_and_worker_entry_are_rejected(self):
        for omitted in ['core/json.js', 'worker/index.js', 'shared/large-input-editor.js', 'vendor/yaml.js']:
            with self.subTest(omitted=omitted):
                files = tuple(name for name in build_release.RUNTIME_FILES if name != omitted)
                with patch.object(build_release, 'RUNTIME_FILES', files):
                    with self.assertRaisesRegex(ValueError, '引用了未打包的文件'):
                        self.check()

    def test_manifest_security_invariants_reject_permissions_and_weak_csp(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'src'
            shutil.copytree(build_release.ROOT, root)
            manifest_path = root / 'manifest.json'
            baseline = json.loads(manifest_path.read_text(encoding='utf-8'))
            # Allowlisted permissions and optional_host_permissions must pass.
            with patch.object(build_release, 'ROOT', root):
                manifest_path.write_text(json.dumps({
                    **baseline,
                    'permissions': ['contextMenus', 'activeTab', 'scripting', 'storage'],
                    'optional_host_permissions': ['http://*/*', 'https://*/*', 'file:///*'],
                    'web_accessible_resources': [{
                        'resources': ['viewer.html'],
                        'matches': ['http://*/*', 'https://*/*', 'file:///*'],
                        'use_dynamic_url': True,
                    }],
                }), encoding='utf-8')
                self.check()
            cases = [
                ({**baseline, 'permissions': ['tabs']}, '未授权的 permissions'),
                ({**baseline, 'permissions': ['storage', 'clipboardRead']}, '未授权的 permissions'),
                ({**baseline, 'host_permissions': ['<all_urls>']}, '隐私门禁'),
                ({**baseline, 'content_scripts': [{'matches': ['<all_urls>'], 'js': ['content/detect.js']}]}, '隐私门禁'),
                ({**baseline, 'optional_host_permissions': ['<all_urls>']}, '未授权的 optional_host_permissions'),
                ({**baseline, 'web_accessible_resources': [{'resources': ['viewer.html'], 'matches': ['http://*/*'], 'use_dynamic_url': False}]}, 'use_dynamic_url'),
                ({**baseline, 'web_accessible_resources': [{'resources': ['formatter.html'], 'matches': ['http://*/*'], 'use_dynamic_url': True}]}, 'web_accessible_resources 资源'),
                ({**baseline, 'web_accessible_resources': [{'resources': ['viewer.html'], 'matches': ['<all_urls>'], 'use_dynamic_url': True}]}, 'web_accessible_resources matches'),
                ({**baseline, 'content_security_policy': {'extension_pages': "script-src 'self'; object-src 'self'; connect-src 'none'"}}, 'default-src'),
                ({**baseline, 'content_security_policy': {'extension_pages': baseline['content_security_policy']['extension_pages'].replace("object-src 'none'", "object-src 'self'")}}, 'object-src'),
                ({**baseline, 'content_security_policy': {'extension_pages': baseline['content_security_policy']['extension_pages'].replace("frame-ancestors http: https: file:", "frame-ancestors *")}}, 'frame-ancestors'),
                ({**baseline, 'content_security_policy': {'extension_pages': baseline['content_security_policy']['extension_pages'].replace("style-src 'self' 'unsafe-inline'", "style-src 'self' https://evil.example")}}, 'style-src'),
            ]
            for mutated, pattern in cases:
                with self.subTest(pattern=pattern), patch.object(build_release, 'ROOT', root):
                    manifest_path.write_text(json.dumps(mutated), encoding='utf-8')
                    with self.assertRaisesRegex(ValueError, pattern):
                        self.check()

    def test_orphan_files_inline_html_and_unused_i18n_keys_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'src'
            shutil.copytree(build_release.ROOT, root)
            orphan = root / 'shared/orphan.js'
            orphan.write_text('export const x = 1;\n', encoding='utf-8')
            with patch.object(build_release, 'ROOT', root):
                with self.assertRaisesRegex(ValueError, '孤立文件'):
                    self.check()
            orphan.unlink()

            html = root / 'formatter.html'
            original_html = html.read_text(encoding='utf-8')
            html.write_text(original_html.replace('</body>', '<script>alert(1)</script></body>'), encoding='utf-8')
            with patch.object(build_release, 'ROOT', root):
                with self.assertRaisesRegex(ValueError, '内联 <script>'):
                    self.check()
            html.write_text(original_html.replace('<body ', '<body onclick="x()" '), encoding='utf-8')
            with patch.object(build_release, 'ROOT', root):
                with self.assertRaisesRegex(ValueError, '内联事件'):
                    self.check()
            html.write_text(original_html, encoding='utf-8')

            for path in (root / '_locales').glob('*/messages.json'):
                data = json.loads(path.read_text(encoding='utf-8'))
                data['unusedTestKey'] = {'message': 'unused'}
                path.write_text(json.dumps(data), encoding='utf-8')
            with patch.object(build_release, 'ROOT', root):
                with self.assertRaisesRegex(ValueError, '未使用的翻译键.*unusedTestKey'):
                    self.check()

    def test_nested_relative_reference_is_resolved_from_importer(self):
        build_release.check_reference('shared/worker-client.js', '../worker/index.js', {'worker/index.js'})
        with self.assertRaises(ValueError):
            build_release.check_reference('shared/worker-client.js', './worker/index.js', {'worker/index.js'})

    def test_omitted_indirect_stylesheet_is_rejected(self):
        files = tuple(name for name in build_release.RUNTIME_FILES if name != 'styles/components/tree.css')
        with patch.object(build_release, 'RUNTIME_FILES', files):
            with self.assertRaisesRegex(ValueError, r'styles/app\.css 引用了未打包的文件: .*components/tree\.css'):
                self.check()

    def test_nested_css_imports_and_resources_are_resolved_from_stylesheet(self):
        original_read = Path.read_text
        references = '''
            /* @import "missing.css"; .unused { background: url(missing.png); } */
            @import "../themes.css";
            @import url('../pages/formatter.css') screen;
            @import url(../base.css);
            .fixture { background-image: url("../../icons/icon16.png"); }
        '''

        def read_text(path, *args, **kwargs):
            source = original_read(path, *args, **kwargs)
            if path.relative_to(build_release.ROOT).as_posix() == 'styles/components/tree.css':
                source += references
            return source

        with patch.object(Path, 'read_text', read_text):
            self.check()
            for missing in ['@import "../missing.css";', '.fixture { background: url(../../icons/missing.png); }']:
                with self.subTest(reference=missing):
                    references = missing
                    with self.assertRaisesRegex(ValueError, r'styles/components/tree\.css 引用了未打包的文件'):
                        self.check()

    def test_missing_accessible_label_translation_is_rejected(self):
        original_read = Path.read_text

        def read_text(path, *args, **kwargs):
            source = original_read(path, *args, **kwargs)
            if path.name == 'formatter.html':
                source += '<button data-i18n-aria-label="missingAccessibleLabel"></button>'
            return source

        with patch.object(Path, 'read_text', read_text):
            with self.assertRaisesRegex(ValueError, 'missingAccessibleLabel'):
                self.check()

    def test_missing_file_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, files = self.check()
            for name in files:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(build_release.ROOT / name, target)
            (root / 'core/search.js').unlink()
            with patch.object(build_release, 'ROOT', root):
                with self.assertRaisesRegex(ValueError, '发布文件缺失'):
                    self.check()

import contextlib
import io
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from scripts import build_release


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
            with patch.object(build_release, 'PROJECT_ROOT', project), \
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
                self.assertEqual(archive.read('manifest.json'), (build_release.ROOT / 'manifest.json').read_bytes())

    def test_omitted_import_and_worker_entry_are_rejected(self):
        for omitted in ['core/json.js', 'worker/index.js']:
            with self.subTest(omitted=omitted):
                files = tuple(name for name in build_release.RUNTIME_FILES if name != omitted)
                with patch.object(build_release, 'RUNTIME_FILES', files):
                    with self.assertRaisesRegex(ValueError, '引用了未打包的文件'):
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

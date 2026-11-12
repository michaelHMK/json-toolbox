import contextlib
import io
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import build_release


class ReleaseTests(unittest.TestCase):
    def check(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return build_release.check_release()

    def test_all_runtime_dependencies_are_packaged_without_dev_files(self):
        _, files = self.check()
        self.assertIn('src/worker/index.js', files)
        self.assertIn('src/core/json.js', files)
        self.assertNotIn('package.json', files)
        self.assertFalse(any(name.startswith('tests/') for name in files))

    def test_omitted_import_and_worker_entry_are_rejected(self):
        for omitted in ['src/core/json.js', 'src/worker/index.js']:
            with self.subTest(omitted=omitted):
                files = tuple(name for name in build_release.RUNTIME_FILES if name != omitted)
                with patch.object(build_release, 'RUNTIME_FILES', files):
                    with self.assertRaisesRegex(ValueError, '引用了未打包的文件'):
                        self.check()

    def test_nested_relative_reference_is_resolved_from_importer(self):
        build_release.check_reference('src/shared/worker-client.js', '../worker/index.js', {'src/worker/index.js'})
        with self.assertRaises(ValueError):
            build_release.check_reference('src/shared/worker-client.js', './worker/index.js', {'src/worker/index.js'})

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
            (root / 'src/core/search.js').unlink()
            with patch.object(build_release, 'ROOT', root):
                with self.assertRaisesRegex(ValueError, '发布文件缺失'):
                    self.check()

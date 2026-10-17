#!/usr/bin/env python3
"""生成器失败路径回归；仅操作独立临时目录。"""
import contextlib
import importlib.util
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "prepare_repo", Path(__file__).with_name("prepare-repo.py"))
prepare = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare)


class PrepareRepoTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="qq-prepare-test-")
        self.root = Path(self.temp.name).resolve()
        self.assertEqual(self.root.parent, Path(tempfile.gettempdir()).resolve())
        self.workspace = self.root / "workspace"
        self.app = self.workspace / "resources" / "app"
        (self.app / "src").mkdir(parents=True)
        (self.workspace / "tools").mkdir()
        self.output = self.workspace / "repo"
        self.output.mkdir()
        self.patches = patch.multiple(
            prepare, WS=str(self.workspace), APP=str(self.app),
            __file__=str(self.workspace / "tools" / "prepare-repo.py"))
        self.patches.start()

    def tearDown(self):
        self.patches.stop()
        self.temp.cleanup()

    def test_protected_readme_survives_later_validation_failure(self):
        template = "# Template\n"
        (self.workspace / "tools" / "repo-readme.md").write_text(
            template, encoding="utf-8")
        original = prepare.render_readme(template) + "\nManual changes\n"
        readme = self.output / "README.md"
        readme.write_text(original, encoding="utf-8")
        (self.app / "src" / "app.js").write_text(
            "const unsupportedVersion = true;\n", encoding="utf-8")
        with patch.object(sys, "argv", ["prepare-repo.py", str(self.output)]):
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(prepare.main(), 2)
        self.assertEqual(readme.read_text(encoding="utf-8"), original)

    def test_clean_only_owned_outputs(self):
        for name in ("AGENTS.md", "CODING_STANDARDS.md", "notes.md"):
            (self.output / name).write_text("preserve", encoding="utf-8")
        (self.output / ".git").mkdir()
        (self.output / "app").mkdir()
        (self.output / "app" / "old.js").write_text("old", encoding="utf-8")
        prepare.clean_generated_output(str(self.output))
        self.assertFalse((self.output / "app").exists())
        self.assertTrue((self.output / ".git").is_dir())
        for name in ("AGENTS.md", "CODING_STANDARDS.md", "notes.md"):
            self.assertEqual((self.output / name).read_text(encoding="utf-8"), "preserve")

    def test_reject_overlapping_source_and_runtime_data(self):
        for target in (self.workspace, self.root, self.app,
                       self.workspace / "tools" / "output"):
            with self.assertRaises(ValueError):
                prepare.validate_output_dir(str(target))
        (self.output / "app" / "data").mkdir(parents=True)
        marker = self.output / "app" / "data" / "keep.txt"
        marker.write_text("runtime", encoding="utf-8")
        with self.assertRaises(ValueError):
            prepare.clean_generated_output(str(self.output))
        self.assertEqual(marker.read_text(encoding="utf-8"), "runtime")

    def check_guard(self, template, generated):
        source = self.workspace / "tools" / "repo-readme.md"
        source.write_text(template, encoding="utf-8")
        (self.output / "README.md").write_text(generated, encoding="utf-8")
        with contextlib.redirect_stdout(io.StringIO()):
            return prepare.guard_generated_readme(str(self.output), str(source))[0]

    def test_unmodified_generated_body_can_advance_with_template(self):
        self.assertTrue(self.check_guard("# Updated\n", prepare.render_readme("# Old\n")))

    def test_hand_edit_is_protected_even_when_template_also_changes(self):
        self.assertFalse(self.check_guard(
            "# Updated template\n", prepare.render_readme("# Old\n") + "Manual changes\n"))

    def test_unknown_legacy_readme_is_preserved(self):
        self.assertFalse(self.check_guard("# Template\n", "# Handwritten legacy README\n"))


if __name__ == "__main__":
    unittest.main()

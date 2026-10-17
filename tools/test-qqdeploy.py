"""Isolated tests for qqdeploy's safety and failure-recovery paths."""

import contextlib
import importlib.util
import io
import json
import os
import pathlib
import stat
import sys
import tarfile
import tempfile
import types
import unittest
from unittest import mock


ROOT_DIR = pathlib.Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT_DIR / "tools" / "qqdeploy.py"

# qqdeploy only needs flock in its CLI path; provide an import shim on Windows.
if importlib.util.find_spec("fcntl") is None:
    sys.modules["fcntl"] = types.ModuleType("fcntl")
    sys.modules["fcntl"].LOCK_EX = 2
    sys.modules["fcntl"].LOCK_NB = 4
    sys.modules["fcntl"].flock = lambda *_args: None

spec = importlib.util.spec_from_file_location("qqdeploy_under_test", MODULE_PATH)
qqdeploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qqdeploy)


def make_release(root, sha):
    path = pathlib.Path(root) / sha
    (path / "app" / "src").mkdir(parents=True)
    (path / "app" / "src" / "app.js").write_text("// test\n", encoding="utf-8")
    return str(path)


class QQDeployTests(unittest.TestCase):
    def test_sh_has_a_stable_tuple_contract(self):
        completed = types.SimpleNamespace(returncode=7, stdout="out", stderr="err")
        with mock.patch.object(qqdeploy.subprocess, "run", return_value=completed):
            self.assertEqual((7, "out", "err"), qqdeploy.sh(["true"]))
        completed = types.SimpleNamespace(returncode=3)
        with mock.patch.object(qqdeploy.subprocess, "run", return_value=completed):
            self.assertEqual((3, "", ""), qqdeploy.sh(["true"], stream=True))

    def test_start_release_never_builds_or_pulls(self):
        with tempfile.TemporaryDirectory() as temp:
            releases = pathlib.Path(temp) / "releases"
            releases.mkdir()
            release = make_release(releases, "9" * 40)
            original_stat = os.stat

            def report_root_owner(path, *, follow_symlinks=True):
                real = original_stat(path, follow_symlinks=follow_symlinks)
                return types.SimpleNamespace(st_mode=real.st_mode, st_uid=0,
                                             st_nlink=real.st_nlink)

            with mock.patch.object(qqdeploy, "RELEASES", str(releases)), \
                 mock.patch.object(qqdeploy, "ENV_FILE", os.path.join(temp, "absent.env")), \
                 mock.patch.object(qqdeploy.os, "stat", side_effect=report_root_owner), \
                 mock.patch.object(qqdeploy, "sh", return_value=(0, "", "")) as run:
                self.assertTrue(qqdeploy.start_release(release, quiet=True))
        command = run.call_args.args[0]
        self.assertIn("--no-build", command)
        self.assertIn("--pull", command)
        self.assertIn("never", command)
        self.assertNotIn("build", command)

    def test_plugin_health_preserves_baseline_and_accepts_empty_first_install(self):
        status = {"onebot": {"connected": True}}
        broken_plugin = {
            "skills": [{"id": "known", "enabled": True,
                         "loaded": False, "active": False}],
            "summary": {"broken": 0},
        }
        with mock.patch.object(qqdeploy, "container_up", return_value=(True, "running")), \
             mock.patch.object(qqdeploy, "agent_api", side_effect=lambda path: (
                 status if path == "/api/status" else broken_plugin)):
            healthy, notes = qqdeploy.health_check(
                verbose=False,
                plugin_baseline={"enabled_ids": {"known"},
                                 "healthy_enabled_ids": {"known"}, "broken": 0})
        self.assertFalse(healthy)
        self.assertIn("未加载", next(reason for name, ok, reason in notes if name == "插件"))

        empty_plugins = {"skills": [], "summary": {"broken": 0}}
        with mock.patch.object(qqdeploy, "container_up", return_value=(True, "running")), \
             mock.patch.object(qqdeploy, "agent_api", side_effect=lambda path: (
                 status if path == "/api/status" else empty_plugins)):
            healthy, _ = qqdeploy.health_check(
                verbose=False,
                plugin_baseline={"enabled_ids": set(),
                                 "healthy_enabled_ids": set(), "broken": 0})
        self.assertTrue(healthy)

    def test_resolve_ref_accepts_full_sha_and_encodes_branch(self):
        full = "a" * 40
        self.assertEqual((full, full[:12]), qqdeploy.resolve_ref(full))
        with mock.patch.object(qqdeploy, "git_json", return_value={"sha": full}) as api:
            self.assertEqual((full, full[:12]), qqdeploy.resolve_ref("feature/ui"))
        self.assertIn("feature%2Fui", api.call_args.args[0])

    def test_resolve_ref_rejects_nonmatching_short_sha(self):
        with mock.patch.object(qqdeploy, "git_json", return_value={"sha": "b" * 40}):
            with self.assertRaises(SystemExit):
                qqdeploy.resolve_ref("a" * 12)

    def test_rollback_accepts_only_unique_release_sha(self):
        sha = "a" * 40
        with tempfile.TemporaryDirectory() as temp:
            old_releases = qqdeploy.RELEASES
            qqdeploy.RELEASES = temp
            try:
                release = pathlib.Path(temp) / sha
                release.mkdir()
                state = {"history": [{"sha": sha, "dir": str(release)}]}
                self.assertEqual((str(release), sha),
                                 qqdeploy.resolve_rollback_target(sha[:9], state))
                with self.assertRaises(SystemExit):
                    qqdeploy.resolve_rollback_target("../../etc/passwd", state)
            finally:
                qqdeploy.RELEASES = old_releases

    def test_compose_template_renders_safe_values_and_is_validated(self):
        sha = "e" * 40
        template_path = ROOT_DIR / "tools" / "qqdeploy-compose.template.yml"
        template = template_path.read_text(encoding="utf-8")
        with tempfile.TemporaryDirectory() as temp:
            releases = pathlib.Path(temp) / "releases"
            releases.mkdir()
            release = pathlib.Path(make_release(releases, sha))
            with mock.patch.multiple(qqdeploy, ROOT=temp, RELEASES=str(releases),
                                     TRUSTED_LIB="/usr/local/lib/qqdeploy",
                                     TRUSTED_COMPOSE_TEMPLATE="/usr/local/lib/qqdeploy/compose.template.yml",
                                     TRUSTED_DOCKERFILE="/usr/local/lib/qqdeploy/Dockerfile"), \
                 mock.patch.object(qqdeploy, "validate_release_tree", side_effect=lambda path: path), \
                 mock.patch.object(qqdeploy, "read_trusted_file", return_value=template), \
                 mock.patch.object(qqdeploy, "sh", return_value=(0, "", "")) as run:
                qqdeploy.write_release_compose(str(release), sha)
            rendered = (release / "compose.release.yml").read_text(encoding="utf-8")
            self.assertNotIn("__QQDEPLOY_", rendered)
            self.assertIn(json.dumps(str(release.resolve())), rendered)
            self.assertIn('"/usr/local/lib/qqdeploy/Dockerfile"', rendered)
            self.assertIn('"qq-agent:sha-' + sha + '"', rendered)
            command = run.call_args.args[0]
            self.assertEqual(["config", "--quiet"], command[-2:])
            try:
                import yaml
            except ImportError:
                yaml = None
            if yaml is not None:
                parsed = yaml.safe_load(rendered)
                self.assertEqual("qq-agent:sha-" + sha,
                                 parsed["services"]["qq-agent"]["image"])

    @unittest.skipIf(os.name == "nt", "POSIX ownership and permission checks")
    def test_trusted_file_rejects_group_or_world_writable_parent(self):
        with tempfile.TemporaryDirectory() as temp:
            trusted = pathlib.Path(temp) / "trusted"
            trusted.mkdir()
            checker = trusted / "check.py"
            checker.write_text("# trusted\n", encoding="utf-8")
            original_stat = os.stat
            insecure_parent = str(trusted)

            def simulated_stat(path, *, follow_symlinks=True):
                real = original_stat(path, follow_symlinks=follow_symlinks)
                permissions = 0o755 if stat.S_ISDIR(real.st_mode) else 0o644
                return types.SimpleNamespace(
                    st_mode=stat.S_IFMT(real.st_mode) | permissions, st_uid=0)

            with mock.patch.object(qqdeploy, "TRUSTED_LIB", str(trusted)), \
                 mock.patch.object(qqdeploy.os, "stat", side_effect=simulated_stat):
                self.assertEqual(str(checker), qqdeploy.validate_trusted_file(str(checker)))

                def writable_parent(path, *, follow_symlinks=True):
                    real = simulated_stat(path, follow_symlinks=follow_symlinks)
                    if os.path.abspath(path) == insecure_parent:
                        return types.SimpleNamespace(
                            st_mode=real.st_mode | 0o022, st_uid=0)
                    return real

                with mock.patch.object(qqdeploy.os, "stat", side_effect=writable_parent):
                    with self.assertRaisesRegex(SystemExit, "父目录必须由 root 拥有"):
                        qqdeploy.validate_trusted_file(str(checker))

    @unittest.skipIf(os.name == "nt", "POSIX ownership and permission checks")
    def test_deployment_root_rejects_group_writable_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp) / "qq"
            releases = root / "releases"
            releases.mkdir(parents=True)
            root.chmod(0o775)
            original_stat = os.stat

            def report_root_owner(path, *, follow_symlinks=True):
                real = original_stat(path, follow_symlinks=follow_symlinks)
                return types.SimpleNamespace(st_mode=real.st_mode, st_uid=0,
                                             st_nlink=real.st_nlink)

            changes = {"ROOT": str(root), "RELEASES": str(releases),
                       "STATE": str(root / ".deployed.json"),
                       "LOCK": str(root / ".deploy.lock"),
                       "ENV_FILE": str(root / ".env"),
                       "CURRENT": str(root / "current")}
            with mock.patch.multiple(qqdeploy, **changes), \
                 mock.patch.object(qqdeploy.os, "stat", side_effect=report_root_owner):
                with self.assertRaisesRegex(SystemExit, "不可被组/其他用户写入"):
                    qqdeploy.validate_deployment_paths()

    @unittest.skipIf(os.name == "nt", "POSIX ownership and permission checks")
    def test_release_tree_rejects_symlink_and_group_writable_source(self):
        with tempfile.TemporaryDirectory() as temp:
            releases = pathlib.Path(temp) / "releases"
            release = pathlib.Path(make_release(releases, "f" * 40))
            outside = pathlib.Path(temp) / "outside"
            outside.write_text("untouched", encoding="utf-8")
            link = release / "escape"
            try:
                link.symlink_to(outside)
            except OSError as exc:
                self.skipTest("symlink creation unavailable: %s" % exc)
            original_stat = os.stat

            def report_safe_owner(path, *, follow_symlinks=True):
                real = original_stat(path, follow_symlinks=follow_symlinks)
                if os.path.abspath(path) == str(link):
                    return types.SimpleNamespace(st_mode=stat.S_IFLNK | 0o777,
                                                 st_uid=0, st_nlink=1)
                permissions = 0o755 if stat.S_ISDIR(real.st_mode) else 0o644
                return types.SimpleNamespace(
                    st_mode=stat.S_IFMT(real.st_mode) | permissions,
                    st_uid=0, st_nlink=1)

            with mock.patch.object(qqdeploy, "RELEASES", str(releases)), \
                 mock.patch.object(qqdeploy.os, "stat", side_effect=report_safe_owner):
                with self.assertRaisesRegex(SystemExit, "符号链接"):
                    qqdeploy.validate_release_tree(str(release))
            link.unlink()
            source_file = release / "app" / "src" / "app.js"
            source_file.chmod(0o666)
            original_stat = os.stat

            def report_root_owner(path, *, follow_symlinks=True):
                real = original_stat(path, follow_symlinks=follow_symlinks)
                return types.SimpleNamespace(st_mode=real.st_mode, st_uid=0,
                                             st_nlink=real.st_nlink)

            with mock.patch.object(qqdeploy, "RELEASES", str(releases)), \
                 mock.patch.object(qqdeploy.os, "stat", side_effect=report_root_owner):
                with self.assertRaisesRegex(SystemExit, "不可被组/其他用户写入"):
                    qqdeploy.validate_release_tree(str(release))

    def test_compose_symlink_is_rejected_without_touching_its_target(self):
        sha = "1" * 40
        with tempfile.TemporaryDirectory() as temp:
            release_root = pathlib.Path(temp) / "releases"
            release_root.mkdir()
            release = pathlib.Path(make_release(release_root, sha))
            target = pathlib.Path(temp) / "outside.yml"
            target.write_text("preserve me", encoding="utf-8")
            compose_link = release / "compose.release.yml"
            try:
                compose_link.symlink_to(target)
            except OSError as exc:
                self.skipTest("symlink creation unavailable: %s" % exc)
            with mock.patch.object(qqdeploy, "RELEASES", str(release_root)), \
                 mock.patch.object(qqdeploy, "validate_release_tree", side_effect=lambda path: path), \
                 mock.patch.object(qqdeploy, "read_trusted_file", return_value="services: {}\n"):
                with self.assertRaisesRegex(SystemExit, "拒绝跟随链接"):
                    qqdeploy.write_release_compose(str(release), sha)
            self.assertEqual("preserve me", target.read_text(encoding="utf-8"))

    def test_download_rejects_symlink_members_before_publishing_release(self):
        sha = "c" * 40
        with tempfile.TemporaryDirectory() as temp:
            old_releases = qqdeploy.RELEASES
            qqdeploy.RELEASES = temp
            archive_bytes = io.BytesIO()
            with tarfile.open(fileobj=archive_bytes, mode="w:gz") as archive:
                top = tarfile.TarInfo("source-root")
                top.type = tarfile.DIRTYPE
                archive.addfile(top)
                filler = tarfile.TarInfo("source-root/filler.bin")
                filler.size = 130_000
                archive.addfile(filler, io.BytesIO(os.urandom(filler.size)))
                link = tarfile.TarInfo("source-root/escape")
                link.type = tarfile.SYMTYPE
                link.linkname = "../../outside"
                archive.addfile(link)
            payload = archive_bytes.getvalue()

            @contextlib.contextmanager
            def fake_response(*_args, **_kwargs):
                yield io.BytesIO(payload)

            try:
                with mock.patch.object(qqdeploy.urllib.request, "urlopen", fake_response):
                    with self.assertRaises(SystemExit):
                        qqdeploy.download(sha, os.path.join(temp, sha))
                self.assertFalse(os.path.lexists(os.path.join(temp, sha)))
            finally:
                qqdeploy.RELEASES = old_releases

    def _transition_layout(self, temp):
        root = pathlib.Path(temp)
        releases = root / "releases"
        releases.mkdir()
        old_sha, new_sha = "a" * 40, "b" * 40
        old_dir = make_release(releases, old_sha)
        new_dir = make_release(releases, new_sha)
        current = root / "current"
        current.symlink_to(old_dir, target_is_directory=True)
        changes = {
            "ROOT": str(root),
            "RELEASES": str(releases),
            "CURRENT": str(current),
            "STATE": str(root / "state.json"),
        }
        return changes, old_sha, old_dir, new_sha, new_dir, str(current)

    @unittest.skipIf(os.name == "nt", "POSIX symlink replacement is required")
    def test_commit_failure_restores_runtime_and_records_rollback(self):
        with tempfile.TemporaryDirectory() as temp:
            changes, old_sha, old_dir, new_sha, new_dir, current = self._transition_layout(temp)
            baseline = {"enabled_ids": set(), "healthy_enabled_ids": set(), "broken": 0}
            before = {"sha": old_sha, "dir": old_dir,
                      "image": "qq-agent:sha-" + old_sha}
            with mock.patch.multiple(qqdeploy, **changes), \
                 mock.patch.object(qqdeploy, "validate_deployment_paths"), \
                 mock.patch.object(qqdeploy, "write_release_compose"), \
                 mock.patch.object(qqdeploy, "build_release", return_value=True), \
                 mock.patch.object(qqdeploy, "start_release", return_value=True), \
                 mock.patch.object(qqdeploy, "wait_healthy", return_value=(True, [])), \
                 mock.patch.object(qqdeploy, "validate_release_tree", side_effect=lambda path: path), \
                 mock.patch.object(qqdeploy, "sh", return_value=(0, "sha256:old", "")), \
                 mock.patch.object(qqdeploy, "save_state", side_effect=SystemExit("commit failed")):
                with self.assertRaisesRegex(SystemExit, "commit failed"):
                    qqdeploy.run_transition("deploy", "main", new_sha, new_dir,
                                            before, baseline)
                self.assertEqual(old_dir, os.path.realpath(current))
                state = qqdeploy.load_state()
                self.assertEqual("rolled_back", state["operation"]["phase"])

    @unittest.skipIf(os.name == "nt", "POSIX symlink replacement is required")
    def test_keyboard_interrupt_after_switch_restores_runtime(self):
        with tempfile.TemporaryDirectory() as temp:
            changes, old_sha, old_dir, new_sha, new_dir, current = self._transition_layout(temp)
            baseline = {"enabled_ids": set(), "healthy_enabled_ids": set(), "broken": 0}
            before = {"sha": old_sha, "dir": old_dir,
                      "image": "qq-agent:sha-" + old_sha}
            with mock.patch.multiple(qqdeploy, **changes), \
                 mock.patch.object(qqdeploy, "validate_deployment_paths"), \
                 mock.patch.object(qqdeploy, "write_release_compose"), \
                 mock.patch.object(qqdeploy, "build_release", return_value=True), \
                 mock.patch.object(qqdeploy, "start_release", side_effect=[KeyboardInterrupt, True]), \
                 mock.patch.object(qqdeploy, "wait_healthy", return_value=(True, [])), \
                 mock.patch.object(qqdeploy, "validate_release_tree", side_effect=lambda path: path), \
                 mock.patch.object(qqdeploy, "sh", return_value=(0, "sha256:old", "")):
                with self.assertRaises(KeyboardInterrupt):
                    qqdeploy.run_transition("deploy", "main", new_sha, new_dir,
                                            before, baseline)
                self.assertEqual(old_dir, os.path.realpath(current))
                self.assertEqual("rolled_back", qqdeploy.load_state()["operation"]["phase"])

    @unittest.skipIf(os.name == "nt", "POSIX symlink replacement is required")
    def test_failed_rollback_is_persisted_as_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            changes, old_sha, old_dir, new_sha, new_dir, current = self._transition_layout(temp)
            baseline = {"enabled_ids": set(), "healthy_enabled_ids": set(), "broken": 0}
            before = {"sha": old_sha, "dir": old_dir,
                      "image": "qq-agent:sha-" + old_sha}
            with mock.patch.multiple(qqdeploy, **changes), \
                 mock.patch.object(qqdeploy, "validate_deployment_paths"), \
                 mock.patch.object(qqdeploy, "write_release_compose"), \
                 mock.patch.object(qqdeploy, "build_release", return_value=True), \
                 mock.patch.object(qqdeploy, "start_release", side_effect=[False, False]), \
                 mock.patch.object(qqdeploy, "wait_healthy", return_value=(True, [])), \
                 mock.patch.object(qqdeploy, "validate_release_tree", side_effect=lambda path: path), \
                 mock.patch.object(qqdeploy, "sh", return_value=(0, "sha256:old", "")):
                with self.assertRaisesRegex(SystemExit, "自动恢复失败"):
                    qqdeploy.run_transition("deploy", "main", new_sha, new_dir,
                                            before, baseline)
                state = qqdeploy.load_state()
                self.assertEqual("rollback_failed", state["operation"]["phase"])
                self.assertEqual(old_dir, os.path.realpath(current))

    def test_existing_untracked_container_blocks_formal_takeover(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            changes = {"ROOT": temp, "RELEASES": str(root / "releases"),
                       "CURRENT": str(root / "current"), "STATE": str(root / "state.json")}
            pathlib.Path(changes["RELEASES"]).mkdir()
            with mock.patch.multiple(qqdeploy, **changes), \
                 mock.patch.object(qqdeploy, "validate_deployment_paths"), \
                 mock.patch.object(qqdeploy, "container_up", return_value=(True, "running")), \
                 mock.patch.object(qqdeploy, "switch_current") as switch, \
                 mock.patch.object(qqdeploy, "start_release") as start:
                with self.assertRaisesRegex(SystemExit, "没有可信部署记录"):
                    qqdeploy.cmd_deploy("main")
                switch.assert_not_called()
                start.assert_not_called()

    def test_existing_untracked_container_allows_nonmutating_dry_run(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            changes = {"ROOT": temp, "RELEASES": str(root / "releases"),
                       "CURRENT": str(root / "current"), "STATE": str(root / "state.json")}
            pathlib.Path(changes["RELEASES"]).mkdir()
            sha = "d" * 40
            release = make_release(changes["RELEASES"], sha)
            with mock.patch.multiple(qqdeploy, **changes), \
                 mock.patch.object(qqdeploy, "validate_deployment_paths"), \
                 mock.patch.object(qqdeploy, "prepare_release", return_value=(sha, sha[:12], release)), \
                 mock.patch.object(qqdeploy, "write_release_compose"), \
                 mock.patch.object(qqdeploy, "rebuild", return_value=True), \
                 mock.patch.object(qqdeploy, "container_up", return_value=(True, "running")), \
                 mock.patch.object(qqdeploy, "switch_current") as switch, \
                 mock.patch.object(qqdeploy, "start_release") as start:
                self.assertEqual(0, qqdeploy.cmd_deploy("main", dry_run=True))
                switch.assert_not_called()
                start.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)

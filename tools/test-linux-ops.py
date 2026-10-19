#!/usr/bin/env python3
"""Isolated mock checks for Linux ops scripts; never calls a real Docker daemon."""

import ast
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
RETIRE = REPO / "tools" / "retire-legacy-compose.sh"
GUARD = REPO / "deploy" / "ops" / "napcat-guard.sh"
QR_SERVER = REPO / "deploy" / "ops" / "qr-server.py"
SANITIZER = REPO / "tools" / "ops-sanitize.py"
BASH = shutil.which("bash")


def linux_path(path):
    value = str(Path(path).resolve())
    match = re.match(r"^([A-Za-z]):\\(.*)$", value)
    if match:
        return "/mnt/%s/%s" % (match.group(1).lower(), match.group(2).replace("\\", "/"))
    return value.replace("\\", "/")


def run_bash(script, env, timeout=30):
    if not BASH:
        raise unittest.SkipTest("bash is required for Linux ops tests")
    return subprocess.run(
        [BASH, linux_path(script)], env=env, text=True,
        encoding="utf-8", errors="replace",
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout,
    )


def make_executable(path):
    result = subprocess.run(
        [BASH, "-c", "chmod +x -- " + shlex.quote(linux_path(path))],
        text=True, encoding="utf-8", errors="replace",
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if result.returncode:
        raise AssertionError("could not chmod mock: " + result.stderr)


class LinuxOpsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="qq-linux-ops-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "deploy"
        self.root.mkdir()
        self._make_deployed_fixture()

    def _make_deployed_fixture(self):
        release = self.root / "releases" / "abcdef012345"
        (release / "app" / "src").mkdir(parents=True)
        (release / "app" / "src" / "app.js").write_text("// mock\n", encoding="utf-8")
        self.root.joinpath("qq-agent-data").mkdir()
        self.root.joinpath("qq-agent-plugins").mkdir()
        (self.root / "qq-agent-data" / "config.json").write_text("{}\n", encoding="utf-8")
        (self.root / "napcat" / "config").mkdir(parents=True)
        (self.root / "napcat" / "QQ").mkdir(parents=True)

        root_linux = linux_path(self.root)
        release_linux = linux_path(release)
        self._run_linux(["ln", "-s", release_linux, root_linux + "/current"])
        state = {
            "current": {
                "sha": "abcdef012345",
                "dir": release_linux,
                "ref": "main",
                "at": "mock",
                "by": "test",
            },
            "previous": None,
            "history": [],
        }
        (self.root / ".deployed.json").write_text(
            json.dumps(state), encoding="utf-8"
        )

        napcat_inspect = [{
            "Name": "/napcat",
            "State": {"Running": True},
            "Config": {
                "Image": "mlikiowa/napcat-docker:mock",
                "Env": ["NAPCAT_UID=1234", "NAPCAT_GID=2345", "TZ=Asia/Shanghai"],
            },
            "HostConfig": {
                "RestartPolicy": {"Name": "always"},
                "ShmSize": 268435456,
            },
            "Mounts": [
                {"Type": "bind", "Source": root_linux + "/napcat/config",
                 "Destination": "/app/napcat/config", "RW": True},
                {"Type": "bind", "Source": root_linux + "/napcat/QQ",
                 "Destination": "/app/.config/QQ", "RW": True},
            ],
            "NetworkSettings": {
                "Networks": {"qq_qqnet": {"Aliases": ["napcat", "mock-alias"]}},
                "Ports": {
                    "3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "3000"}],
                    "6099/tcp": [{"HostIp": "127.0.0.1", "HostPort": "6099"}],
                },
            },
        }]
        qq_agent_inspect = [{
            "State": {"Running": True},
            "Config": {
                "Image": "qq-agent:local",
                "Labels": {
                    "com.docker.compose.service": "qq-agent",
                    "com.docker.compose.project": "qq",
                },
            },
            "Mounts": [
                {"Source": root_linux + "/qq-agent-data", "Destination": "/app/data"},
                {"Source": root_linux + "/qq-agent-plugins", "Destination": "/app/plugins"},
            ],
        }]
        (self.root / ".fixture-napcat.json").write_text(
            json.dumps(napcat_inspect), encoding="utf-8"
        )
        (self.root / ".fixture-qq-agent.json").write_text(
            json.dumps(qq_agent_inspect), encoding="utf-8"
        )
        (self.root / ".env").write_text("WEBUI_TOKEN=test-placeholder-only\n", encoding="utf-8")
        (self.root / "docker-compose.yml").write_text("old main compose\n", encoding="utf-8")
        (self.root / "docker-compose.platform.yml").write_text(
            "old platform compose\n", encoding="utf-8"
        )

    def _run_linux(self, args):
        if not BASH:
            self.skipTest("bash is required for Linux ops tests")
        command = " ".join("'" + arg.replace("'", "'\\''") + "'" for arg in args)
        result = subprocess.run(
            [BASH, "-c", command], text=True,
            encoding="utf-8", errors="replace",
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        if result.returncode:
            self.fail("Linux fixture command failed: " + result.stderr)

    def _install_fake_docker(self):
        fake = self.base / "bin" / "docker"
        fake.parent.mkdir(exist_ok=True)
        fake.write_text(
            """#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "inspect" ]]; then
  case "$2" in
    napcat|qq-agent) cat "$QQ_ROOT/.fixture-$2.json" ;;
    *) exit 4 ;;
  esac
  exit
fi
if [[ "$1" == "compose" ]]; then
  shift
  env_file=""
  compose_file=""
  while (( $# )); do
    case "$1" in
      --env-file) env_file="$2"; shift 2 ;;
      -f) compose_file="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  [[ -f "$env_file" && -f "$compose_file" ]] || exit 5
  grep -Eq '^WEBUI_TOKEN=[^[:space:]]+$' "$env_file" || exit 6
  grep -q 'container_name: napcat' "$compose_file" || exit 7
  grep -q 'WEBUI_TOKEN' "$compose_file" || exit 8
  exit 0
fi
exit 9
""",
            encoding="utf-8",
            newline="\n",
        )
        make_executable(fake)
        return fake

    def _retire_env(self, fake_docker, root=None):
        env = os.environ.copy()
        env.update({
            "QQ_OPS_TEST_MODE": "1",
            "QQ_ROOT": linux_path(root or self.root),
            "DOCKER_BIN": linux_path(fake_docker),
            "PATH": "/usr/bin:/bin",
        })
        return env

    def test_retire_preserves_live_settings_and_is_idempotent(self):
        fake = self._install_fake_docker()
        result = run_bash(RETIRE, self._retire_env(fake))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        compose = (self.root / "docker-compose.napcat.yml").read_text(encoding="utf-8")
        self.assertIn("NAPCAT_UID: \"1234\"", compose)
        self.assertIn("NAPCAT_GID: \"2345\"", compose)
        self.assertIn('name: \"qq_qqnet\"', compose)
        self.assertIn('source: \"' + linux_path(self.root) + '/napcat/QQ\"', compose)
        self.assertIn('host_ip: \"127.0.0.1\"', compose)
        self.assertFalse((self.root / "docker-compose.yml").exists())
        self.assertEqual(
            (self.root / "docker-compose.yml.legacy").read_text(encoding="utf-8"),
            "old main compose\n",
        )
        before = (self.root / "docker-compose.napcat.yml").stat().st_mtime_ns
        result = run_bash(RETIRE, self._retire_env(fake))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(
            (self.root / "docker-compose.napcat.yml").stat().st_mtime_ns, before
        )

    def test_retire_rejects_missing_webui_token_without_renaming(self):
        fake = self._install_fake_docker()
        (self.root / ".env").write_text("QQ_ACCOUNT=placeholder\n", encoding="utf-8")
        result = run_bash(RETIRE, self._retire_env(fake))
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.root / "docker-compose.yml").exists())
        self.assertFalse((self.root / "docker-compose.yml.legacy").exists())
        self.assertFalse((self.root / "docker-compose.napcat.yml").exists())
        self.assertFalse(list(self.root.glob(".docker-compose.napcat.yml.tmp.*")))

    def test_retire_refuses_archive_collision_without_changes(self):
        fake = self._install_fake_docker()
        (self.root / "docker-compose.yml.legacy").write_text(
            "preserve existing archive\n", encoding="utf-8"
        )
        result = run_bash(RETIRE, self._retire_env(fake))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("拒绝覆盖", result.stderr)
        self.assertTrue((self.root / "docker-compose.yml").exists())
        self.assertEqual(
            (self.root / "docker-compose.yml.legacy").read_text(encoding="utf-8"),
            "preserve existing archive\n",
        )
        self.assertFalse((self.root / "docker-compose.napcat.yml").exists())

    def test_retire_rejects_empty_migration_marker_with_steps(self):
        fake = self._install_fake_docker()
        (self.root / "qq-agent-data" / "config.json").write_text("", encoding="utf-8")
        result = run_bash(RETIRE, self._retire_env(fake))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("不要以空目录作为完成依据", result.stderr)
        self.assertIn("安排维护窗口", result.stderr)
        self.assertTrue((self.root / "docker-compose.yml").exists())
        self.assertFalse((self.root / "docker-compose.napcat.yml").exists())

    def test_retire_rolls_back_when_second_archive_rename_fails(self):
        fake_docker = self._install_fake_docker()
        original_napcat_compose = "manual compose that must be preserved\n"
        (self.root / "docker-compose.napcat.yml").write_text(
            original_napcat_compose, encoding="utf-8"
        )
        mv_dir = self.base / "mock-mv-bin"
        mv_dir.mkdir()
        mock_mv = mv_dir / "mv"
        mock_mv.write_text(
            """#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do
  if [[ "$arg" == "docker-compose.platform.yml" ]]; then
    exit 23
  fi
done
exec /bin/mv -- "$@"
""",
            encoding="utf-8",
            newline="\n",
        )
        make_executable(mock_mv)
        env = self._retire_env(fake_docker)
        env["PATH"] = linux_path(mv_dir) + ":/usr/bin:/bin"
        result = run_bash(RETIRE, env)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(
            (self.root / "docker-compose.yml").read_text(encoding="utf-8"),
            "old main compose\n",
        )
        self.assertEqual(
            (self.root / "docker-compose.platform.yml").read_text(encoding="utf-8"),
            "old platform compose\n",
        )
        self.assertFalse((self.root / "docker-compose.yml.legacy").exists())
        self.assertEqual(
            (self.root / "docker-compose.napcat.yml").read_text(encoding="utf-8"),
            original_napcat_compose,
        )
        backups = list(self.root.glob("docker-compose.napcat.yml.bak.*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(encoding="utf-8"), original_napcat_compose)

    def test_unknown_guard_state_alerts_and_down_notice_is_matched(self):
        self._run_guard(mode="unknown", token_key="NAPCAT_WEBUI_TOKEN")
        output = (self.guard_root / "napcat-status.txt").read_text(encoding="utf-8")
        self.assertRegex(output, r"总体状态\s*:\s*UNKNOWN")
        self.assertIn("账号登录   : unknown", output)
        self.assertIn("下线通知", output)
        self.assertEqual(
            (self.guard_root / ".napcat-guard-state").read_text(encoding="utf-8"),
            "UNKNOWN\n",
        )
        self.assertIn("登录状态未知", self.guard_result.stderr)
        self.assertIn("/api/auth/login", self.curl_log.read_text(encoding="utf-8"))

    def test_guard_only_reports_ok_after_confirmed_login(self):
        self._run_guard(mode="logged-in", token_key="WEBUI_TOKEN")
        output = (self.guard_root / "napcat-status.txt").read_text(encoding="utf-8")
        self.assertRegex(output, r"总体状态\s*:\s*OK")
        self.assertEqual(
            (self.guard_root / ".napcat-guard-state").read_text(encoding="utf-8"),
            "OK\n",
        )

    def _run_guard(self, mode, token_key):
        if not BASH:
            self.skipTest("bash is required for Linux ops tests")
        self.guard_root = self.base / ("guard-" + mode)
        self.guard_root.mkdir()
        self.curl_log = self.guard_root / "curl.log"
        (self.guard_root / ".env").write_text(
            token_key + "=dummy-placeholder-token\n", encoding="utf-8"
        )
        (self.guard_root / ".napcat-guard-state").write_text("OK\n", encoding="utf-8")

        bin_dir = self.base / ("guard-bin-" + mode)
        bin_dir.mkdir()
        docker = bin_dir / "docker"
        docker.write_text(
            """#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  ps) echo napcat ;;
  inspect)
    case "$*" in
      *RestartCount*) echo 1 ;;
      *StartedAt*) echo mock-start ;;
      *) exit 4 ;;
    esac ;;
  logs) echo 'NapCat 下线通知：账号离线' ;;
  *) exit 5 ;;
esac
""",
            encoding="utf-8",
            newline="\n",
        )
        ss = bin_dir / "ss"
        ss.write_text("#!/usr/bin/env bash\necho 'LISTEN 0 10 127.0.0.1:3001 0.0.0.0:*'\n",
                      encoding="utf-8", newline="\n")
        curl = bin_dir / "curl"
        curl.write_text(
            """#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$MOCK_CURL_LOG"
case "$*" in
  *"/api/auth/login"*)
    if [[ "$MOCK_CURL_MODE" == "logged-in" ]]; then
      echo '{"data":{"Credential":"mock-credential"}}'
    fi ;;
  *"/api/QQLogin/CheckLoginStatus"*)
    if [[ "$MOCK_CURL_MODE" == "logged-in" ]]; then
      echo '{"code":0,"data":{"isLogin":true}}'
    else
      echo '{}'
    fi ;;
esac
""",
            encoding="utf-8",
            newline="\n",
        )
        logger = bin_dir / "logger"
        logger.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8", newline="\n")
        for path in (docker, ss, curl, logger):
            make_executable(path)

        self._run_linux(["chmod", "+x", str(docker), str(ss), str(curl), str(logger)])
        env = os.environ.copy()
        env.update({
            "PATH": linux_path(bin_dir) + ":/usr/bin:/bin",
            "COMPOSE_DIR": linux_path(self.guard_root),
            "MOCK_CURL_LOG": linux_path(self.curl_log),
            "MOCK_CURL_MODE": mode,
        })
        self.guard_result = run_bash(GUARD, env)
        self.assertEqual(
            self.guard_result.returncode, 0,
            self.guard_result.stdout + self.guard_result.stderr,
        )

    def test_qr_token_environment_compatibility(self):
        tree = ast.parse(QR_SERVER.read_text(encoding="utf-8"))
        assignment = next(
            node for node in tree.body
            if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "WEBUI_TOKEN"
                    for target in node.targets)
        )
        code = compile(ast.Module(body=[assignment], type_ignores=[]), str(QR_SERVER), "exec")
        import unittest.mock
        with unittest.mock.patch.dict(os.environ, {
            "WEBUI_TOKEN": " primary-token ", "NAPCAT_WEBUI_TOKEN": "legacy-token",
        }, clear=True):
            scope = {"os": os}
            exec(code, scope)
            self.assertEqual(scope["WEBUI_TOKEN"], "primary-token")
        with unittest.mock.patch.dict(os.environ, {
            "NAPCAT_WEBUI_TOKEN": " legacy-token ",
        }, clear=True):
            scope = {"os": os}
            exec(code, scope)
            self.assertEqual(scope["WEBUI_TOKEN"], "legacy-token")

    def test_sanitizer_copies_canonical_sources_and_refuses_self_output(self):
        output = self.base / "sanitized-output"
        result = subprocess.run(
            [sys.executable, str(SANITIZER), "--out-dir", str(output)],
            text=True, encoding="utf-8", errors="replace",
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for source, target in (
            ("deploy/ops/napcat-guard.sh", "napcat-guard.sh"),
            ("deploy/ops/qr-server.py", "qr-server.py"),
            ("deploy/systemd/napcat-guard.service", "systemd/napcat-guard.service"),
            ("deploy/systemd/napcat-guard.timer", "systemd/napcat-guard.timer"),
            ("deploy/systemd/qr-server.service", "systemd/qr-server.service"),
        ):
            self.assertEqual(
                (output / target).read_bytes(),
                (REPO / source).read_bytes(),
            )
        self.assertIn("NAPCAT_WEBUI_TOKEN", (output / "qr-server.py").read_text(encoding="utf-8"))
        self.assertIn('state="UNKNOWN"', (output / "napcat-guard.sh").read_text(encoding="utf-8"))

        result = subprocess.run(
            [sys.executable, str(SANITIZER), "--out-dir", str(REPO / "deploy" / "ops")],
            text=True, encoding="utf-8", errors="replace",
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("拒绝将输出目录", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)

#!/usr/bin/env python3
"""Copy canonical, credential-free Linux ops files into a reviewable output directory."""

import argparse
import os
import re
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = Path("/tmp/ops-sanitized")
ARTIFACTS = (
    ("deploy/ops/napcat-guard.sh", "napcat-guard.sh", 0o755),
    ("deploy/ops/qr-server.py", "qr-server.py", 0o644),
    ("deploy/systemd/napcat-guard.service", "systemd/napcat-guard.service", 0o644),
    ("deploy/systemd/napcat-guard.timer", "systemd/napcat-guard.timer", 0o644),
    ("deploy/systemd/qr-server.service", "systemd/qr-server.service", 0o644),
)
LITERAL_TOKEN = re.compile(
    r"""(?im)^\s*(?:WEBUI_TOKEN|NAPCAT_WEBUI_TOKEN)\s*=\s*['"][A-Za-z0-9_-]{16,}['"]"""
)


def is_within(path, parent):
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def validate_canonical_sources():
    sources = {target: REPO_ROOT / source for source, target, _mode in ARTIFACTS}
    qr = sources["qr-server.py"].read_text(encoding="utf-8")
    guard = sources["napcat-guard.sh"].read_text(encoding="utf-8")
    if "os.environ.get(\"WEBUI_TOKEN\")" not in qr:
        raise SystemExit("canonical qr-server.py 缺少 WEBUI_TOKEN 读取")
    if "os.environ.get(\"NAPCAT_WEBUI_TOKEN\")" not in qr:
        raise SystemExit("canonical qr-server.py 缺少 NAPCAT_WEBUI_TOKEN 兼容读取")
    if "if not WEBUI_TOKEN:" not in qr:
        raise SystemExit("canonical qr-server.py 缺少空 token 拒绝逻辑")
    if 'KICK_PATTERN=' not in guard or 'KickedOffLine|下线通知|登录已失效' not in guard:
        raise SystemExit("canonical napcat-guard.sh 缺少统一踢线日志匹配")
    if 'login_state" = "logged_in"' not in guard or 'state="UNKNOWN"' not in guard:
        raise SystemExit("canonical napcat-guard.sh 缺少已确认登录/UNKNOWN 状态判定")
    return sources


def write_atomic(destination, content, mode):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_symlink():
        raise SystemExit("拒绝覆盖符号链接：" + str(destination))
    fd, temp_name = tempfile.mkstemp(prefix="." + destination.name + ".", dir=str(destination.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
        os.chmod(temp_name, mode)
        os.replace(temp_name, destination)
    except Exception:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description="从仓库 canonical 文件生成脱敏 Linux 运维包")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT,
                        help="输出目录（默认：/tmp/ops-sanitized）")
    args = parser.parse_args(argv)

    out_dir = args.out_dir.resolve()
    repo_root = REPO_ROOT.resolve()
    if is_within(out_dir, repo_root) or is_within(repo_root, out_dir):
        raise SystemExit("拒绝将输出目录设在仓库内或设为仓库父目录：" + str(out_dir))

    sources = validate_canonical_sources()
    staged = []
    for _source, target, mode in ARTIFACTS:
        text = sources[target].read_text(encoding="utf-8")
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        match = LITERAL_TOKEN.search(text)
        if match:
            raise SystemExit("canonical 文件含疑似硬编码 token：" + target)
        staged.append((target, text, mode))

    print("=== 从仓库 canonical 文件生成到 %s ===" % out_dir)
    for target, text, mode in staged:
        destination = out_dir / target
        write_atomic(destination, text, mode)
        print("  %-32s %6d 字节" % (target, destination.stat().st_size))
    print("✅ 文件来自 deploy/ops 与 deploy/systemd，未复制外部快照或凭据")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

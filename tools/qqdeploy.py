#!/usr/bin/env python3
"""
qqdeploy —— 把 GitHub 仓库的某个分支/提交部署到本机（QQ Agent 服务器）

设计要点（都是踩过坑才这么写的）：

1. **不走 git 协议**。本机 git clone over HTTPS 被墙，但 api.github.com 可用，
   所以直接用 API 下载 tarball。按分支名或 commit sha 都能取。
   代价是没有 git 历史 —— 因此提交 sha 会写进版本记录，回滚靠 releases/ 目录。

2. **每次部署独立目录** /opt/qq/releases/<sha>/，current 是指向它的软链。
   回滚 = 把软链切回上一个 release + 重建，不需要重新下载。

3. **先验证再切换**：语法检查 + 模块依赖检查不过就中止，线上容器一个字节都不动。

4. **失败自动回滚**：重建后健康检查不过，自动切回 deploy 前的 release 并再重建。

5. **防并发**：flock 独占锁。build --no-cache 要 3~4 分钟，两个人同时部署会互相覆盖，
   而服务器只有 1.6G 内存，也跑不了两个实例。

6. **不碰 data**：只更新代码；/opt/qq/qq-agent-data 与 /opt/qq/qq-agent-plugins 始终是
   独立 bind mount，重建容器不影响。

用法（需要 sudo，已配 NOPASSWD 免密）：
    sudo qqdeploy main                 # 部署 main 分支
    sudo qqdeploy feat/xxx             # 部署某个分支
    sudo qqdeploy a334bdc              # 部署指定 commit
    sudo qqdeploy --status             # 看当前部署了什么
    sudo qqdeploy --list               # 列出保留的版本
    sudo qqdeploy --rollback           # 回滚到上一个部署过的版本
    sudo qqdeploy --rollback <sha>     # 回滚到指定版本（需仍在 releases/ 里）
"""

import argparse
import contextlib
import fcntl
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request

# ── 配置 ──────────────────────────────────────────────────────────────────────
DEFAULT_REPO = "viuuro/qq-agent-xiaoruan"
REPO = DEFAULT_REPO
ROOT = "/opt/qq"
RELEASES = os.path.join(ROOT, "releases")
CURRENT = os.path.join(ROOT, "current")          # 软链 -> releases/<sha>
STATE = os.path.join(ROOT, ".deployed.json")     # 当前部署记录
LOCK = os.path.join(ROOT, ".deploy.lock")
ENV_FILE = os.path.join(ROOT, ".env")            # NAPCAT_UID/GID/WEBUI_TOKEN/QQ_ACCOUNT
TRUSTED_LIB = "/usr/local/lib/qqdeploy"
TRUSTED_CHECKER = os.path.join(TRUSTED_LIB, "check-modules.py")
TRUSTED_DOCKERFILE = os.path.join(TRUSTED_LIB, "Dockerfile")
TRUSTED_COMPOSE_TEMPLATE = os.path.join(TRUSTED_LIB, "compose.template.yml")
CHECK_USER = "qqcheck"
REPO_CONFIG = "/etc/qqdeploy/repositories.json"
KEEP_RELEASES = 8                                # 保留多少个历史版本
AGENT_CONTAINER = "qq-agent"
HEALTH_TIMEOUT = 180                             # 重建后等待健康的秒数

# ★ compose 项目名必须与既有部署一致，否则 docker compose 会把容器当成"新的"，
#   于是 attempt 创建第二个同名容器 → 报
#     Conflict. The container name "/qq-agent" is already in use
#   而不会去替换它。线上原本由 /opt/qq/docker-compose.yml 管理，项目名是 qq
#   （工作目录名），这里显式固定，避免随 release 目录名漂移。
COMPOSE_PROJECT = os.environ.get("QQ_COMPOSE_PROJECT", "qq")

API = "https://api.github.com/repos/%s" % REPO


# ── 小工具 ────────────────────────────────────────────────────────────────────
def sh(cmd, check=False, timeout=None, stream=False):
    """Run a command and always return (returncode, stdout, stderr)."""
    if stream:
        p = subprocess.run(cmd, shell=isinstance(cmd, str), text=True)
        if check and p.returncode != 0:
            raise SystemExit("命令失败(%d): %s" % (p.returncode, cmd))
        return p.returncode, "", ""
    p = subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True,
                       text=True, timeout=timeout)
    if check and p.returncode != 0:
        raise SystemExit("命令失败(%d): %s\n%s" % (p.returncode, cmd, p.stderr[-800:]))
    return p.returncode, (p.stdout or ""), (p.stderr or "")


def command_rc(result):
    """Extract the exit status from sh's stable result tuple."""
    return result[0]


def c_ok(t): return "\033[32m%s\033[0m" % t
def c_warn(t): return "\033[33m%s\033[0m" % t
def c_err(t): return "\033[31m%s\033[0m" % t
def c_dim(t): return "\033[2m%s\033[0m" % t


def log(msg):
    print("  " + msg, flush=True)


def head(msg):
    print("\n" + "=" * 62)
    print("  " + msg)
    print("=" * 62, flush=True)


def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return default


def write_json(path, obj):
    parent = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(prefix=".%s." % os.path.basename(path), dir=parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(obj, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
        if hasattr(os, "O_DIRECTORY"):
            dir_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def git_json(url):
    """调 GitHub API 取 JSON。带 UA，否则 403。"""
    req = urllib.request.Request(url, headers={
        "User-Agent": "qqdeploy/1.0",
        "Accept": "application/vnd.github+json",
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def configure_repository(path=REPO_CONFIG):
    """Read the administrator-controlled allowlist; caller environment is ignored."""
    try:
        info = os.stat(path, follow_symlinks=False)
    except OSError as exc:
        raise SystemExit("缺少管理员仓库配置 %s：%s" % (path, exc))
    if (not stat.S_ISREG(info.st_mode) or os.path.islink(path)
            or (os.name != "nt" and (info.st_uid != 0 or info.st_mode & 0o022))):
        raise SystemExit("仓库配置必须是 root 拥有且不可被组/其他用户写入的普通文件")
    try:
        with open(path, encoding="utf-8") as fh:
            config = json.load(fh)
    except (OSError, ValueError) as exc:
        raise SystemExit("仓库配置无效：%s" % exc)
    allowed = config.get("allowed") if isinstance(config, dict) else None
    selected = config.get("default") if isinstance(config, dict) else None
    if (not isinstance(allowed, list) or not allowed
            or any(not isinstance(repo, str)
                   or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo)
                   for repo in allowed)
            or selected not in allowed):
        raise SystemExit("仓库配置需包含 default 及非空 allowed 清单，且 default 必须在清单内")
    global REPO, API
    REPO = selected
    API = "https://api.github.com/repos/%s" % REPO
    return REPO


# ── 健康检查 ──────────────────────────────────────────────────────────────────
def container_up():
    rc, out, _ = sh(["docker", "inspect", AGENT_CONTAINER, "--format",
                     "{{.State.Running}} {{.RestartCount}}"])
    if rc != 0:
        return False, "容器不存在"
    parts = out.strip().split()
    if parts and parts[0] == "true":
        restarts = parts[1] if len(parts) > 1 else "?"
        return True, "运行中（重启次数 %s）" % restarts
    return False, "未在运行"


def agent_api(path="/api/status"):
    rc, out, _ = sh(["curl", "-s", "-m", "8", "http://127.0.0.1:3210" + path])
    if rc != 0 or not out.strip():
        return None
    try:
        return json.loads(out)
    except Exception:
        return None


def plugin_snapshot(skills_payload):
    """Validate /api/skills and capture enabled IDs plus broken count."""
    if not isinstance(skills_payload, dict) or not isinstance(skills_payload.get("skills"), list):
        return None
    summary = skills_payload.get("summary")
    if not isinstance(summary, dict):
        return None
    broken = summary.get("broken")
    if isinstance(broken, bool) or not isinstance(broken, int) or broken < 0:
        return None
    enabled_ids = set()
    healthy_enabled_ids = set()
    for skill in skills_payload["skills"]:
        if not isinstance(skill, dict) or not isinstance(skill.get("id"), str):
            return None
        if skill.get("enabled") is True:
            enabled_ids.add(skill["id"])
            if skill.get("loaded") is True and skill.get("active") is True:
                healthy_enabled_ids.add(skill["id"])
    return {"enabled_ids": enabled_ids,
            "healthy_enabled_ids": healthy_enabled_ids, "broken": broken}


def capture_plugin_baseline():
    payload = agent_api("/api/skills")
    if payload is not None:
        snapshot = plugin_snapshot(payload)
        if snapshot is not None:
            return snapshot
    running, _ = container_up()
    if running:
        raise SystemExit("无法读取当前插件基线，拒绝切换线上容器")
    # 首次部署且没有运行中的 agent 时，空基线是有效状态。
    return {"enabled_ids": set(), "broken": 0}


def health_check(verbose=True, plugin_baseline=None):
    """返回 (ok, 说明列表)，并校验 OneBot 与插件健康。"""
    notes, ok = [], True

    up, why = container_up()
    notes.append(("容器", up, why))
    ok = ok and up

    st = agent_api("/api/status")
    if st is None:
        notes.append(("控制台 API", False, "无响应"))
        ok = False
    else:
        ob = (st.get("onebot") or {}).get("connected")
        notes.append(("OneBot", bool(ob), "已连接" if ob else "未连接"))
        ok = ok and bool(ob)

    sk = agent_api("/api/skills")
    if sk is None:
        notes.append(("插件", False, "读不到 /api/skills"))
        ok = False
    else:
        snapshot = plugin_snapshot(sk)
        if snapshot is None:
            good, reason = False, "/api/skills 响应格式无效"
        else:
            baseline = plugin_baseline or {"enabled_ids": set(), "broken": 0}
            current_by_id = {item["id"]: item for item in sk["skills"]}
            missing = sorted(
                skill_id for skill_id in baseline.get("enabled_ids", set())
                if skill_id not in current_by_id
                or current_by_id[skill_id].get("enabled") is not True
            )
            unhealthy = sorted(
                skill_id for skill_id in baseline.get("healthy_enabled_ids", set())
                if skill_id not in current_by_id
                or current_by_id[skill_id].get("loaded") is not True
                or current_by_id[skill_id].get("active") is not True
            )
            increased = snapshot["broken"] > baseline.get("broken", 0)
            good = not missing and not unhealthy and not increased
            pieces = ["启用 %d 个，异常 %d 个" % (
                len(snapshot["enabled_ids"]), snapshot["broken"])]
            if missing:
                pieces.append("缺失/禁用基线插件: %s" % ", ".join(missing))
            if unhealthy:
                pieces.append("基线插件未加载: %s" % ", ".join(unhealthy))
            if increased:
                pieces.append("异常数高于基线 %d" % baseline["broken"])
            reason = "；".join(pieces)
        notes.append(("插件", good, reason))
        ok = ok and good

    if verbose:
        for name, good, why in notes:
            log("  %-10s %s  %s" % (name, c_ok("OK") if good else c_err("FAIL"), c_dim(why)))
    return ok, notes


# ── 下载与解压 ────────────────────────────────────────────────────────────────
def resolve_ref(ref):
    """把分支名/短 sha 解析成完整 sha。返回 (sha, 显示名)。"""
    if not ref or "\x00" in ref:
        raise SystemExit("ref 不能为空或包含 NUL")
    if re.fullmatch(r"[0-9a-fA-F]{40}", ref):
        sha = ref.lower()
        return sha, sha[:12]
    is_short_sha = bool(re.fullmatch(r"[0-9a-fA-F]{7,39}", ref))
    try:
        # quote(..., safe="") is required for branch names such as feat/a.
        j = git_json("%s/commits/%s" % (API, urllib.parse.quote(ref, safe="")))
        sha = j.get("sha", "").lower()
        if not re.fullmatch(r"[0-9a-f]{40}", sha):
            raise ValueError("GitHub API 没有返回完整 SHA")
        if is_short_sha and not sha.startswith(ref.lower()):
            raise ValueError("GitHub 返回的提交不匹配短 SHA")
        return sha, sha[:12]
    except Exception as exc:
        raise SystemExit("无法解析 %r：%s\n"
                         "（分支名拼错？或 API 限流？未认证时每小时 60 次）" % (ref, exc))


def download(sha, dest_dir):
    """下载指定 commit 的 tarball 并解压到 dest_dir（内容直接落在 dest_dir 下）。"""
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise SystemExit("下载目标必须是规范的 40 位 SHA")
    releases_root = os.path.realpath(RELEASES)
    dest_abs = os.path.abspath(dest_dir)
    if os.path.dirname(dest_abs) != releases_root or os.path.basename(dest_abs) != sha:
        raise SystemExit("release 目标必须是 releases/<完整SHA> 下的直接子目录")
    if os.path.lexists(dest_abs):
        raise SystemExit("release 目标已存在，拒绝覆盖：%s" % dest_abs)

    url = "%s/tarball/%s" % (API, sha)
    os.makedirs(RELEASES, mode=0o755, exist_ok=True)
    fd, tmp = tempfile.mkstemp(suffix=".tar.gz", dir=RELEASES)
    os.close(fd)
    stage = tempfile.mkdtemp(prefix=".qqdeploy-extract-", dir=RELEASES)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "qqdeploy/1.0"})
        with urllib.request.urlopen(req, timeout=180) as resp, open(tmp, "wb") as fh:
            shutil.copyfileobj(resp, fh)
        size = os.path.getsize(tmp)
        if size < 100_000:
            raise SystemExit("下载内容过小（%d 字节），可能是错误响应" % size)
        log("下载完成 %s" % c_dim("%.1f MB" % (size / 1048576)))

        with tarfile.open(tmp, "r:gz") as tf:
            members = tf.getmembers()
            roots = set()
            parsed = []
            for member in members:
                name = member.name
                if not name or name.startswith("/") or "\\" in name or "\x00" in name:
                    raise SystemExit("tarball 含非法路径")
                parts = name.split("/")
                if parts[-1] == "":
                    parts.pop()
                if not parts or any(part in ("", ".", "..") for part in parts):
                    raise SystemExit("tarball 含越界路径：%s" % name)
                roots.add(parts[0])
                parsed.append((member, parts))
            if len(roots) != 1:
                raise SystemExit("tarball 结构异常：顶层目录不唯一 %s" % roots)
            root = roots.pop()
            content = os.path.join(stage, "content")
            os.mkdir(content, 0o755)
            for member, parts in parsed:
                if parts[0] != root:
                    raise SystemExit("tarball 顶层目录不一致")
                relative_parts = parts[1:]
                if not relative_parts:
                    if not member.isdir():
                        raise SystemExit("tarball 顶层必须是目录")
                    continue
                if not (member.isdir() or member.isfile()):
                    raise SystemExit("tarball 含链接或特殊文件：%s" % member.name)
                target = os.path.join(content, *relative_parts)
                parent = os.path.dirname(target)
                os.makedirs(parent, mode=0o755, exist_ok=True)
                # No archive entry is allowed to create a symlink, but retain this
                # check to prevent duplicate or unexpected path types.
                probe = content
                for part in relative_parts[:-1]:
                    probe = os.path.join(probe, part)
                    if os.path.islink(probe) or not os.path.isdir(probe):
                        raise SystemExit("tarball 路径父项不是普通目录")
                if member.isdir():
                    if os.path.lexists(target) and not os.path.isdir(target):
                        raise SystemExit("tarball 路径冲突：%s" % member.name)
                    os.makedirs(target, mode=0o755, exist_ok=True)
                    os.chmod(target, 0o755)
                    continue
                if os.path.lexists(target):
                    raise SystemExit("tarball 重复文件：%s" % member.name)
                source = tf.extractfile(member)
                if source is None:
                    raise SystemExit("无法读取 tarball 文件：%s" % member.name)
                with source, open(target, "xb") as output:
                    shutil.copyfileobj(source, output)
                os.chmod(target, member.mode & 0o755 & ~0o6000)
            if not os.path.isfile(os.path.join(content, "app", "src", "app.js")):
                raise SystemExit("下载内容缺少 app/src/app.js")
            os.replace(content, dest_abs)
        log("解压完成 → %s" % c_dim(dest_dir))
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
        shutil.rmtree(stage, ignore_errors=True)


# ── 校验 ──────────────────────────────────────────────────────────────────────
BIND_PATCH_OLD = "server.listen(port, '127.0.0.1', () => {"
BIND_PATCH_NEW = "server.listen(port, process.env.QQ_AGENT_BIND_HOST || '127.0.0.1', () => {"


def ensure_bind_patch(rel_dir):
    """
    保证 app/src/app.js 读 QQ_AGENT_BIND_HOST。
    容器里必须监听 0.0.0.0，否则宿主机端口映射连不上。
    仓库里的版本已经打好补丁；这里只是兜底（部署老 commit 时会用到）。
    """
    validate_release_tree(rel_dir)
    p = os.path.join(rel_dir, "app", "src", "app.js")
    if not os.path.exists(p):
        raise SystemExit("缺少 app/src/app.js，这不是一个有效的 release")
    with open(p, encoding="utf-8") as fh:
        t = fh.read()
    if "QQ_AGENT_BIND_HOST" in t:
        return "已有补丁"
    if t.count(BIND_PATCH_OLD) != 1:
        raise SystemExit("app.js 绑定地址那行锚点不唯一，拒绝部署")
    with open(p, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(t.replace(BIND_PATCH_OLD, BIND_PATCH_NEW, 1))
    return "已补补丁"


def detect_live_project():
    """
    读线上 qq-agent 容器的 compose 项目名。
    首次接管（还没有部署记录）时用它校准 COMPOSE_PROJECT，
    免得项目名不对导致"已存在同名容器"的冲突。
    """
    rc, out, _ = sh(["docker", "inspect", AGENT_CONTAINER, "--format",
                     '{{index .Config.Labels "com.docker.compose.project"}}'])
    if rc == 0 and out.strip() and out.strip() != "<no value>":
        return out.strip()
    return None


def verify(rel_dir):
    """语法检查 + 模块依赖检查。任一不过就中止（线上不动）。"""
    src = os.path.join(rel_dir, "app", "src")
    js = []
    for root, dirs, files in os.walk(src):
        dirs.sort()
        js.extend(os.path.join(root, name) for name in sorted(files)
                  if name.endswith(".js"))
    log("语法检查（%d 个文件）…" % len(js))

    # 用宿主上的 node 跑：镜像里的 node 要起容器，太重。
    # 宿主没 node 就退回容器跑（用当前镜像）。
    rc, _, _ = sh(["bash", "-lc", "command -v node"])
    if rc == 0:
        bad = []
        for path in js:
            rc, _, err = sh(["runuser", "-u", CHECK_USER, "--", "env", "-i",
                             "PATH=/usr/local/bin:/usr/bin:/bin", "node", "--check", path])
            if rc != 0:
                bad.append((os.path.relpath(path, src), err.strip().splitlines()[:2]))
        if bad:
            for f, err in bad:
                log(c_err("语法错误 %s" % f))
                for e in err:
                    log("    " + e)
            raise SystemExit("语法检查未通过，已中止（线上未改动）")
        log(c_ok("语法全部通过"))
    else:
        log(c_warn("宿主没有 node，跳过语法检查（模块依赖检查仍会跑）"))

    # 模块依赖检查：找出 import 了不存在的文件 / 未导出的符号
    read_trusted_file(TRUSTED_CHECKER)
    rc, out, _ = sh(["runuser", "-u", CHECK_USER, "--", "env", "-i",
                     "PATH=/usr/local/bin:/usr/bin:/bin", "python3", "-I",
                     TRUSTED_CHECKER, src])
    tail = [line for line in (out or "").splitlines() if line.strip()][-3:]
    for line in tail:
        log("  " + line)
    if rc != 0:
        raise SystemExit("模块依赖图不完整，已中止（线上未改动）")


# ── docker 操作 ───────────────────────────────────────────────────────────────








def validate_trusted_file(path):
    """Require the trusted file and every parent to be root-controlled."""
    absolute = os.path.abspath(path)
    if not absolute.startswith(TRUSTED_LIB + os.sep):
        raise SystemExit("可信部署文件必须位于 %s 下：%s" % (TRUSTED_LIB, path))
    current = os.path.dirname(absolute)
    directories = []
    while current != os.path.dirname(current):
        directories.append(current)
        current = os.path.dirname(current)
    directories.append(os.path.abspath(os.sep))
    for directory in directories:
        try:
            info = os.stat(directory, follow_symlinks=False)
        except OSError as exc:
            raise SystemExit("可信部署文件父目录不可访问 %s：%s" % (directory, exc))
        if not stat.S_ISDIR(info.st_mode):
            raise SystemExit("可信部署文件父路径必须是普通目录：%s" % directory)
        if os.name != "nt" and (info.st_uid != 0 or info.st_mode & 0o022):
            raise SystemExit("可信部署文件父目录必须由 root 拥有且不可被组/其他用户写入：%s" % directory)
    try:
        info = os.stat(absolute, follow_symlinks=False)
    except OSError as exc:
        raise SystemExit("缺少可信部署文件 %s：%s" % (path, exc))
    if not stat.S_ISREG(info.st_mode) or os.path.islink(absolute):
        raise SystemExit("可信部署路径不是普通文件或是符号链接：%s" % path)
    if os.name != "nt" and (info.st_uid != 0 or info.st_mode & 0o022):
        raise SystemExit("可信部署文件必须由 root 拥有且不可被组/其他用户写入：%s" % path)
    return absolute


def read_trusted_file(path):
    trusted_path = validate_trusted_file(path)
    try:
        with open(trusted_path, encoding="utf-8") as fh:
            return fh.read()
    except OSError as exc:
        raise SystemExit("无法读取可信部署文件 %s：%s" % (path, exc))


def require_root_owned(path, expected_type, label):
    try:
        info = os.stat(path, follow_symlinks=False)
    except OSError as exc:
        raise SystemExit("%s 不可访问 %s：%s" % (label, path, exc))
    if not expected_type(info.st_mode):
        raise SystemExit("%s 必须是安全的普通路径：%s" % (label, path))
    if os.name != "nt" and (info.st_uid != 0 or info.st_mode & 0o022):
        raise SystemExit("%s 必须由 root 拥有且不可被组/其他用户写入：%s" % (label, path))
    return info


def validate_release_tree(rel_dir):
    """Reject untrusted release paths before root reads or mutates source files."""
    releases_root = os.path.realpath(RELEASES)
    absolute = os.path.abspath(rel_dir)
    if os.path.dirname(absolute) != releases_root:
        raise SystemExit("release 必须是 releases 下的直接目录：%s" % rel_dir)
    require_root_owned(RELEASES, stat.S_ISDIR, "release 根目录")
    require_root_owned(absolute, stat.S_ISDIR, "release 目录")
    for root, dirs, files in os.walk(absolute, topdown=True, followlinks=False):
        dirs.sort()
        files.sort()
        for name in dirs + files:
            path = os.path.join(root, name)
            try:
                info = os.stat(path, follow_symlinks=False)
            except OSError as exc:
                raise SystemExit("release 项不可访问 %s：%s" % (path, exc))
            if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                raise SystemExit("release 含符号链接或特殊文件：%s" % path)
            if os.name != "nt" and (
                    info.st_uid != 0 or info.st_mode & 0o022
                    or (stat.S_ISREG(info.st_mode) and info.st_nlink != 1)):
                raise SystemExit("release 项必须由 root 单独拥有且不可被组/其他用户写入：%s" % path)
    return absolute


def validate_deployment_paths(create=False):
    """Validate deployment directories and control files before root writes."""
    root = os.path.abspath(ROOT)
    parent = os.path.dirname(root)
    require_root_owned(parent, stat.S_ISDIR, "部署根目录父目录")
    if not os.path.lexists(root):
        if not create:
            raise SystemExit("部署根目录不存在：%s" % root)
        os.mkdir(root, 0o755)
    require_root_owned(root, stat.S_ISDIR, "部署根目录")

    releases = os.path.abspath(RELEASES)
    if os.path.dirname(releases) != root:
        raise SystemExit("release 根目录必须位于部署根目录下")
    if not os.path.lexists(releases):
        if not create:
            raise SystemExit("release 根目录不存在：%s" % releases)
        os.mkdir(releases, 0o755)
    require_root_owned(releases, stat.S_ISDIR, "release 根目录")

    for path, label in ((STATE, "部署状态文件"), (LOCK, "部署锁文件"),
                        (ENV_FILE, "部署环境文件")):
        if not os.path.lexists(path):
            continue
        info = require_root_owned(path, stat.S_ISREG, label)
        if os.name != "nt" and info.st_nlink != 1:
            raise SystemExit("%s 不能是硬链接：%s" % (label, path))

    if os.path.lexists(CURRENT):
        try:
            info = os.stat(CURRENT, follow_symlinks=False)
        except OSError as exc:
            raise SystemExit("current 软链不可访问：%s" % exc)
        if not stat.S_ISLNK(info.st_mode):
            raise SystemExit("current 必须是软链：%s" % CURRENT)
        if os.name != "nt" and info.st_uid != 0:
            raise SystemExit("current 软链必须由 root 拥有")
        validate_release_tree(os.path.realpath(CURRENT))
    return True


def release_sha(rel_dir):
    path = validate_release_tree(rel_dir)
    name = os.path.basename(path)
    if not re.fullmatch(r"[0-9a-f]{7,40}", name):
        raise SystemExit("release 目录名不是合法 SHA 前缀：%s" % name)
    return name


def write_release_compose(rel_dir, sha=None, image_tag=None):
    """使用安装器提供的 root-owned 模板和 Dockerfile 生成 release compose。"""
    release_prefix = release_sha(rel_dir)
    sha = (sha or release_prefix).lower()
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise SystemExit("compose 镜像必须使用完整 40 位 SHA")
    if not sha.startswith(release_prefix):
        raise SystemExit("release 目录 SHA 前缀与目标镜像不一致")
    compose = read_trusted_file(TRUSTED_COMPOSE_TEMPLATE)
    image_tag = image_tag or ("qq-agent:sha-" + sha)
    if not re.fullmatch(r"qq-agent:[A-Za-z0-9_.-]+", image_tag):
        raise SystemExit("镜像标签无效")
    replacements = {
        "__QQDEPLOY_CONTEXT__": json.dumps(os.path.realpath(rel_dir)),
        "__QQDEPLOY_DOCKERFILE__": json.dumps(TRUSTED_DOCKERFILE),
        "__QQDEPLOY_IMAGE__": json.dumps(image_tag),
        "__QQDEPLOY_DATA_MOUNT__": json.dumps(os.path.join(ROOT, "qq-agent-data") + ":/app/data"),
        "__QQDEPLOY_PLUGINS_MOUNT__": json.dumps(os.path.join(ROOT, "qq-agent-plugins") + ":/app/plugins"),
    }
    for placeholder, value in replacements.items():
        compose = compose.replace(placeholder, value)
    if "__QQDEPLOY_" in compose:
        raise SystemExit("可信 compose 模板含未知占位符")
    compose_path = os.path.join(rel_dir, "compose.release.yml")
    if os.path.lexists(compose_path):
        info = os.stat(compose_path, follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode) or os.path.islink(compose_path):
            raise SystemExit("compose.release.yml 必须是普通文件，拒绝跟随链接写入")
    fd, tmp = tempfile.mkstemp(prefix=".compose.release.", dir=rel_dir)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(compose)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o644)
        os.replace(tmp, compose_path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    validate_release_compose(rel_dir)


def validate_release_compose(rel_dir):
    path = os.path.join(rel_dir, "compose.release.yml")
    rc, _, err = sh(["docker", "compose", "-p", COMPOSE_PROJECT, "-f", path,
                     "config", "--quiet"])
    if rc != 0:
        raise SystemExit("生成的 Compose 配置无效：%s" % (err.strip() or "docker compose config 失败"))


def compose_files(rel_dir):
    """release 自带的 compose + 显式项目名。"""
    return ["-p", COMPOSE_PROJECT, "-f", os.path.join(rel_dir, "compose.release.yml")]










def build_release(rel_dir, quiet=False):
    """构建 release 镜像，不改变 current 或运行容器。"""
    release_sha(rel_dir)
    validate_trusted_file(TRUSTED_DOCKERFILE)
    base = ["docker", "compose"] + compose_files(rel_dir)
    env = ["--env-file", ENV_FILE] if os.path.exists(ENV_FILE) else []
    log("重建镜像（--no-cache，约 3~4 分钟）…")
    result = sh(base + env + ["build", "--no-cache", "qq-agent"], stream=not quiet)
    if command_rc(result) != 0:
        log(c_err("构建失败"))
        return False
    return True


def start_release(rel_dir, quiet=False):
    """启动预构建的 release，不执行构建。"""
    release_sha(rel_dir)
    base = ["docker", "compose"] + compose_files(rel_dir)
    env = ["--env-file", ENV_FILE] if os.path.exists(ENV_FILE) else []
    log("切换容器…")
    result = sh(base + env + ["up", "-d", "--force-recreate", "--no-build",
                              "--pull", "never", "qq-agent"],
                stream=not quiet)
    return command_rc(result) == 0


def rebuild(rel_dir, quiet=False, dry_run=False, sha=None):
    """Build first; dry-run uses an isolated tag and never switches containers."""
    sha = sha or release_sha(rel_dir)
    if dry_run:
        validate_trusted_file(TRUSTED_DOCKERFILE)
        tag = "qq-agent:dryrun-%s-%d" % (sha, int(time.time()))
        result = sh(["docker", "build", "--no-cache", "-f", TRUSTED_DOCKERFILE,
                     "-t", tag, os.path.realpath(rel_dir)], stream=not quiet)
        if command_rc(result) != 0:
            log(c_err("构建失败"))
            return False
        log("dry-run 构建成功（隔离镜像标签 %s）" % tag)
        return True
    return build_release(rel_dir, quiet=quiet)


def wait_healthy(seconds=HEALTH_TIMEOUT, plugin_baseline=None):
    """轮询等待健康，超时返回 False。"""
    deadline = time.time() + seconds
    last = []
    while time.time() < deadline:
        ok, notes = health_check(verbose=False, plugin_baseline=plugin_baseline)
        last = notes
        if ok:
            return True, notes
        time.sleep(6)
    return False, last


# ── 部署记录 ──────────────────────────────────────────────────────────────────
def load_state():
    if not os.path.exists(STATE):
        return {}
    if os.path.islink(STATE):
        raise SystemExit("部署状态文件不能是符号链接")
    try:
        with open(STATE, encoding="utf-8") as fh:
            state = json.load(fh)
    except (OSError, ValueError) as exc:
        raise SystemExit("部署状态文件损坏，拒绝覆盖：%s" % exc)
    if not isinstance(state, dict):
        raise SystemExit("部署状态文件格式无效")
    return state






def prune_releases(keep=KEEP_RELEASES):
    """只保留最近 N 个 release（按目录名排序不可靠，用 mtime）。"""
    if not os.path.isdir(RELEASES):
        return
    entries = []
    for name in os.listdir(RELEASES):
        p = os.path.join(RELEASES, name)
        if os.path.isdir(p):
            entries.append((os.path.getmtime(p), p))
    entries.sort(reverse=True)
    cur = os.path.realpath(CURRENT) if os.path.islink(CURRENT) else ""
    prev = (load_state().get("previous") or {}).get("dir", "")
    for _, p in entries[keep:]:
        if os.path.realpath(p) in (cur, os.path.realpath(prev) if prev else ""):
            continue
        log("清理旧版本 %s" % c_dim(os.path.basename(p)))
        shutil.rmtree(p, ignore_errors=True)


def whoami():
    return os.environ.get("SUDO_USER") or os.environ.get("USER") or "root"


def release_entry_path(entry):
    """Return a validated release directory from a state entry."""
    if not isinstance(entry, dict):
        raise SystemExit("部署记录中的 release 项无效")
    sha = str(entry.get("sha", "")).lower()
    raw_path = entry.get("dir")
    if not re.fullmatch(r"[0-9a-f]{40}", sha) or not isinstance(raw_path, str):
        raise SystemExit("部署记录缺少有效 SHA 或目录")
    path = os.path.abspath(raw_path)
    real = os.path.realpath(path)
    releases_root = os.path.realpath(RELEASES)
    name = os.path.basename(path)
    if (os.path.islink(path) or os.path.dirname(real) != releases_root
            or not re.fullmatch(r"[0-9a-f]{7,40}", name) or not sha.startswith(name)
            or not os.path.isdir(real)):
        raise SystemExit("部署记录指向 releases 之外或不匹配的目录：%s" % raw_path)
    return validate_release_tree(real)


def current_points_to(entry):
    if not entry:
        return not os.path.lexists(CURRENT)
    try:
        expected = release_entry_path(entry)
    except SystemExit:
        return False
    return os.path.islink(CURRENT) and os.path.realpath(CURRENT) == expected


def state_symlink_consistent(state=None):
    state = state if state is not None else load_state()
    return current_points_to(state.get("current"))


def switch_current(rel_dir):
    """Atomically switch current to a validated release directory."""
    release_sha(rel_dir)
    tmp = "%s.tmp.%d.%d" % (CURRENT, os.getpid(), time.time_ns())
    try:
        os.symlink(os.path.realpath(rel_dir), tmp)
        os.replace(tmp, CURRENT)
    finally:
        if os.path.lexists(tmp):
            os.unlink(tmp)


def operation_begin(kind, target_sha, target_dir, before, plugin_baseline):
    state = load_state()
    baseline = {
        "enabled_ids": sorted(plugin_baseline.get("enabled_ids", set())),
        "healthy_enabled_ids": sorted(plugin_baseline.get("healthy_enabled_ids", set())),
        "broken": plugin_baseline.get("broken", 0),
    }
    state["operation"] = {
        "id": "%d-%d" % (int(time.time()), os.getpid()),
        "kind": kind,
        "phase": "building",
        "target_sha": target_sha,
        "target_dir": target_dir,
        "before": {"sha": before.get("sha"), "dir": before.get("dir"),
                   "image": before.get("image")} if before else None,
        "plugin_baseline": baseline,
        "started_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    write_json(STATE, state)


def operation_phase(phase, error=None):
    state = load_state()
    operation = state.get("operation")
    if not isinstance(operation, dict):
        operation = {"kind": "unknown", "target_sha": "", "target_dir": ""}
    operation["phase"] = phase
    operation["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    if error:
        operation["error"] = str(error)[:1000]
    else:
        operation.pop("error", None)
    state["operation"] = operation
    write_json(STATE, state)


def save_state(ref, sha, rel_dir, who, note="", plugin_baseline=None):
    state = load_state()
    old_current = state.get("current")
    baseline = plugin_baseline or {"enabled_ids": set(), "healthy_enabled_ids": set(), "broken": 0}
    entry = {
        "sha": sha,
        "ref": ref,
        "dir": os.path.realpath(rel_dir),
        "image": "qq-agent:sha-" + sha,
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "by": who,
        "note": note,
        "plugin_baseline": {
            "enabled_ids": sorted(baseline.get("enabled_ids", set())),
            "healthy_enabled_ids": sorted(baseline.get("healthy_enabled_ids", set())),
            "broken": baseline.get("broken", 0),
        },
    }
    history = state.get("history") or []
    if not isinstance(history, list):
        raise SystemExit("部署历史格式无效，拒绝覆盖")
    history.append(entry)
    operation = state.get("operation") or {}
    operation.update({"phase": "committed", "updated_at": entry["at"], "actual_dir": entry["dir"]})
    operation.pop("error", None)
    state.update({"current": entry, "previous": old_current,
                  "history": history[-50:], "operation": operation})
    write_json(STATE, state)


def baseline_from_entry(entry):
    raw = (entry or {}).get("plugin_baseline") or {}
    return {"enabled_ids": set(raw.get("enabled_ids", [])),
            "healthy_enabled_ids": set(raw.get("healthy_enabled_ids", [])),
            "broken": raw.get("broken", 0)}


def container_image_status():
    rc, out, err = sh(["docker", "inspect", AGENT_CONTAINER, "--format",
                       "{{.Config.Image}}|{{.Image}}"])
    if rc != 0:
        return None, "容器镜像无法读取：%s" % (err.strip() or "容器不存在")
    parts = out.strip().split("|", 1)
    if len(parts) != 2:
        return None, "docker inspect 返回格式无效"
    return {"configured": parts[0], "id": parts[1]}, ""


def state_consistency(state=None):
    state = state if state is not None else load_state()
    notes = []
    current = state.get("current")
    if not current_points_to(current):
        notes.append("current 软链与部署记录不一致")
    operation = state.get("operation") or {}
    if operation.get("phase") in {
        "building", "switching", "switched", "starting", "health_check",
        "restoring_build", "restoring_switch", "restoring_start", "committing",
    }:
        notes.append("存在未完成事务：%s/%s" % (
            operation.get("kind", "?"), operation.get("phase", "?")))
    if current:
        runtime, why = container_image_status()
        expected = current.get("image")
        if runtime is None:
            notes.append(why)
        elif expected:
            if runtime["configured"] != expected:
                notes.append("容器配置镜像 %s 与记录的 %s 不一致" % (
                    runtime["configured"], expected))
            else:
                rc, image_id, _ = sh(["docker", "image", "inspect", expected,
                                      "--format", "{{.Id}}"])
                if rc != 0 or image_id.strip() != runtime["id"]:
                    notes.append("容器镜像 ID 与当前 SHA 标签指向不一致")
        else:
            log(c_warn("旧部署记录没有镜像标签，无法验证容器镜像版本"))
    return notes


def release_sha_map(state):
    mapping = {}
    entries = list(state.get("history") or [])
    entries.extend([state.get("current"), state.get("previous")])
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        sha = str(entry.get("sha", "")).lower()
        path = entry.get("dir")
        if re.fullmatch(r"[0-9a-f]{40}", sha) and isinstance(path, str):
            mapping[os.path.realpath(path)] = sha
    return mapping


def resolve_rollback_target(target, state):
    """Resolve only a SHA prefix that maps to one direct, non-symlink release."""
    if not re.fullmatch(r"[0-9a-fA-F]{7,40}", target or ""):
        raise SystemExit("回滚目标只能是至少 7 位的十六进制 SHA，不能传路径")
    prefix = target.lower()
    sha_by_path = release_sha_map(state)
    candidates = []
    if not os.path.isdir(RELEASES):
        raise SystemExit("release 目录不存在")
    for name in os.listdir(RELEASES):
        path = os.path.join(RELEASES, name)
        if os.path.islink(path) or not os.path.isdir(path):
            continue
        if not re.fullmatch(r"[0-9a-f]{7,40}", name):
            continue
        real = os.path.realpath(path)
        if os.path.dirname(real) != os.path.realpath(RELEASES):
            continue
        sha = sha_by_path.get(real)
        if not sha and len(name) == 40:
            sha = name
        if sha and sha.startswith(prefix) and sha.startswith(name):
            candidates.append((real, sha))
    unique = {(path, sha) for path, sha in candidates}
    if len(unique) != 1:
        raise SystemExit("回滚目标不存在或匹配不唯一：%s（--list 查看版本）" % target)
    return next(iter(unique))


def restore_before(before, plugin_baseline):
    """Restore the old image and runtime; report success only after health passes."""
    if not before or not before.get("dir"):
        operation_phase("rollback_failed", "没有已知的上一版本可恢复")
        return False
    try:
        old_dir = release_entry_path(before)
        old_sha = str(before["sha"]).lower()
        old_image = before.get("image") or ("qq-agent:sha-" + old_sha)
        if not re.fullmatch(r"qq-agent:[A-Za-z0-9_.-]+", old_image):
            old_image = "qq-agent:sha-" + old_sha
        write_release_compose(old_dir, old_sha, image_tag=old_image)
        rc, _, _ = sh(["docker", "image", "inspect", old_image, "--format", "{{.Id}}"])
        if rc != 0:
            operation_phase("restoring_build")
            if not build_release(old_dir, quiet=True):
                operation_phase("rollback_failed", "上一版本镜像不可用且构建失败")
                return False
        operation_phase("restoring_switch")
        switch_current(old_dir)
        operation_phase("restoring_start")
        if not start_release(old_dir, quiet=True):
            operation_phase("rollback_failed", "上一版本容器启动失败")
            return False
        operation_phase("health_check")
        healthy, _ = wait_healthy(90, plugin_baseline=plugin_baseline)
        if not healthy:
            operation_phase("rollback_failed", "上一版本恢复后健康检查失败")
            return False
        operation_phase("rolled_back")
        return True
    except BaseException as exc:
        try:
            operation_phase("rollback_failed", "恢复异常：%s" % exc)
        except BaseException:
            pass
        return False


def run_transition(kind, ref, sha, rel_dir, before, plugin_baseline):
    release_prefix = release_sha(rel_dir)
    if not sha.startswith(release_prefix):
        raise SystemExit("release 目录 SHA 前缀与目标提交不一致")
    operation_begin(kind, sha, rel_dir, before, plugin_baseline)
    try:
        write_release_compose(rel_dir, sha)
        if not build_release(rel_dir):
            operation_phase("failed", "目标镜像构建失败；current 未切换")
            raise SystemExit("目标镜像构建失败；线上容器未切换")
        operation_phase("switching")
        switch_current(rel_dir)
        operation_phase("switched")
        operation_phase("starting")
        if not start_release(rel_dir):
            reason = "目标容器启动失败"
            restored = restore_before(before, plugin_baseline)
            raise SystemExit("%s；%s" % (reason, "已恢复上一版本" if restored
                                           else "自动恢复失败，需人工介入"))
        operation_phase("health_check")
        healthy, notes = wait_healthy(plugin_baseline=plugin_baseline)
        if not healthy:
            reason = "目标版本健康检查失败：%s" % "; ".join(
                "%s=%s" % (name, why) for name, _, why in notes)
            restored = restore_before(before, plugin_baseline)
            raise SystemExit("%s；%s" % (reason, "已恢复上一版本" if restored
                                           else "自动恢复失败，需人工介入"))
        operation_phase("committing")
        save_state(ref, sha, rel_dir, whoami(),
                   note="rollback" if kind == "rollback" else "",
                   plugin_baseline=plugin_baseline)
        return 0
    except BaseException as exc:
        # Catch SystemExit from commit/state writes and KeyboardInterrupt too. If
        # a failure happened after switching, restore the prior runtime or leave
        # an explicit rollback_failed marker; never report a false success.
        try:
            operation = load_state().get("operation") or {}
            phase = operation.get("phase")
        except BaseException:
            phase = None
        if phase in {"committed", "rolled_back", "rollback_failed", "failed"}:
            raise
        if os.path.islink(CURRENT) and os.path.realpath(CURRENT) == os.path.realpath(rel_dir):
            restored = restore_before(before, plugin_baseline)
            if not restored:
                try:
                    operation_phase("rollback_failed", "异常后自动恢复失败：%s" % exc)
                except BaseException:
                    pass
        else:
            try:
                operation_phase("failed", str(exc))
            except BaseException:
                pass
        raise


def cmd_status():
    state = load_state()
    current = state.get("current")
    if current:
        log("当前部署 : %s  (%s)" % (str(current.get("sha", "?"))[:12],
                                    current.get("ref", "")))
        log("部署时间 : %s；部署人：%s" % (current.get("at"), current.get("by")))
        log("目录     : %s" % current.get("dir"))
    else:
        log(c_warn("没有已提交的部署记录"))
    operation = state.get("operation") or {}
    if operation:
        log("最近事务 : %s / %s%s" % (
            operation.get("kind", "?"), operation.get("phase", "?"),
            ("：" + operation["error"]) if operation.get("error") else ""))
    consistency = state_consistency(state)
    for note in consistency:
        log(c_err("状态不一致：" + note))
    if os.path.islink(CURRENT):
        log("current  : %s" % os.path.realpath(CURRENT))
    baseline = baseline_from_entry(current) if current else None
    healthy, _ = health_check(plugin_baseline=baseline)
    return 0 if not consistency and healthy else 2


def cmd_rollback(target=None):
    validate_deployment_paths(create=True)
    state = load_state()
    if not state_symlink_consistent(state):
        raise SystemExit("部署记录与 current 软链不一致，请先人工核对 --status")
    before = state.get("current") or {}
    baseline = capture_plugin_baseline()
    if target:
        rel_dir, sha = resolve_rollback_target(target, state)
    else:
        previous = state.get("previous")
        if not previous:
            raise SystemExit("没有上一个版本可回滚（--list 查看已保留版本）")
        rel_dir = release_entry_path(previous)
        sha = previous["sha"].lower()
    head("回滚到 %s" % sha[:12])
    if before.get("sha") == sha:
        raise SystemExit("目标已经是当前版本，无需回滚")
    return run_transition("rollback", "rollback:%s" % (target or "previous"),
                          sha, rel_dir, before, baseline)


def prepare_release(ref):
    validate_deployment_paths(create=True)
    sha, short = resolve_ref(ref)
    rel_dir = os.path.join(RELEASES, sha)
    if os.path.lexists(rel_dir):
        if os.path.islink(rel_dir) or not os.path.isdir(rel_dir):
            raise SystemExit("release 目标不是普通目录，拒绝覆盖：%s" % rel_dir)
        if not os.path.isfile(os.path.join(rel_dir, "app", "src", "app.js")):
            raise SystemExit("release 目录不完整，拒绝覆盖：%s" % rel_dir)
        log("复用已有 release 目录 %s" % c_dim(rel_dir))
    else:
        log("从 GitHub 下载…")
        download(sha, rel_dir)
    validate_release_tree(rel_dir)
    log("补丁检查: %s" % ensure_bind_patch(rel_dir))
    verify(rel_dir)
    return sha, short, rel_dir


def cmd_deploy(ref, dry_run=False):
    validate_deployment_paths(create=True)
    state = load_state()
    before = state.get("current") or {}
    if not state_symlink_consistent(state):
        raise SystemExit("部署记录与 current 软链不一致，请先人工核对 --status")
    if not before and not dry_run:
        running, _ = container_up()
        if running:
            raise SystemExit(
                "检测到已有 qq-agent 正在运行，但没有可信部署记录。为避免切换到空挂载或失去回退基线，"
                "正式部署已拒绝；请先备份并核实现有挂载、建立可信回退基线后再接管。"
            )
    head("部署 %s%s" % (ref, "（dry-run）" if dry_run else ""))
    sha, short, rel_dir = prepare_release(ref)
    log("提交: %s" % sha)
    if before.get("sha") == sha and not dry_run:
        inconsistencies = state_consistency(state)
        if inconsistencies:
            raise SystemExit("当前版本状态异常：%s" % "; ".join(inconsistencies))
        log(c_warn("当前已经部署该提交，无需重建。"))
        return 0
    write_release_compose(rel_dir, sha)
    if dry_run:
        if not rebuild(rel_dir, dry_run=True, sha=sha):
            raise SystemExit("dry-run 构建失败（线上未受影响）")
        log(c_ok("dry-run 通过：线上 current、容器和部署记录均未修改"))
        return 0
    baseline = capture_plugin_baseline()
    run_transition("deploy", ref, sha, rel_dir, before, baseline)
    prune_releases()
    log(c_ok("部署成功：%s (%s)" % (short, ref)))
    return 0


def cmd_logs(container):
    result = sh(["docker", "logs", "--tail", "100", container], stream=True)
    return command_rc(result)


def cmd_restart_napcat():
    result = sh(["docker", "restart", "napcat"], stream=True)
    if command_rc(result) != 0:
        log(c_err("NapCat 重启失败"))
        return command_rc(result)
    log(c_ok("NapCat 已重启"))
    return 0


@contextlib.contextmanager
def deployment_lock():
    validate_deployment_paths(create=True)
    flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(LOCK, flags, 0o600)
    lock_info = os.fstat(fd)
    if (not stat.S_ISREG(lock_info.st_mode)
            or (os.name != "nt" and (lock_info.st_uid != 0
                                     or lock_info.st_mode & 0o022
                                     or lock_info.st_nlink != 1))):
        os.close(fd)
        raise SystemExit("部署锁必须是 root 拥有且不可被组/其他用户写入的普通文件")
    lock = os.fdopen(fd, "r+")
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit(
                "另一个部署或重启操作正在进行中（锁 %s 被占用）。" % LOCK)
        lock.seek(0)
        lock.truncate()
        lock.write("%s %s\n" % (whoami(), time.strftime("%Y-%m-%d %H:%M:%S")))
        lock.flush()
        yield
    finally:
        lock.close()


# ── 子命令 ────────────────────────────────────────────────────────────────────


def cmd_list():
    st = load_state()
    cur = (st.get("current") or {}).get("sha", "")
    hist = st.get("history") or []
    if not hist:
        log("（无部署历史）")
        return 0
    for e in reversed(hist):
        mark = c_ok("← 当前") if e["sha"] == cur else ""
        log("%s  %-10s %s  by %-8s %s" % (
            e["sha"][:12], e.get("ref", "")[:10], e.get("at", ""), e.get("by", ""), mark))
    log("")
    log("磁盘上的 release 目录：")
    if os.path.isdir(RELEASES):
        for name in sorted(os.listdir(RELEASES)):
            p = os.path.join(RELEASES, name)
            if os.path.isdir(p):
                sz = sum(os.path.getsize(os.path.join(r, f))
                         for r, _, fs in os.walk(p) for f in fs) / 1048576
                log("  %-14s %6.1f MB" % (name, sz))
    return 0






def main():
    ap = argparse.ArgumentParser(
        prog="qqdeploy",
        description="把 GitHub 仓库的分支/提交部署到本机（QQ Agent）")
    ap.add_argument("ref", nargs="?", help="分支名或 commit sha")
    ap.add_argument("--status", action="store_true", help="看当前部署状态")
    ap.add_argument("--list", action="store_true", help="列出历史与保留的版本")
    ap.add_argument("--dry-run", action="store_true",
                    help="演练：下载+校验+构建镜像，但不切换容器、不写部署记录")
    ap.add_argument("--rollback", nargs="?", const="", metavar="SHA",
                    help="回滚（默认回到上一个部署过的版本）")
    ap.add_argument("--logs", choices=("qq-agent", "napcat"),
                    help="查看固定容器最近 100 行日志")
    ap.add_argument("--restart-napcat", action="store_true",
                    help="重启固定容器 napcat（使用部署锁）")
    args = ap.parse_args()

    if os.geteuid() != 0:
        raise SystemExit("需要 root：请用 sudo qqdeploy ...")
    selected = [bool(args.status), bool(args.list), args.rollback is not None,
                args.logs is not None, bool(args.restart_napcat), bool(args.ref)]
    if sum(selected) > 1 or (args.dry_run and not args.ref):
        ap.error("每次只允许一个操作；--dry-run 必须与 ref 一起使用")
    if not any(selected):
        ap.print_help()
        return 1

    if args.status:
        return cmd_status()
    if args.list:
        return cmd_list()
    if args.logs is not None:
        return cmd_logs(args.logs)

    if args.ref:
        configure_repository()
        if not load_state().get("current"):
            live = detect_live_project()
            if live and live != COMPOSE_PROJECT:
                globals()["COMPOSE_PROJECT"] = live
                log("检测到线上容器属于 compose 项目 %r，本次按该项目接管" % live)
    with deployment_lock():
        if args.restart_napcat:
            return cmd_restart_napcat()
        if args.rollback is not None:
            return cmd_rollback(args.rollback or None)
        return cmd_deploy(args.ref, dry_run=args.dry_run)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n已取消")
        sys.exit(130)

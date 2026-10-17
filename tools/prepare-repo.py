#!/usr/bin/env python3
"""
prepare-repo.py —— 准备要发布到 GitHub 的仓库内容

原则：
  · 只收源码与文档，不收二进制（Electron 运行时、snowluma 的 Node/DLL、node_modules）
  · **绝不收** data/ 下的任何东西（config.json 含明文 API Key、还有聊天存档/记忆/会话记录）
  · 保留上游 MIT LICENSE 与版权声明（这是硬性要求）
  · app/src/app.js 打上"控制台绑定地址可配置"补丁，否则容器里端口映射不通
  · 覆盖 README.md 前先检查有没有未同步的手工改动（见 guard_generated_readme）

用法:
  python tools/prepare-repo.py [输出目录] [--force-readme]

  --force-readme  即使检测到 README 有未同步的手工改动，也照常覆盖
"""

import hashlib
import io
import os
import re
import shutil
import subprocess
import sys

WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(WS, "resources", "app")
OUT = os.path.join(WS, "repo")     # 可被 main() 的命令行参数覆盖

OLD_LISTEN = "server.listen(port, '127.0.0.1', () => {"
NEW_LISTEN = "server.listen(port, process.env.QQ_AGENT_BIND_HOST || '127.0.0.1', () => {"


def read(p):
    with io.open(p, "r", encoding="utf-8") as fh:
        return fh.read()


def write(p, text):
    with io.open(p, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


def copy_tree(src, dst, skip=()):
    """复制目录，跳过指定名字的条目"""
    os.makedirs(dst, exist_ok=True)
    n = 0
    for name in os.listdir(src):
        if name in skip:
            continue
        s = os.path.join(src, name)
        d = os.path.join(dst, name)
        if os.path.isdir(s):
            n += copy_tree(s, d, skip)
        else:
            shutil.copy2(s, d)
            n += 1
    return n


def validate_output_dir(out_dir):
    """生成器只能管理独立输出目录，不能清理源码或运行数据。"""
    output = os.path.realpath(out_dir)
    workspace = os.path.realpath(WS)
    sources = [os.path.realpath(APP), os.path.join(workspace, "tools"),
               os.path.join(workspace, "deploy")]

    def contains(parent, child):
        try:
            return os.path.commonpath([parent, child]) == parent
        except ValueError:  # Windows 上位于不同盘符
            return False

    if contains(output, workspace):
        raise ValueError("输出目录不能是工作区本身或其父目录")
    for source in sources:
        if contains(output, source) or contains(source, output):
            raise ValueError("输出目录不能与源码目录重叠：%s" % source)
    for entry in ["data", "plugins", "skills", "napcat", ".env",
                  "app/data", "app/plugins", "app/skills", "deploy/data",
                  "deploy/plugins", "deploy/napcat", "deploy/.env"]:
        if os.path.lexists(os.path.join(output, *entry.split("/"))):
            raise ValueError("输出目录含运行数据，拒绝清理：%s" % entry)
    return output


def clean_generated_output(out_dir, preserve_readme=False):
    """仅清理本工具拥有的产物；协作文档、Git 元数据及未知文件原样保留。"""
    managed = {"app", "tools", "deploy", ".gitignore", ".gitattributes",
               "persona-deepseek-xiaojingyu.md",
               "persona-xiaoruan-software-association.md"}
    if not preserve_readme:
        managed.add("README.md")
    output = validate_output_dir(out_dir)
    for name in sorted(managed):
        target = os.path.join(output, name)
        if not os.path.lexists(target):
            continue
        if os.path.islink(target):
            os.unlink(target)
        elif os.path.isdir(target):
            # name 来自固定清单，且输出已校验为独立目录。
            if os.path.commonpath([output, os.path.realpath(target)]) != output:
                raise ValueError("生成目标越出输出目录：%s" % target)
            shutil.rmtree(target)
        else:
            os.remove(target)


def read_text(p):
    with io.open(p, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read()


def _git(repo, *args):
    """跑一条 git 命令，返回 (returncode, stdout, stderr)。git 不可用时返回 None。"""
    try:
        p = subprocess.run(["git", "-C", repo] + list(args),
                           capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        return p.returncode, p.stdout or "", p.stderr or ""
    except FileNotFoundError:
        return None


def _first_diff(a, b, name_a="模板", name_b="README", limit=8):
    """给出两份文本前几处差异的紧凑摘要，供用户判断要不要同步。"""
    la, lb = a.splitlines(), b.splitlines()
    out, shown = [], 0
    for i in range(max(len(la), len(lb))):
        x = la[i] if i < len(la) else "<无此行>"
        y = lb[i] if i < len(lb) else "<无此行>"
        if x != y:
            out.append("      第 %d 行:" % (i + 1))
            out.append("        %s: %s" % (name_a, x[:110]))
            out.append("        %s: %s" % (name_b, y[:110]))
            shown += 1
            if shown >= limit:
                out.append("      …（只显示前 %d 处）" % limit)
                break
    return "\n".join(out)


def _norm(s):
    """比较用归一化：忽略行尾空白与 CRLF，避免换行/空格差异造成误判。"""
    return "\n".join(line.rstrip() for line in s.replace("\r\n", "\n").split("\n")).strip()


# 生成物里嵌入的来源标记。它记录"这份 README 是从哪个版本的模板生成的"。
# 有了它，守卫就能区分两种完全不同的情况：
#   · 标记 == 当前模板哈希 且 内容不同  → README 被手改了      → 拦住
#   · 正文仍匹配旧生成指纹、模板哈希改变 → 模板被编辑了（正常）→ 放行
#   · 正文不匹配自己的生成指纹 → 手工改动，即使模板也变化仍保护
# 没有这个标记就只能靠"两者是否相同"判断，会把"模板正常前进"也误拦。
GENERATED_MARKER_FMT = "<!-- generated-from: tools/repo-readme.md sha256:{hash} -->"
GENERATED_MARKER_RE = re.compile(
    r"<!--\s*generated-from:\s*tools/repo-readme\.md\s+sha256:([0-9a-f]{64})\s*-->")


def template_hash(text):
    """模板内容的指纹（归一化后计算，避免换行风格影响）。"""
    return hashlib.sha256(_norm(text).encode("utf-8")).hexdigest()


def marker_hash_of(text):
    """取出生成物里记录的上游模板哈希；没有标记返回 None。"""
    m = GENERATED_MARKER_RE.search(text)
    return m.group(1) if m else None


def strip_marker(text):
    """
    去掉生成物开头的来源标记行，留下"正文"。

    ⚠️ 比对模板与生成物时**必须**先剥掉这行 —— 模板本身不带标记。
    忘了剥的后果很隐蔽：两者永远判为"内容不同"，于是守卫每次都误判成
    "有人手改了 README"，把整次生成拦下来（连与 README 无关的文件都不再写出）。
    """
    if not text:
        return text
    lines = text.split("\n")
    if lines and GENERATED_MARKER_RE.search(lines[0]):
        return "\n".join(lines[1:])
    return text


def render_readme(template_text):
    """模板 → 生成物：在开头插入来源标记（模板自身不带标记）。"""
    return GENERATED_MARKER_FMT.format(hash=template_hash(template_text)) + "\n" + template_text


def guard_generated_readme(out_dir, template_path, force=False):
    """
    覆盖 README.md 之前的手工改动守卫。

    背景：本仓库的 README.md 是从 tools/repo-readme.md **生成**的。
    直接改 GitHub 网页上的 README.md（或在本地改 README.md 而不改模板）时，
    下一次生成会把这些手改**静默覆盖掉** —— 真实发生过一次。

    三层检测（只要有任意一层判定"有未同步的手工改动"就拦下来）：
      1) 未提交改动：`git diff --quiet -- README.md` 非 0 → 工作区里的 README 有手改
      2) 已提交但没回写模板：`git show HEAD:README.md` != 当前模板内容
         （网页端编辑会落在这一层：它改了 README 却没动模板）
      3) 连 git 都没有（没提交过 / 不是仓库）时：直接比对磁盘上的 README 与模板

    Args:
        out_dir:       输出目录（含 README.md 与 .git）
        template_path: tools/repo-readme.md 的路径
        force:          True 时即使检测到也照常覆盖（--force-readme）

    Returns:
        (ok, action, snapshot)
          ok       False 表示保护 README；调用方可继续生成其它产物
          action   给日志用的一句话
          snapshot (模板文本, 磁盘上的 README 文本)；README 不存在时为 None。
                   调用方**必须**用返回值里的快照，别在清理目录之后再读磁盘 ——
                   那时 README.md 可能已经被删了。
    """
    readme = os.path.join(out_dir, "README.md")
    if not os.path.exists(readme):
        return True, "首次生成（输出目录里没有 README.md）", None
    if not os.path.exists(template_path):
        return False, "模板不存在，拒绝覆盖已有 README", None

    tmpl_text = read_text(template_path)
    disk_text = read_text(readme)
    disk_body = strip_marker(disk_text)   # 剥掉来源标记行再比内容
    snapshot = (tmpl_text, disk_text)

    # 内容等价（忽略行尾空白/换行风格）→ 无事可做
    if _norm(tmpl_text) == _norm(disk_body):
        return True, "模板与已生成内容一致", snapshot

    if force:
        return True, "已指定 --force-readme，强制覆盖", snapshot

    # ── 判定方向（关键）──
    # 生成物开头带 `<!-- generated-from: ... sha256:H -->`，H = 生成它的那版模板的指纹。
    #   · H == 当前模板指纹 且内容不同 → README 被手改了        → 拦住
    #   · H != 当前模板指纹 且内容不同 → 模板被编辑了（正常开发）→ 放行
    tmpl_h = template_hash(tmpl_text)
    marker_h = marker_hash_of(disk_text)

    if (marker_h is not None and marker_h != tmpl_h
            and template_hash(disk_body) == marker_h):
        return True, ("模板已更新（指纹 %s… → %s…），README 重新生成"
                      % (marker_h[:8], tmpl_h[:8])), snapshot

    findings = []

    if marker_h is not None:
        # 先核实正文仍与它自己的生成指纹相符；模板和正文同时被编辑也须保护。
        findings.append(
            "  [A] 现有 README.md 的正文与其生成指纹不一致，"
            "且**内容与当前模板不同**。\n"
            "      说明有人直接改了 README.md 而不是模板。")
    else:
        # 无来源标记（旧生成物 / 别人 clone 的）→ 退回比对提交历史的旧判据
        if os.path.isdir(os.path.join(out_dir, ".git")):
            r = _git(out_dir, "diff", "--quiet", "--", "README.md")
            if r is not None and r[0] not in (0, None):
                findings.append(
                    "  [1] README.md 有**未提交**的改动 —— 工作区版本与最后一次提交不同。")
            r2 = _git(out_dir, "show", "HEAD:README.md")
            if r2 is not None and r2[0] == 0 and _norm(r2[1]) != _norm(tmpl_text):
                findings.append(
                    "  [2] 最后一次提交里的 README.md 与当前模板**不一致**。")
        if not findings:
            findings.append("  [3] README 无生成指纹且正文不同，无法证明没有手工修改，保留原文件。")

    if not findings:
        return True, "未检出未同步的手工改动", snapshot

    print("\n" + "!" * 68)
    print("!!  已阻止覆盖 README.md —— 检测到直接改生成物的痕迹")
    print("!" * 68)
    for f in findings:
        print(f)

    print("\n  模板(tools/repo-readme.md) 与 现有 README.md 的差异:")
    print(_first_diff(tmpl_text, disk_text, name_b="README"))

    print("""
  怎么处理（二选一）:
    A) 把改动同步回模板（推荐，改动会保留）
         在 tools/repo-readme.md 里做同样的修改，然后重新运行本脚本
    B) 确认这些改动可以丢弃，强制覆盖
         python tools/prepare-repo.py --force-readme

  注意：README.md 是生成物（开头那行 generated-from 标记就是证据），
       直接改它没有意义 —— 请改模板。
""")
    return False, "检测到手工或来源不明内容，README 已保护（未覆盖）", snapshot


def main():
    force_readme = "--force-readme" in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    out_dir = args[0] if args else os.path.join(WS, "repo")
    global OUT
    OUT = out_dir

    try:
        OUT = validate_output_dir(OUT)
    except ValueError as error:
        print("输出目录校验失败：%s" % error)
        return 1

    if not os.path.isdir(APP):
        print("找不到应用目录: %s" % APP)
        return 1

    print("=== 0. 安全检查：确认不碰 data 与二进制 ===")
    data_dir = os.path.join(WS, "data")
    if os.path.isdir(data_dir):
        print("   ✅ 已确认 data/ 不在收集范围内（含 API Key 与聊天记录）")

    # ── 0b. README 守卫：必须在"清理旧内容"之前跑 ──
    # 因为清理会把输出目录里的 README.md 删掉，之后就没法比对"手工改动"了。
    # 这里先把待比较的内容读进内存，清理完再交给 5c 段使用。
    #
    # ⚠️ 守卫被触发时**只跳过 README**，其余文件照常生成 ——
    #    早期版本是直接 return，结果连与 README 无关的改动（比如测试脚本）都不再写出，
    #    排查起来很绕。最后统一以非 0 退出码提示"README 没写"。
    here = os.path.dirname(os.path.abspath(__file__))
    tmpl = os.path.join(here, "repo-readme.md")
    readme_snapshot = None          # (模板文本, 磁盘上的 README 文本) 或 None
    readme_blocked = False
    if os.path.exists(tmpl):
        ok, why, snapshot = guard_generated_readme(OUT, tmpl, force=force_readme)
        readme_snapshot = snapshot
        if not ok:
            readme_blocked = True
        print("   README 守卫: %s" % why)
    else:
        print("   ⚠️ 找不到 tools/repo-readme.md，README 将不生成")
        readme_blocked = True

    if os.path.isdir(OUT):
        print("   清理生成内容（保留协作文档与受保护 README）: %s" % OUT)
        clean_generated_output(OUT, preserve_readme=readme_blocked)
    os.makedirs(OUT, exist_ok=True)

    # ── 1. 应用源码（跳过 snowluma / node_modules / electron） ──
    print("\n=== 1. 收集应用源码 ===")
    app_out = os.path.join(OUT, "app")
    os.makedirs(app_out, exist_ok=True)
    for item in ["src", "ui", "assets"]:
        s = os.path.join(APP, item)
        if os.path.isdir(s):
            n = copy_tree(s, os.path.join(app_out, item))
            print("   %-8s %d 个文件" % (item + "/", n))
    for f in ["package.json", "README.md", "LICENSE", "启动QQ机器人.bat"]:
        s = os.path.join(APP, f)
        if os.path.exists(s):
            shutil.copy2(s, os.path.join(app_out, f))
            print("   %-14s %d 字节" % (f, os.path.getsize(s)))

    # ── 2. app.js 绑定地址补丁（容器部署必需） ──
    print("\n=== 2. app/src/app.js 绑定地址补丁 ===")
    appjs = os.path.join(app_out, "src", "app.js")
    t = read(appjs)
    if "QQ_AGENT_BIND_HOST" in t:
        print("   ⚠️ 已含补丁")
    elif t.count(OLD_LISTEN) == 1:
        write(appjs, t.replace(OLD_LISTEN, NEW_LISTEN, 1))
        print("   ✅ 已应用（容器里监听 0.0.0.0，宿主机端口映射才通）")
    else:
        print("   ❌ 锚点不唯一（出现 %d 次），中止" % t.count(OLD_LISTEN))
        return 2

    # ── 3. 我自己的工具与文档 ──
    print("\n=== 3. 收集自研工具与文档 ===")
    tools_out = os.path.join(OUT, "tools")
    n = copy_tree(os.path.join(WS, "tools"), tools_out, skip=("__pycache__",))
    print("   tools/  %d 个文件（已跳过 __pycache__）" % n)

    # 交付物源码也要进仓库（prepare-repo 自己刚才还没被复制进去，补一次）
    me = os.path.abspath(__file__)
    dst_me = os.path.join(tools_out, os.path.basename(me))
    if not os.path.exists(dst_me):
        shutil.copy2(me, dst_me)
        print("   补入 %s" % os.path.basename(me))

    for f in ["persona-deepseek-xiaojingyu.md", "persona-xiaoruan-software-association.md"]:
        s = os.path.join(WS, f)
        if os.path.exists(s):
            shutil.copy2(s, os.path.join(OUT, f))
            print("   %s  %d 字节" % (f, os.path.getsize(s)))

    # 首次生成时带上协作规范；已有副本由贡献者维护，不覆盖其手工修改。
    for f in ["AGENTS.md", "CODING_STANDARDS.md"]:
        source = os.path.join(WS, f)
        target = os.path.join(OUT, f)
        if os.path.isfile(source) and not os.path.exists(target):
            shutil.copy2(source, target)

    # ── 4. 部署配置（compose + Dockerfile） ──
    print("\n=== 4. 生成部署配置 ===")
    deploy = os.path.join(OUT, "deploy")
    os.makedirs(deploy, exist_ok=True)

    # Dockerfile：从 app 目录构建
    dockerfile = """# QQ Agent 无头容器镜像
#
# 构建上下文 = 仓库根目录（因为要 COPY app/ 下的源码）
#   docker build -f deploy/Dockerfile -t qq-agent:local .
#
# 说明：src/app.js 在入仓前已打补丁读 QQ_AGENT_BIND_HOST，
#      容器里必须监听 0.0.0.0 才能让宿主机的端口映射生效。
FROM node:22-slim

WORKDIR /app

# 依赖层单独缓存（本项目生产依赖只有三个纯 JS 包，无原生编译）
COPY app/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# 应用本体
COPY app/src/ ./src/
COPY app/ui/ ./ui/
COPY app/assets/ ./assets/
COPY app/README.md ./

ENV QQ_AGENT_DATA_DIR=/app/data
ENV QQ_AGENT_BIND_HOST=0.0.0.0
RUN mkdir -p /app/data

EXPOSE 3210

# 无头入口（不带 Electron 窗口，控制台走浏览器）
CMD ["node", "src/server.js"]
"""
    write(os.path.join(deploy, "Dockerfile"), dockerfile)
    print("   deploy/Dockerfile")

    compose = """# QQ Agent + NapCat 容器编排
#
#   启动：docker compose -f deploy/docker-compose.yml up -d
#   日志：docker compose -f deploy/docker-compose.yml logs -f
#   停止：docker compose -f deploy/docker-compose.yml down
#
# ⚠️ 所有端口只绑 127.0.0.1：控制台与 WebUI 一律走 SSH 隧道访问，不暴露公网。
# ⚠️ 两个数据/插件目录必须保留挂载，否则重建容器会丢配置与插件：
#      data/    配置、聊天存档、记忆、会话记录、用量、插件数据
#      plugins/ 市场口令安装的插件本体（放在容器可写层里会在重建时丢失）
services:

  # ── 协议端：NapCat（官方镜像，负责登 QQ 并提供 OneBot v11）──
  napcat:
    image: mlikiowa/napcat-docker:latest
    container_name: napcat
    restart: always
    environment:
      - NAPCAT_UID=${NAPCAT_UID:-1000}
      - NAPCAT_GID=${NAPCAT_GID:-1000}
      - WEBUI_TOKEN=${WEBUI_TOKEN:-change-me}
      - ACCOUNT=${QQ_ACCOUNT:-}
    ports:
      - 127.0.0.1:3000:3000     # OneBot HTTP API
      - 127.0.0.1:3001:3001     # OneBot 正向 WebSocket（本项目主要用这个）
      - 127.0.0.1:6099:6099     # NapCat WebUI（扫码登录、网络配置）
    volumes:
      - ./napcat/config:/app/napcat/config
      - ./napcat/QQ:/app/.config/QQ     # 登录态；不挂会每次重启都要重扫
    shm_size: 256m                      # QQ 客户端是 Chromium 内核，64M 会崩
    networks: [qqnet]

  # ── 大脑：QQ Agent ──
  qq-agent:
    build:
      context: ..
      dockerfile: deploy/Dockerfile
    image: qq-agent:local
    container_name: qq-agent
    restart: always
    depends_on: [napcat]
    environment:
      - TZ=Asia/Shanghai
      - NODE_ENV=production
      - QQ_AGENT_DATA_DIR=/app/data
    ports:
      - 127.0.0.1:3210:3210     # 会话式控制台
    volumes:
      - ./data:/app/data
      - ./plugins:/app/plugins
    networks: [qqnet]

networks:
  qqnet:
    driver: bridge
"""
    write(os.path.join(deploy, "docker-compose.yml"), compose)
    print("   deploy/docker-compose.yml")

    # ── 4a. .env 模板（compose 靠它取 UID/GID 与凭据）──
    # 没有这个文件，拿到仓库的人会卡在"docker-compose.yml 里引用的变量是什么"。
    env_example = """# QQ Agent 部署变量 —— 复制成 .env 后填写
#   cp deploy/.env.example deploy/.env && 编辑它
# .env **必须留在服务器上、不要提交**（.gitignore 已排除；它含 WebUI 口令）。

# ── NapCat 容器 ──
# 容器内进程的 UID/GID。用 `id -u` / `id -g` 查当前用户；
# root 用户是 0 0。写错会导致 napcat/QQ 目录权限不对、登不上。
NAPCAT_UID=1000
NAPCAT_GID=1000

# NapCat WebUI 的访问口令（登录 WebUI 改配置/扫码都要它）。
# 自己生成一个随机串，别用示例值：
#   openssl rand -hex 20
# 注意：换这个值后，napcat 容器要重建才生效；
#      napcat-guard.sh 会从本文件读取，不用改脚本。
WEBUI_TOKEN=change-me-to-a-random-string

# ── 机器人账号 ──
# 要登录的 QQ 号。留空则 NapCat 启动后停在扫码页，先扫码也行。
QQ_ACCOUNT=
"""
    write(os.path.join(deploy, ".env.example"), env_example)
    print("   deploy/.env.example")

    # ── 4b. 运维脚本（已脱敏：凭据从 .env 读，不写死在文件里） ──
    print("\n=== 4b. 收集运维脚本 ===")
    # 仓库内维护的版本优先，避免外部旧快照重新引入已修复的问题。
    ops_src = os.path.join(WS, "deploy", "ops")
    sysd_src = os.path.join(WS, "deploy", "systemd")
    if not os.path.isdir(ops_src):
        ops_src = os.path.join(WS, "ops-sanitized", "ops-sanitized")
        sysd_src = os.path.join(ops_src, "systemd")
    if os.path.isdir(ops_src):
        ops_out = os.path.join(deploy, "ops")
        sysd_out = os.path.join(deploy, "systemd")
        os.makedirs(ops_out, exist_ok=True)
        os.makedirs(sysd_out, exist_ok=True)
        for f in ["napcat-guard.sh", "qr-server.py"]:
            s = os.path.join(ops_src, f)
            if os.path.exists(s):
                shutil.copy2(s, os.path.join(ops_out, f))
                print("   deploy/ops/%s" % f)
        for f in ["napcat-guard.service", "napcat-guard.timer", "qr-server.service"]:
            s = os.path.join(sysd_src, f)
            if os.path.exists(s):
                shutil.copy2(s, os.path.join(sysd_out, f))
                print("   deploy/systemd/%s" % f)
    else:
        print("   ⚠️ 找不到 %s，跳过运维脚本" % ops_src)
        print("      （先在服务器上跑 tools/ops-sanitize.py 生成脱敏版）")

    # ── 5. .gitignore ──
    print("\n=== 5. 写 .gitignore ===")
    gitignore = """# ── 运行时数据：绝不能入库 ──
# data/ 含明文 API Key（config.json）、聊天存档、群友记忆、会话记录
data/
napcat/
plugins/
*.lock

# ── 二进制与依赖 ──
node_modules/
app/snowluma/
*.exe
*.dll
*.node
*.pak
*.bin
*.dat
*.tar.gz
locales/

# ── 个人信息 ──
.env
*.pem
*.key
config.json

# ── 编辑器/系统 ──
.vscode/
.idea/
.DS_Store
Thumbs.db
__pycache__/
"""
    write(os.path.join(OUT, ".gitignore"), gitignore)
    print("   .gitignore（已排除 data/、二进制、密钥）")

    # ── 5b. .gitattributes：强制 LF ──
    # 本仓库的脚本要传进 Linux 容器执行，若被 Windows 的 core.autocrlf 改成 CRLF，
    # 远端会报 $'\r': command not found。
    gitattributes = """# 一律用 LF 入库（脚本要传进 Linux 容器执行）
* text=auto eol=lf

# Windows 批处理必须是 CRLF（cmd.exe 对 LF 结尾的标签跳转有已知问题）
*.bat text eol=crlf
*.cmd text eol=crlf

# 二进制：避免 Git 做换行转换与文本 diff
*.png binary
*.jpg binary
*.jpeg binary
*.gif binary
*.webp binary
*.ico binary
*.woff binary
*.woff2 binary
*.ttf binary
*.otf binary
*.zip binary
*.gz binary
"""
    write(os.path.join(OUT, ".gitattributes"), gitattributes)
    print("   .gitattributes（强制 LF，.bat 用 CRLF）")

    # ── 5c. README（守卫已在第 0b 步跑过，这里只落盘）──
    # 与源码一起生成，避免"重新生成内容时把文档删掉"这类事故。
    # README 同时也是**人手会改**的文件（网页端编辑过），所以覆盖前的检查
    # 放在清理目录之前（第 0b 步）—— 那时输出目录里还留着上一版 README 可供比对。
    if readme_blocked:
        # 守卫拒绝时清理阶段从未删除 README；中途异常也不依赖恢复步骤。
        if os.path.exists(os.path.join(OUT, "README.md")):
            print("   README.md（保留原有内容，%d 字节 —— 守卫拦下了覆盖）"
                  % os.path.getsize(os.path.join(OUT, "README.md")))
        else:
            print("   ⚠️ README.md 未生成（守卫拦下且无原内容可保留）")
    elif os.path.exists(tmpl):
        # 渲染时在开头插入来源标记（记录本份 README 由哪版模板生成），
        # 守卫下一次据此判断"是模板前进了"还是"README 被手改了"。
        write(os.path.join(OUT, "README.md"), render_readme(read_text(tmpl)))
        extra = ""
        if readme_snapshot:
            tmpl_before, disk_before = readme_snapshot
            if _norm(strip_marker(disk_before)) != _norm(tmpl_before):
                extra = "（原 README %d 字节 → 新 %d 字节，内容已更新）" % (
                    len(disk_before), os.path.getsize(os.path.join(OUT, "README.md")))
            else:
                extra = "（内容无变化）"
        print("   README.md（来自 tools/repo-readme.md，%d 字节%s）"
              % (os.path.getsize(os.path.join(OUT, "README.md")), extra))
    else:
        print("   ⚠️ 找不到 tools/repo-readme.md，README 未生成")

    # ── 6. 汇总 ──
    print("\n=== 6. 汇总 ===")
    total = 0
    for root, dirs, files in os.walk(OUT):
        # 统计交付内容时不算 .git 内部文件（否则会把几万个对象文件算进来）
        dirs[:] = [d for d in dirs if d != ".git"]
        total += len(files)
    print("   输出目录: %s" % OUT)
    print("   交付文件数: %d（不含 .git）" % total)

    # 二次确认：目录里不能出现 data/、API Key、真实服务器地址
    print("\n   === 安全检查 ===")
    bad = []
    # 注意：不要把真实 IP 写在这里当检测模式 —— 这个脚本本身也会入仓。
    # 只按"私网段以外的公网 IPv4 + 明显密钥前缀"做启发式检查。
    # 只按"私网段/特殊地址以外的公网 IPv4 + 明显密钥前缀"做启发式检查。
    # 排除：0.0.0.0（绑定地址）、127.、10.、192.168.、172.16-31.
    ip_re = re.compile(
        r"\b(?!0\.0\.0\.0)(?!127\.)(?!10\.)(?!192\.168\.)(?!172\.(?:1[6-9]|2\d|3[01])\.)"
        r"\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b"
    )
    self_path = os.path.abspath(__file__)
    for root, dirs, files in os.walk(OUT):
        for f in files:
            p = os.path.join(root, f)
            if f == "config.json":
                bad.append(p + " (config.json 不应入仓)")
            if os.path.getsize(p) < 2_000_000:
                try:
                    c = read(p)
                except Exception:
                    continue
                if re.search(r"sk-[a-zA-Z0-9]{20,}", c):
                    bad.append(p + " (含 sk- 密钥)")
                # 检测脚本自己会包含 IP 正则的匹配样例，跳过自身
                if os.path.abspath(p) != self_path:
                    m = ip_re.search(c)
                    if m:
                        bad.append(p + " (疑似公网 IP: %s)" % m.group(0))
    if bad:
        print("   ❌ 发现问题文件:")
        for b in bad:
            print("      " + b.replace(OUT, "."))
        return 3
    print("   ✅ 无 API Key、无公网 IP、无 data/ 内容")

    if readme_blocked:
        print("\n   ⚠️ 注意：README.md 本次**未被覆盖**（守卫拦下了，见上方提示）。")
        print("      其余文件均已正常生成。处理办法见上方 A/B 两条。")
        return 4
    return 0


if __name__ == "__main__":
    sys.exit(main())

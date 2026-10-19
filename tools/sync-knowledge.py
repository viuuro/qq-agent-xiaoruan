#!/usr/bin/env python3
"""
sync-knowledge —— 把仓库里的 knowledge/ 文档同步进机器人的知识库

为什么需要这一步：
  代码走 qqdeploy 部署（releases/<sha>/），而知识库是**数据**，在
  /opt/qq/qq-agent-data/knowledge-base/ —— 两者是分开的挂载，部署不会自动带过去。
  所以：改完 knowledge/ 并部署后，跑一次本脚本，文档才会被索引。

设计：
  · 源 = 当前部署版本里的 knowledge/（即 /opt/qq/current/knowledge/），
    这样"仓库里是什么，知识库里就是什么"，不会各存一份。
  · 只同步 .md / .txt / .markdown，跳过 learned/（那是机器人自动学的，别覆盖）。
  · 幂等：内容一致的文件不重写（避免无谓触发重索引）。
  · 删除了仓库里的文档时**不会**自动删知识库里的 —— 删除请显式指定 --prune。

用法（需要 root）：
    sudo sync-knowledge              # 同步
    sudo sync-knowledge --dry-run    # 只看会做什么
    sudo sync-knowledge --prune      # 顺便删掉知识库里多余的人工文档
    sudo sync-knowledge --status     # 看知识库现状
"""

import argparse
import filecmp
import hashlib
import json
import os
import shutil
import sys

ROOT = "/opt/qq"
CURRENT = os.path.join(ROOT, "current")
KB_DIR = os.path.join(ROOT, "qq-agent-data", "knowledge-base")
LEARNED = os.path.join(KB_DIR, "learned")
INDEX = os.path.join(KB_DIR, ".index.json")
TEXT_EXT = (".md", ".markdown", ".txt")


def c_ok(t): return "\033[32m%s\033[0m" % t
def c_warn(t): return "\033[33m%s\033[0m" % t
def c_err(t): return "\033[31m%s\033[0m" % t
def c_dim(t): return "\033[2m%s\033[0m" % t


def log(m):
    print("  " + m, flush=True)


def head(m):
    print("\n" + "=" * 58)
    print("  " + m)
    print("=" * 58, flush=True)


def source_dir():
    """当前部署版本里的 knowledge/ 目录。"""
    p = os.path.join(os.path.realpath(CURRENT) if os.path.islink(CURRENT) else CURRENT,
                     "knowledge")
    return p


def list_docs(d):
    out = []
    if not os.path.isdir(d):
        return out
    for name in sorted(os.listdir(d)):
        f = os.path.join(d, name)
        if os.path.isfile(f) and name.lower().endswith(TEXT_EXT):
            out.append(name)
    return out


def md5(p):
    h = hashlib.md5()
    with open(p, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def index_summary():
    try:
        with open(INDEX, encoding="utf-8") as fh:
            d = json.load(fh)
        return {
            "docs": len(d.get("docs") or []),
            "sections": d.get("sections", "?"),
            "builtAt": d.get("builtAt"),
        }
    except Exception:
        return None


def cmd_status():
    head("知识库现状")
    log("知识库目录: %s" % KB_DIR)
    log("索引文件  : %s" % (c_ok("存在") if os.path.exists(INDEX) else c_err("缺失")))
    s = index_summary()
    if s:
        import time
        bt = s["builtAt"]
        ts = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(bt / 1000)) if bt else "?"
        log("已索引    : %s 个文档 / %s 段（建于 %s）" % (s["docs"], s["sections"], ts))
    else:
        log(c_warn("索引读不出来"))

    docs = list_docs(KB_DIR)
    learned = list_docs(LEARNED) if os.path.isdir(LEARNED) else []
    log("人工文档  : %d 个（知识库根目录）" % len(docs))
    for n in docs:
        log("    " + n)
    log("自动学习  : %d 个（learned/）" % len(learned))

    src = source_dir()
    log("")
    log("仓库来源  : %s" % src)
    if os.path.isdir(src):
        sdocs = list_docs(src)
        log("            %d 个文档" % len(sdocs))
        # 对比差异
        only_disk = [n for n in docs if n not in sdocs]
        only_src = [n for n in sdocs if n not in docs]
        diff = [n for n in sdocs if n in docs and
                not filecmp.cmp(os.path.join(src, n), os.path.join(KB_DIR, n), shallow=False)]
        if only_src:
            log(c_warn("  待同步（仓库有、知识库没有）: %s" % ", ".join(only_src)))
        if diff:
            log(c_warn("  待更新（两边内容不同）      : %s" % ", ".join(diff)))
        if only_disk:
            log(c_warn("  知识库多出（仓库没有）      : %s" % ", ".join(only_disk)))
        if not (only_src or diff):
            log(c_ok("  仓库与知识库的人工文档已一致"))
    else:
        log(c_err("  当前部署里没有 knowledge/ 目录（先 qqdeploy 一次）"))
    return 0


def main():
    ap = argparse.ArgumentParser(
        prog="sync-knowledge",
        description="把当前部署版本 knowledge/ 里的文档同步进机器人知识库")
    ap.add_argument("--dry-run", action="store_true", help="只显示会做什么，不落盘")
    ap.add_argument("--prune", action="store_true",
                    help="同时删除知识库根目录里「仓库已不存在」的人工文档（不动 learned/）")
    ap.add_argument("--status", action="store_true", help="只看知识库现状与差异")
    args = ap.parse_args()

    if os.geteuid() != 0:
        raise SystemExit("需要 root：请用 sudo sync-knowledge ...")

    if args.status:
        return cmd_status()

    src = source_dir()
    head("同步知识库")
    log("来源: %s" % src)
    log("目标: %s" % KB_DIR)

    if not os.path.isdir(src):
        log(c_err("当前部署里没有 knowledge/ 目录。"))
        log("提示：确认仓库里存在 knowledge/ 并且已经 sudo qqdeploy 过。")
        return 2

    os.makedirs(KB_DIR, exist_ok=True)
    sdocs = list_docs(src)
    if not sdocs:
        log(c_warn("来源目录里没有 .md/.txt 文档"))
        return 0

    created, updated, same = [], [], []
    for name in sdocs:
        s = os.path.join(src, name)
        d = os.path.join(KB_DIR, name)
        if not os.path.exists(d):
            created.append(name)
            if not args.dry_run:
                shutil.copy2(s, d)
        elif not filecmp.cmp(s, d, shallow=False):
            updated.append(name)
            if not args.dry_run:
                shutil.copy2(s, d)
        else:
            same.append(name)

    for n in created:
        log(c_ok("+ 新增  %s" % n))
    for n in updated:
        log(c_ok("* 更新  %s" % n))
    if same:
        log(c_dim("= 未变  %d 个" % len(same)))

    pruned = []
    if args.prune:
        for name in list_docs(KB_DIR):
            if name not in sdocs:
                pruned.append(name)
                if not args.dry_run:
                    os.remove(os.path.join(KB_DIR, name))
        for n in pruned:
            log(c_warn("- 删除  %s" % n))

    if args.dry_run:
        log("")
        log(c_warn("dry-run：未写入任何文件"))
        return 0

    if not (created or updated or pruned):
        log("")
        log(c_ok("无需同步（知识库已是最新）"))
        return 0

    # 插件有文件监听，通常会自己重建索引。这里只做提示与等待确认。
    import time
    log("")
    log("已写入 %d 个文件，等待知识库插件重建索引…" % (len(created) + len(updated) + len(pruned)))
    before = index_summary()
    for _ in range(15):
        time.sleep(2)
        now = index_summary()
        if now and before and now.get("builtAt") != before.get("builtAt"):
            break
    s = index_summary()
    if s:
        log("索引现在: %s 个文档 / %s 段" % (s["docs"], s["sections"]))
    log("")
    log(c_ok("同步完成"))
    log("验证：可在群里问「软件部部长是谁」，或跑 sudo qqdeploy --status")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n已取消")
        sys.exit(130)

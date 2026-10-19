#!/usr/bin/env python3
"""
render-readme —— 只从模板渲染 README.md，不动仓库里其它任何文件

为什么单独做一个：
  README.md 是**生成物**（`tools/repo-readme.md` → `README.md`），开头带一行
  `<!-- generated-from: ... sha256:... -->` 记录"由哪版模板生成"。
  于是**两个人同时改模板，合并时 README.md 必然冲突** —— 但冲突内容只是那行指纹，
  正文其实自动合并成功。正确解法不是手工挑冲突，而是：合完模板 → 重新渲染。

  不能直接跑 `tools/prepare-repo.py` 来解决，因为它会把整个仓库从工作区重新生成一遍，
  而合并后的仓库往往已经领先工作区（协作者改的是仓库，不是你的桌面副本）。

用法：
    python tools/render-readme.py --repo <仓库根>          # 渲染
    python tools/render-readme.py --repo <仓库根> --check  # 只检查是否需重新渲染

退出码：0 成功/一致；1 需要重新渲染（--check 模式下）；2 出错。
"""

import argparse
import importlib.util
import os
import sys


def load_prepare_repo(here):
    """复用 prepare-repo.py 里的 render_readme / template_hash / template_hash_of。

    必须复用而不是复制一份：两处算法一旦分叉，指纹就对不上，守卫会开始误判。
    """
    path = os.path.join(here, "prepare-repo.py")
    if not os.path.exists(path):
        raise SystemExit("找不到 %s（本脚本要在 tools/ 目录内运行）" % path)
    spec = importlib.util.spec_from_file_location("prepare_repo", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    ap = argparse.ArgumentParser(description="从 tools/repo-readme.md 渲染 README.md")
    ap.add_argument("--repo", default=None, help="仓库根目录（默认：本脚本的上一层）")
    ap.add_argument("--check", action="store_true",
                    help="只检查 README 是否与模板一致，不写文件")
    args = ap.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.abspath(args.repo) if args.repo else os.path.dirname(here)

    tmpl = os.path.join(here, "repo-readme.md")
    readme = os.path.join(repo, "README.md")

    if not os.path.exists(tmpl):
        print("找不到模板: %s" % tmpl)
        return 2

    pr = load_prepare_repo(here)
    tmpl_text = pr.read_text(tmpl)
    rendered = pr.render_readme(tmpl_text)

    old = pr.read_text(readme) if os.path.exists(readme) else ""
    old_body = pr.strip_marker(old)

    same_body = pr._norm(old_body) == pr._norm(tmpl_text)
    same_marker = pr.marker_hash_of(old) == pr.template_hash(tmpl_text)

    if args.check:
        if same_body and same_marker:
            print("  README.md 与模板一致（指纹 %s…）" % pr.template_hash(tmpl_text)[:8])
            return 0
        if not same_body:
            print("  README.md 正文与模板不一致 —— 需要重新渲染")
        else:
            print("  README.md 正文一致，但指纹过期 —— 需要重新渲染")
        return 1

    if same_body and same_marker:
        print("  README.md 已是最新（正文与指纹都一致），未改动")
        return 0

    pr.write(readme, rendered)
    print("  已渲染 README.md（%d 字节，模板指纹 %s…）"
          % (len(rendered.encode("utf-8")), pr.template_hash(tmpl_text)[:8]))
    if not same_body:
        print("  注：正文有变化（模板内容被改过）")
    else:
        print("  注：正文未变，只更新了指纹行")
    return 0


if __name__ == "__main__":
    sys.exit(main())

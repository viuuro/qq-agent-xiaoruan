#!/usr/bin/env python3
"""检查部署器语法和明显危险调用；行为验证见 test-qqdeploy.py。"""
import argparse
import ast
from pathlib import Path


def inspect_source(source, filename):
    tree = ast.parse(source, filename=filename)
    findings = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if isinstance(node.func, ast.Attribute) and node.func.attr in ("extract", "extractall"):
            filters = {kw.arg: kw.value for kw in node.keywords}
            safe_filter = filters.get("filter")
            if not (isinstance(safe_filter, ast.Constant) and safe_filter.value == "data"):
                findings.append((node.lineno, "归档 extract 缺少 data filter，请改为受限逐项提取"))
        if not (isinstance(node.func, ast.Name) and node.func.id == "sh" and node.args):
            continue
        command = node.args[0]
        if not isinstance(command, (ast.List, ast.Tuple)):
            continue
        literal_args = [item.value for item in command.elts if isinstance(item, ast.Constant)]
        if "python3" in literal_args:
            trusted = any(isinstance(item, ast.Name) and item.id == "TRUSTED_CHECKER"
                          for item in command.elts)
            if not trusted:
                findings.append((node.lineno, "Python 校验必须使用管理员安装的 TRUSTED_CHECKER"))
    return findings, sum(isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                         for node in ast.walk(tree))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", type=Path,
                        default=Path(__file__).resolve().with_name("qqdeploy.py"))
    args = parser.parse_args(argv)
    try:
        source = args.path.read_text(encoding="utf-8-sig")
        findings, functions = inspect_source(source, str(args.path))
    except (OSError, SyntaxError) as error:
        print("自查失败：%s" % error)
        return 1
    print("检查文件：%s" % args.path)
    print("语法通过，函数数量：%d" % functions)
    for line, message in findings:
        print("  第 %d 行：%s" % (line, message))
    if findings:
        return 1
    print("未发现上述危险调用；此检查不代替回滚及权限回归测试。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

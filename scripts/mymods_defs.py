#!/usr/bin/env python3
"""扫描用户自己的工作文件夹，提取其中的 RimWorld Defs。

与 ``workshop_defs.py`` 的区别：这里面对的是**开发工作区**，一个文件夹里可能
有多个模组（各带 ``Defs`` 或 ``<版本>/Defs``），所以递归查找所有名为 ``Defs``
的目录，合并成一个结果；分组粒度是"工作文件夹"而不是单个模组。

用法::

    python scripts/mymods_defs.py extract --dir <工作文件夹> --id <folderId> --out data/mine/<id>.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from lxml import etree

sys.path.insert(0, str(Path(__file__).resolve().parent))

import extract_defs as ed  # noqa: E402 - 复用字段/父链/贴图解析

# 这些目录不可能是 Defs 来源，直接跳过，避免扫到构建产物。
SKIP_DIRS = {
    ".git",
    ".svn",
    ".hg",
    "node_modules",
    "__pycache__",
    "obj",
    "bin",
    ".vs",
    ".idea",
    ".vscode",
}

DEFS_PARSER = etree.XMLParser(recover=False, resolve_entities=False, no_network=True, huge_tree=True)

MAX_DEPTH = 6


def folder_id(path: Path) -> str:
    """由绝对路径生成稳定短 id（迁移文件夹后会变，属于预期）。"""
    normalized = str(path.resolve()).casefold().replace("\\", "/")
    return hashlib.sha1(normalized.encode("utf-8")).hexdigest()[:12]


def find_defs_dirs(root: Path) -> list[Path]:
    """递归找出所有名为 ``Defs`` 的目录（不深入 Defs 内部继续找）。"""
    found: list[Path] = []
    base_depth = len(root.parts)
    for dirpath, dirnames, _ in os.walk(root):
        current = Path(dirpath)
        if len(current.parts) - base_depth > MAX_DEPTH:
            dirnames[:] = []
            continue
        dirnames[:] = [
            name for name in dirnames if name not in SKIP_DIRS and not name.startswith(".")
        ]
        if current.name == "Defs":
            found.append(current)
            dirnames[:] = []
    return sorted(found)


def extract(root: Path, folder: str) -> dict[str, Any]:
    defs: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    defs_dirs = find_defs_dirs(root)
    for defs_dir in defs_dirs:
        for xml_path in sorted(defs_dir.rglob("*.xml")):
            try:
                relative = xml_path.relative_to(root).as_posix()
            except ValueError:
                relative = xml_path.as_posix()
            try:
                tree = etree.parse(str(xml_path), DEFS_PARSER)
            except (etree.XMLSyntaxError, OSError) as exc:
                errors.append({"sourcePath": relative, "error": f"{type(exc).__name__}: {exc}"})
                continue
            for element in ed.iter_def_elements(tree.getroot()):
                defs.append(ed.extract_def(element, f"mine:{folder}", relative))

    ed.canonicalize_def_types(defs)
    ed.resolve_parents(defs)
    ed.resolve_fields(defs)
    ed.resolve_graphics(defs)
    defs.sort(key=lambda record: (record["defType"], record.get("defName") or record.get("Name") or ""))

    return {
        "id": folder,
        "name": root.name,
        "path": str(root),
        "generatedAt": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "defsDirs": [str(item.relative_to(root)).replace("\\", "/") for item in defs_dirs],
        "defs": defs,
        "errors": errors,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="mymods_defs", description="扫描工作文件夹并提取 Defs")
    sub = parser.add_subparsers(dest="command", required=True)
    extract_parser = sub.add_parser("extract", help="提取一个工作文件夹里的 Defs")
    extract_parser.add_argument("--dir", required=True, metavar="DIR")
    extract_parser.add_argument("--id", default=None, metavar="ID")
    extract_parser.add_argument("--out", required=True, metavar="FILE")

    args = parser.parse_args(argv)
    root = Path(args.dir).expanduser().resolve()
    if not root.is_dir():
        print(f"错误：不是目录：{root}", file=sys.stderr)
        return 2

    folder = args.id or folder_id(root)
    payload = extract(root, folder)
    output = Path(args.out).expanduser()
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_name(output.name + ".tmp")
    with temp.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False)
        handle.write("\n")
    temp.replace(output)
    print(f"{root.name}：{len(payload['defs'])} defs（{len(payload['defsDirs'])} 个 Defs 目录），错误 {len(payload['errors'])} → {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

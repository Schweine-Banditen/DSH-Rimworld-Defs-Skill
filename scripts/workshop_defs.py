#!/usr/bin/env python3
"""创意工坊 Def 提取：检测工坊模组、按模组提取 Defs。

设计要点：

- **不主动爬取**：``list`` 只读元数据，``extract`` 必须显式传入 ``--id``；
- 复用 ``extract_defs.py`` 的解析函数，保证字段语义与本体数据一致；
- 版本判定优先用 Steam 的 ``appworkshop_<appid>.acf``（``manifest``/``timeupdated``），
  其次才退回 ``About/About.xml`` 的 ``modVersion`` / ``supportedVersions``；
- 多版本目录（``<mod>/1.7/Defs``）按游戏主版本优先，找不到再取最高的版本目录。

用法::

    python scripts/workshop_defs.py list --json
    python scripts/workshop_defs.py extract --id 1098354593 --out data/workshop/1098354593.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from lxml import etree

sys.path.insert(0, str(Path(__file__).resolve().parent))

import extract_defs as ed  # noqa: E402 - 复用解析函数
import paths  # noqa: E402

# 允许解析残缺 XML（工坊里 About.xml 偶有未转义字符）。
ABOUT_PARSER = etree.XMLParser(recover=True, resolve_entities=False, no_network=True, huge_tree=True)
DEFS_PARSER = etree.XMLParser(recover=False, resolve_entities=False, no_network=True)

# 版本目录形如 1.7 / 1.6；只认这种两级数字。
VERSION_DIR_RE = re.compile(r"^\d+\.\d+$")
# ACF 里每个已安装条目的块。
ACF_ITEM_RE = re.compile(r'"(\d{5,})"\s*\{([^{}]*)\}', re.S)


def read_game_major(game_root: Path | None) -> str | None:
    """从 ``Version.txt`` 取主版本（如 ``1.7.5000 rev1275`` → ``1.7``）。"""
    if game_root is None:
        return None
    try:
        text = (game_root / "Version.txt").read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        return None
    first = text.strip().splitlines()[0].strip() if text.strip() else ""
    match = re.match(r"^(\d+\.\d+)", first)
    return match.group(1) if match else None


def acf_versions(content_dir: Path) -> dict[str, dict[str, str]]:
    """解析 ``appworkshop_<appid>.acf``，返回 ``{modId: {manifest, timeupdated}}``。"""
    acf = content_dir.parent.parent / f"appworkshop_{paths.WORKSHOP_APP_ID}.acf"
    try:
        text = acf.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {}
    versions: dict[str, dict[str, str]] = {}
    for match in ACF_ITEM_RE.finditer(text):
        mod_id, body = match.group(1), match.group(2)
        manifest = re.search(r'"manifest"\s*"(\d+)"', body)
        updated = re.search(r'"timeupdated"\s*"(\d+)"', body)
        if manifest is None and updated is None:
            continue
        versions[mod_id] = {
            "manifest": manifest.group(1) if manifest else "",
            "timeupdated": updated.group(1) if updated else "",
        }
    return versions


def read_about(mod_dir: Path) -> dict[str, Any]:
    """读取 ``About/About.xml``；缺失或损坏时返回空字段而不是抛错。"""
    about_path = mod_dir / "About" / "About.xml"
    result: dict[str, Any] = {
        "name": None,
        "author": None,
        "packageId": None,
        "description": None,
        "modVersion": None,
        "supportedVersions": [],
    }
    if not about_path.is_file():
        return result
    try:
        root = etree.parse(str(about_path), ABOUT_PARSER).getroot()
    except (etree.XMLSyntaxError, OSError):
        return result

    def text_of(tag: str) -> str | None:
        node = root.find(tag)
        if node is None or node.text is None:
            return None
        value = node.text.strip()
        return value or None

    result["name"] = text_of("name")
    result["author"] = text_of("author")
    result["packageId"] = text_of("packageId")
    result["description"] = text_of("description")
    result["modVersion"] = text_of("modVersion")
    node = root.find("supportedVersions")
    if node is not None:
        result["supportedVersions"] = [
            item.text.strip() for item in node.findall("li") if item.text and item.text.strip()
        ]
    return result


def find_preview(mod_dir: Path) -> str | None:
    """返回模组预览图的相对路径（工坊模组通常有 About/Preview.png）。"""
    for relative in ("About/Preview.png", "About/Preview.jpg", "About/preview.png", "preview.png"):
        candidate = mod_dir / relative
        if candidate.is_file():
            return relative
    return None


def resolve_defs_dir(mod_dir: Path, game_major: str | None) -> Path | None:
    """定位 Defs 目录：优先根目录，其次版本目录（游戏主版本优先，其后从高到低）。"""
    root_defs = mod_dir / "Defs"
    if root_defs.is_dir():
        return root_defs

    version_dirs = sorted(
        (item for item in mod_dir.iterdir() if item.is_dir() and VERSION_DIR_RE.match(item.name)),
        key=lambda item: tuple(int(part) for part in item.name.split(".")),
        reverse=True,
    )
    if game_major is not None:
        for item in version_dirs:
            if item.name == game_major and (item / "Defs").is_dir():
                return item / "Defs"
    for item in version_dirs:
        if (item / "Defs").is_dir():
            return item / "Defs"
    return None


def detect_mods(content_dir: Path, game_major: str | None) -> list[dict[str, Any]]:
    """扫描工坊目录，返回每个模组的基础信息（不解析 Defs）。"""
    versions = acf_versions(content_dir)
    mods: list[dict[str, Any]] = []
    for mod_dir in sorted((item for item in content_dir.iterdir() if item.is_dir()), key=lambda item: item.name):
        about = read_about(mod_dir)
        acf = versions.get(mod_dir.name, {})
        defs_dir = resolve_defs_dir(mod_dir, game_major)
        manifest = acf.get("manifest") or ""
        updated = acf.get("timeupdated") or ""
        # 版本标识：manifest 最稳定；没有就退回 modVersion / 支持版本。
        version = manifest or about["modVersion"] or ",".join(about["supportedVersions"])
        updated_iso = None
        if updated.isdigit():
            updated_iso = datetime.fromtimestamp(int(updated), tz=timezone.utc).astimezone().isoformat(timespec="seconds")
        mods.append(
            {
                "id": mod_dir.name,
                "name": about["name"] or mod_dir.name,
                "author": about["author"],
                "packageId": about["packageId"],
                "description": about["description"],
                "modVersion": about["modVersion"],
                "supportedVersions": about["supportedVersions"],
                "manifest": manifest or None,
                "updatedAt": updated_iso,
                "version": version or None,
                "preview": find_preview(mod_dir),
                "defsDir": str(defs_dir.relative_to(mod_dir)).replace("\\", "/") if defs_dir else None,
            }
        )
    return mods


def extract_mod(mod_dir: Path, mod_id: str, game_major: str | None) -> dict[str, Any]:
    """提取单个模组的 Defs，输出结构与本体数据兼容（只有记录，没有 sources/changes）。"""
    about = read_about(mod_dir)
    defs_dir = resolve_defs_dir(mod_dir, game_major)
    defs: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    if defs_dir is not None:
        for xml_path in sorted(defs_dir.rglob("*.xml")):
            relative = xml_path.relative_to(mod_dir).as_posix()
            try:
                tree = etree.parse(str(xml_path), DEFS_PARSER)
            except (etree.XMLSyntaxError, OSError) as exc:
                errors.append({"sourcePath": relative, "error": f"{type(exc).__name__}: {exc}"})
                continue
            for element in ed.iter_def_elements(tree.getroot()):
                defs.append(ed.extract_def(element, f"workshop:{mod_id}", relative))

    ed.canonicalize_def_types(defs)
    ed.resolve_parents(defs)
    ed.resolve_fields(defs)
    ed.resolve_graphics(defs)
    defs.sort(key=lambda record: (record["defType"], record.get("defName") or record.get("Name") or ""))

    return {
        "id": mod_id,
        "name": about["name"] or mod_id,
        "version": about["modVersion"] or None,
        "generatedAt": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "defsDir": str(defs_dir.relative_to(mod_dir)).replace("\\", "/") if defs_dir else None,
        "defs": defs,
        "errors": errors,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="workshop_defs", description="创意工坊模组检测与 Def 提取")
    sub = parser.add_subparsers(dest="command", required=True)

    p_list = sub.add_parser("list", help="列出工坊模组（只读元数据）")
    p_list.add_argument("--game", default=None, metavar="DIR", help="RimWorld 根目录（默认自动解析）")
    p_list.add_argument("--json", action="store_true", help="缩进输出 JSON")
    p_list.add_argument("--out", default=None, metavar="FILE", help="写入文件而不是 stdout（避免 Windows 管道编码问题）")

    p_extract = sub.add_parser("extract", help="提取单个模组的 Defs")
    p_extract.add_argument("--game", default=None, metavar="DIR", help="RimWorld 根目录（默认自动解析）")
    p_extract.add_argument("--id", required=True, metavar="MODID")
    p_extract.add_argument("--out", default=None, metavar="FILE")
    p_extract.add_argument("--pretty", action="store_true")

    args = parser.parse_args(argv)
    game_root = Path(args.game).expanduser() if args.game else paths.game_root(None)[0]
    game_major = read_game_major(game_root)
    content_dir = paths.workshop_content_dir(game_root)
    if content_dir is None:
        print("错误：找不到创意工坊内容目录（<steamapps>/workshop/content/294100）", file=sys.stderr)
        return 2

    if args.command == "list":
        payload = {
            "contentDir": str(content_dir),
            "gameMajor": game_major,
            "mods": detect_mods(content_dir, game_major),
        }
        text = json.dumps(payload, ensure_ascii=False, indent=2 if args.json else None)
        if args.out:
            output = Path(args.out).expanduser()
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(text + "\n", encoding="utf-8", newline="\n")
            print(f"{len(payload['mods'])} 个工坊模组 → {output}")
        else:
            print(text)
        return 0

    mod_dir = content_dir / args.id
    if not mod_dir.is_dir():
        print(f"错误：工坊模组不存在：{mod_dir}", file=sys.stderr)
        return 2
    payload = extract_mod(mod_dir, args.id, game_major)
    output = Path(args.out).expanduser() if args.out else paths.data_path().parent / "workshop" / f"{args.id}.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_name(output.name + ".tmp")
    with temp.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2 if args.pretty else None)
        handle.write("\n")
    temp.replace(output)
    print(f"{payload['name']}：{len(payload['defs'])} defs，错误 {len(payload['errors'])} → {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

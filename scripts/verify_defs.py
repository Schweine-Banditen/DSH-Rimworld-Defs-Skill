#!/usr/bin/env python3
"""独立校验：从生成的 JSON 抽样 N 条 Def，回到游戏原始 XML / DefInjected 逐字段比对。

不 import 提取脚本，全部独立解析，避免“用同一份代码验证自己”。

用法::

    python verify_defs.py [--json <rimworld-defs.json>] [--game <RimWorld 根目录>] \\
        [--samples 100] [--seed 20261106]

两个路径都可省略：默认走 `scripts/paths.py` 的解析（环境变量 → 本机配置 →
仓库派生 → Steam 自动发现）。
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import tarfile
from pathlib import Path, PurePosixPath

from lxml import etree

# 同一目录下的 paths 模块：脚本与 `import verify_defs` 两种用法都能找到。
sys.path.insert(0, str(Path(__file__).resolve().parent))

import paths  # noqa: E402 - 导入位置取决于上面的 sys.path 处理

DEFAULT_LANGUAGE = "ChineseSimplified (简体中文)"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="verify_defs", description="抽样校验 JSON 与原始 XML")
    parser.add_argument("--json", default=None, metavar="FILE", help="默认 RIMWORLD_DATA → 本机配置 → 仓库 data/rimworld-defs.json")
    parser.add_argument("--game", default=None, metavar="DIR", help="默认 RIMWORLD_GAME → 本机配置 → 数据文件记录 → Steam 自动发现")
    parser.add_argument("--samples", type=int, default=100)
    parser.add_argument("--seed", type=int, default=20261106)
    parser.add_argument("--language", default=DEFAULT_LANGUAGE)
    return parser.parse_args(argv)


def bool_attr(element: etree._Element, name: str) -> bool | None:
    raw = element.get(name)
    if raw is None:
        return None
    value = raw.strip().lower()
    if value in ("true", "1", "yes"):
        return True
    if value in ("false", "0", "no"):
        return False
    return None


def child_text(element: etree._Element, name: str) -> str | None:
    child = element.find(name)
    if child is None or child.text is None:
        return None
    text = child.text.strip()
    return text or None


def child_list(element: etree._Element, name: str) -> list[str]:
    container = element.find(name)
    if container is None:
        return []
    return [li.text.strip() for li in container.findall("li") if li.text and li.text.strip()]


def iter_defs(root: etree._Element):
    for child in root:
        if not isinstance(child.tag, str):
            continue
        if child.find("defName") is not None or child.get("Name") is not None:
            yield child


def find_element(tree: etree._Element, record: dict) -> etree._Element | None:
    """按 defType + defName/Name + Abstract 在原始 XML 中定位同一条 def。"""
    def_name = record.get("defName")
    name_attr = record.get("Name")
    def_type = (record.get("defType") or "").lower()
    is_abstract = record.get("Abstract") is True
    for element in iter_defs(tree):
        if element.tag.lower() != def_type:
            continue
        element_abstract = bool_attr(element, "Abstract") is True
        if element_abstract != is_abstract:
            continue
        if def_name:
            if child_text(element, "defName") != def_name:
                continue
        else:
            if child_text(element, "defName") is not None:
                continue
        if name_attr and element.get("Name") != name_attr:
            continue
        return element
    return None


def load_translations(game_root: Path, sources: list[str], language: str) -> dict[tuple[str, str], dict[str, str]]:
    """独立读取 DefInjected（目录 + tar），只收 label / title。"""
    index: dict[tuple[str, str], dict[str, str]] = {}

    def absorb(root: etree._Element, def_type: str) -> None:
        for element in root:
            if not isinstance(element.tag, str) or "." not in element.tag:
                continue
            name, field = element.tag.split(".", 1)
            if field not in ("label", "title"):
                continue
            text = (element.text or "").strip()
            if text:
                index.setdefault((def_type, name), {}).setdefault(field, text)

    for source in sources:
        lang_root = game_root / "Data" / source / "Languages" / language
        injected = lang_root / "DefInjected"
        if injected.is_dir():
            for xml_path in sorted(injected.rglob("*.xml")):
                relative = xml_path.relative_to(injected)
                if len(relative.parts) < 2:
                    continue
                try:
                    absorb(etree.parse(str(xml_path)).getroot(), relative.parts[0].lower())
                except etree.XMLSyntaxError:
                    continue

        tar_path = lang_root.parent / f"{language}.tar"
        if tar_path.is_file():
            try:
                with tarfile.open(tar_path) as archive:
                    for member in archive.getmembers():
                        if not member.isfile() or not member.name.endswith(".xml"):
                            continue
                        parts = PurePosixPath(member.name).parts
                        if len(parts) < 3 or parts[0] != "DefInjected":
                            continue
                        handle = archive.extractfile(member)
                        if handle is None:
                            continue
                        try:
                            absorb(etree.fromstring(handle.read()), parts[1].lower())
                        except etree.XMLSyntaxError:
                            continue
            except (tarfile.TarError, OSError):
                continue
    return index


def build_graphic_index(game_root: Path) -> dict[str, list[dict]]:
    """独立解析全部 Def XML，按**标识**建立「自有贴图信息」索引。

    继承查找不能按 defType 限定：真实数据里存在跨类型继承（FleckDef→ThingDef），
    与提取脚本一致，按标识全局查找、再用优先级挑候选。
    """
    index: dict[str, list[dict]] = {}
    for xml_path in sorted((game_root / "Data").glob("*/Defs/**/*.xml")):
        parts = xml_path.relative_to(game_root).parts
        if len(parts) < 2:
            continue
        source = parts[1]
        try:
            root = etree.parse(str(xml_path)).getroot()
        except (etree.XMLSyntaxError, OSError):
            continue
        for element in iter_defs(root):
            def_name = child_text(element, "defName")
            name_attr = element.get("Name")
            identity = def_name or name_attr
            if not identity:
                continue
            graphic_data = element.find("graphicData")
            tex_path = child_text(graphic_data, "texPath") if graphic_data is not None else None
            graphic_class = child_text(graphic_data, "graphicClass") if graphic_data is not None else None
            entry = {
                "tag": element.tag,
                "identity": identity,
                "source": source,
                "texPath": tex_path,
                "graphicClass": graphic_class,
                "parent": element.get("ParentName"),
            }
            # ParentName 可以指向 defName，也可以指向抽象模板的 Name。
            for key in {def_name, name_attr}:
                if key:
                    index.setdefault(key, []).append(entry)
    return index


def pick_parent(candidates: list[dict], child_tag: str, child_source: str) -> dict | None:
    """与提取脚本一致的候选优先级：同类型同来源 → 同类型 Core → ……"""
    if not candidates:
        return None

    def rank(item: dict) -> tuple[int, int]:
        same_type = item["tag"].lower() == child_tag.lower()
        same_source = item["source"] == child_source
        is_core = item["source"] == "Core"
        if same_type and same_source:
            return (0, 0)
        if same_type and is_core:
            return (1, 0)
        if same_type:
            return (2, 0)
        if same_source:
            return (3, 0)
        if is_core:
            return (4, 0)
        return (5, 0)

    return sorted(candidates, key=rank)[0]


def expected_effective(record: dict, own: dict | None, index: dict) -> dict | None:
    """用原始 XML 索引独立复算 effective：沿 ParentName 链找第一个有 texPath 的 def。"""
    if own and own.get("texPath"):
        return {"texPath": own["texPath"], "from": "self", "depth": 0}

    current = {
        "tag": record["defType"],
        "source": record["source"],
        "parent": record.get("ParentName"),
    }
    depth = 0
    while current.get("parent") and depth < 32:
        candidates = index.get(current["parent"], [])
        picked = pick_parent(candidates, current["tag"], current["source"])
        if picked is None:
            return None
        depth += 1
        if picked.get("texPath"):
            return {
                "texPath": picked["texPath"],
                "from": f'{picked["tag"]}:{picked["identity"]}',
                "depth": depth,
            }
        current = {"tag": picked["tag"], "source": picked["source"], "parent": picked.get("parent")}
    return None


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    data_path = paths.data_path(args.json)
    if not data_path.is_file():
        print(
            f"错误：数据文件不存在：{data_path}（先运行 python scripts/extract_defs.py）",
            file=sys.stderr,
        )
        return 2

    game_root, game_source = paths.game_root(args.game, data_path)
    if game_root is None:
        print(
            "错误：找不到 RimWorld 根目录（其下应存在 Data/Core/Defs）。"
            "请用 --game 指定，或设置环境变量 RIMWORLD_GAME，"
            f"或在 {paths.local_config_path()} 中写入 gameRoot。",
            file=sys.stderr,
        )
        return 2

    data = json.loads(data_path.read_text(encoding="utf-8-sig"))
    defs = [d for d in data["defs"] if d.get("defName") or d.get("Name")]
    rng = random.Random(args.seed)
    sample = rng.sample(defs, min(args.samples, len(defs)))

    print(f"数据: {data_path}")
    print(f"游戏: {game_root}（来源 {game_source}）")

    sources = sorted({d["source"] for d in defs})
    translations = load_translations(game_root, sources, args.language)
    graphic_index = build_graphic_index(game_root)

    tree_cache: dict[str, etree._Element] = {}
    mismatches: list[dict] = []
    checked_fields = 0

    for record in sample:
        source_path = record["sourcePath"]
        if source_path not in tree_cache:
            tree_cache[source_path] = etree.parse(str(game_root / source_path)).getroot()
        element = find_element(tree_cache[source_path], record)
        if element is None:
            mismatches.append({"def": f'{record["defType"]}:{record.get("defName") or record.get("Name")}', "field": "*", "json": "present", "xml": "element not found"})
            continue

        expect = {
            "defType": element.tag,
            "defName": child_text(element, "defName"),
            "Name": element.get("Name"),
            "label": child_text(element, "label"),
            "ParentName": element.get("ParentName"),
            "Abstract": bool_attr(element, "Abstract"),
            "Class": element.get("Class"),
            "MayRequire": element.get("MayRequire"),
            "MayRequireAnyOf": element.get("MayRequireAnyOf"),
            "category": child_text(element, "category"),
            "thingCategories": child_list(element, "thingCategories"),
        }
        for field, expected in expect.items():
            checked_fields += 1
            actual = record.get(field)
            if field == "defType":
                actual_cmp, expected_cmp = (actual or "").lower(), expected.lower()
            else:
                actual_cmp, expected_cmp = actual, expected
            if actual_cmp != expected_cmp:
                mismatches.append(
                    {
                        "def": f'{record["defType"]}:{record.get("defName") or record.get("Name")}',
                        "field": field,
                        "json": actual,
                        "xml": expected,
                        "sourcePath": source_path,
                    }
                )

        # source / sourcePath 一致性
        checked_fields += 2
        expected_source = Path(source_path).parts[1]
        if record.get("source") != expected_source:
            mismatches.append({"def": f'{record["defType"]}:{record.get("defName")}', "field": "source", "json": record.get("source"), "xml": expected_source})
        if not (game_root / source_path).is_file():
            mismatches.append({"def": record.get("defName"), "field": "sourcePath", "json": source_path, "xml": "file missing"})

        # 中文标签
        if record.get("defName"):
            translated = translations.get((record["defType"].lower(), record["defName"]), {})
            checked_fields += 2
            if translated.get("label") != record.get("labelZh"):
                mismatches.append({"def": f'{record["defType"]}:{record["defName"]}', "field": "labelZh", "json": record.get("labelZh"), "xml": translated.get("label")})
            if translated.get("title") != record.get("titleZh"):
                mismatches.append({"def": f'{record["defType"]}:{record["defName"]}', "field": "titleZh", "json": record.get("titleZh"), "xml": translated.get("title")})

        # 贴图：自有字段 + 独立复算 effective
        graphic_data = element.find("graphicData")
        own = {
            "texPath": child_text(graphic_data, "texPath") if graphic_data is not None else None,
            "graphicClass": child_text(graphic_data, "graphicClass") if graphic_data is not None else None,
            "uiIconPath": child_text(element, "uiIconPath"),
        }
        has_any_own = any(own.values())
        json_graphic = record.get("graphic") or {}
        for field in ("texPath", "graphicClass", "uiIconPath"):
            checked_fields += 1
            if own[field] != json_graphic.get(field):
                mismatches.append({"def": f'{record["defType"]}:{record.get("defName")}', "field": f"graphic.{field}", "json": json_graphic.get(field), "xml": own[field]})

        expected_eff = expected_effective(record, own, graphic_index)
        actual_eff = json_graphic.get("effective")
        checked_fields += 1
        if expected_eff is None:
            if actual_eff is not None:
                mismatches.append({"def": f'{record["defType"]}:{record.get("defName")}', "field": "graphic.effective", "json": actual_eff, "xml": None})
        else:
            if actual_eff is None:
                mismatches.append({"def": f'{record["defType"]}:{record.get("defName")}', "field": "graphic.effective", "json": None, "xml": expected_eff})
            else:
                for field in ("texPath", "from", "depth"):
                    checked_fields += 1
                    if actual_eff.get(field) != expected_eff.get(field):
                        mismatches.append({"def": f'{record["defType"]}:{record.get("defName")}', "field": f"graphic.effective.{field}", "json": actual_eff.get(field), "xml": expected_eff.get(field)})

    print(f"样本: {len(sample)} 条（seed={args.seed}），字段断言: {checked_fields} 次")
    print(f"不一致: {len(mismatches)} 处")
    for item in mismatches[:20]:
        print(f"  - {item['def']} [{item['field']}] json={item['json']!r} xml={item['xml']!r}")
    if len(mismatches) > 20:
        print(f"  ... 其余 {len(mismatches) - 20} 处省略")
    return 0 if not mismatches else 1


if __name__ == "__main__":
    raise SystemExit(main())

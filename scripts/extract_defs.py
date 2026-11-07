#!/usr/bin/env python3
"""从 RimWorld 安装目录静态提取 Def XML 定义，输出结构化 JSON。

扫描范围：``<game>/Data/Core/Defs`` 与 ``<game>/Data/<DLC>/Defs``
（Royalty、Ideology、Biotech、Anomaly、Odyssey），不存在的目录跳过。

边界：本脚本只记录 **XML 模板层** 的声明，不做任何字段合并。
``ParentName`` 继承后的字段、``MayRequire`` 条件是否满足、代码侧运行时
修改，都不在输出范围内。

用法::

    python scripts/extract_defs.py --game <RimWorld 根目录>
    python scripts/extract_defs.py --game <root> --output ./sample.json --pretty
    python scripts/extract_defs.py --game <root> --check   # 只比对版本，不重写数据
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tarfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Iterator

from lxml import etree

# 同一目录下的 paths 模块：既支持 `python scripts/extract_defs.py`（sys.path 已含
# scripts/），也支持 `import extract_defs`（此时 sys.path[0] 可能不是本目录）。
sys.path.insert(0, str(Path(__file__).resolve().parent))

import paths  # noqa: E402 - 导入位置取决于上面的 sys.path 处理

# 输出 JSON 的结构版本。字段含义变化（不是新增字段）时递增，
# Skill 侧据此判断能否读取。
SCHEMA_VERSION = 4

# 默认采集的 DefInjected 语言目录名（RimWorld 的语言目录带中文后缀）。
DEFAULT_LANGUAGE = "ChineseSimplified (简体中文)"

# 扫描的 source 及其在 Data/ 下的目录名。顺序决定输出中 defs 的排序。
SOURCES: tuple[str, ...] = (
    "Core",
    "Royalty",
    "Ideology",
    "Biotech",
    "Anomaly",
    "Odyssey",
)

# 读取 Def 标识的两个来源：具体 def 用 <defName>，抽象模板用 Name 属性。
IDENTITY_FIELDS: tuple[str, ...] = ("defName", "Name")

# 变更清单里单条记录最多列出的 def 数；超出时只保留计数。
CHANGE_ITEM_LIMIT = 1000

# 变更历史最多保留的条数：当前一条 + 上一次一条；第三次更新挤掉最早的一条。
CHANGE_HISTORY_LIMIT = 2

# 参与「字段级变化」比对的字段（标识、来源、类型已在 key 中体现）。
COMPARE_FIELDS: tuple[str, ...] = (
    "label",
    "labelZh",
    "title",
    "titleZh",
    "ParentName",
    "parentResolved",
    "Abstract",
    "Class",
    "MayRequire",
    "MayRequireAnyOf",
    "category",
    "thingCategories",
    "conditionalFields",
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="extract_defs",
        description="静态提取 RimWorld Def XML（模板层，不做继承合并）",
    )
    parser.add_argument(
        "--game",
        default=None,
        metavar="DIR",
        help="游戏根目录（其下应存在 Data/Core/Defs）。"
        "留空时依次尝试环境变量 RIMWORLD_GAME、rimworld-defs.local.json、"
        "已有数据文件记录的 gameRoot、Steam 自动发现",
    )
    parser.add_argument(
        "--output",
        default=None,
        metavar="FILE",
        help="输出 JSON 路径；默认 <脚本目录>/../data/rimworld-defs.json",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="缩进输出（便于人工检查，文件更大）",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="只比对该 JSON 的 gameVersion 与当前游戏版本，不扫描、不写文件；"
        "退出码 0=一致，1=需要重新生成，2=参数或路径错误",
    )
    parser.add_argument(
        "--language",
        default=DEFAULT_LANGUAGE,
        metavar="NAME",
        help=f"采集的 DefInjected 语言目录名（默认 {DEFAULT_LANGUAGE!r}）",
    )
    parser.add_argument(
        "--no-translations",
        action="store_true",
        help="跳过 DefInjected 翻译采集（只输出英文 label/title）",
    )
    return parser


def default_output_path() -> Path:
    """默认输出路径：RIMWORLD_DATA → 本机配置 → 仓库 ``data/rimworld-defs.json``。"""
    return paths.data_path()


def read_game_version(game_root: Path) -> str | None:
    """读取游戏根目录下的 Version.txt（如 ``1.7.5000 rev1275``）。

    游戏更新后该文件必然变化，用它作为「数据是否过期」的廉价判据。
    """
    version_file = game_root / "Version.txt"
    if not version_file.is_file():
        return None
    try:
        for line in version_file.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            text = line.strip().lstrip("\ufeff").strip()
            if text:
                return text
    except OSError:
        return None
    return None


def write_payload(output_path: Path, payload: dict[str, Any], pretty: bool) -> None:
    """原子写入：先写同目录临时文件，再替换目标，避免中断留下半个 JSON。"""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = output_path.with_name(output_path.name + ".tmp")
    with temp_path.open("w", encoding="utf-8", newline="\n") as handle:
        if pretty:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
        else:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp_path, output_path)


def check_up_to_date(output_path: Path, game_root: Path) -> int:
    """比较已有 JSON 与当前游戏版本，不扫描 XML、不写文件。

    返回退出码：0=一致，1=需要重新生成，2=路径错误。
    """
    current_version = read_game_version(game_root)
    if current_version is None:
        print(f"错误：{game_root} 下没有 Version.txt，无法判断版本", file=sys.stderr)
        return 2
    if not output_path.is_file():
        print(f"需要生成：数据文件不存在 {output_path}", file=sys.stderr)
        return 1
    try:
        existing = json.loads(output_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"需要生成：现有 JSON 无法读取（{exc}）", file=sys.stderr)
        return 1

    problems: list[str] = []
    if existing.get("schemaVersion") != SCHEMA_VERSION:
        problems.append(
            f"schemaVersion 不一致（现有 {existing.get('schemaVersion')!r}，"
            f"脚本 {SCHEMA_VERSION}）"
        )
    if existing.get("gameVersion") != current_version:
        problems.append(
            f"游戏版本不一致（现有 {existing.get('gameVersion')!r}，当前 {current_version!r}）"
        )
    if problems:
        for problem in problems:
            print(f"需要重新生成：{problem}", file=sys.stderr)
        return 1

    print(f"数据已是最新：gameVersion={current_version}（生成于 {existing.get('generatedAt')}）")
    return 0


def parse_bool_attr(element: etree._Element, name: str) -> bool | None:
    """读布尔属性；属性缺失或值不可识别时返回 None。"""
    raw = element.get(name)
    if raw is None:
        return None
    value = raw.strip().lower()
    if value in ("true", "1", "yes"):
        return True
    if value in ("false", "0", "no"):
        return False
    return None


def text_of_child(element: etree._Element, name: str) -> str | None:
    """取同名子元素的去空白文本；缺失返回 None。"""
    child = element.find(name)
    if child is None or child.text is None:
        return None
    text = child.text.strip()
    return text or None


def list_of_children_text(element: etree._Element, name: str) -> list[str]:
    """取 ``<name><li>..</li></name>`` 形式下的全部列表项文本。"""
    container = element.find(name)
    if container is None:
        return []
    items: list[str] = []
    for li in container.findall("li"):
        if li.text is None:
            continue
        text = li.text.strip()
        if text:
            items.append(text)
    return items


def conditional_children(element: etree._Element) -> list[dict[str, str]]:
    """记录顶层子元素上的 MayRequire / MayRequireAnyOf（字段级条件）。

    RimWorld XML 允许在单个字段上写条件，例如
    ``<category MayRequire="Ludeon.RimWorld.Royalty">Skip</category>``。
    这些条件只作用于该字段，而不是整个 Def，故单独记录。
    """
    found: list[dict[str, str]] = []
    for child in element:
        if not isinstance(child.tag, str):
            continue
        for attr in ("MayRequire", "MayRequireAnyOf"):
            raw = child.get(attr)
            if raw and raw.strip():
                found.append({"field": child.tag, attr: raw.strip()})
    return found


def iter_def_elements(root: etree._Element) -> Iterator[etree._Element]:
    """遍历一个 XML 文档中的 Def 元素。

    支持两种文档形态：根为 ``<Defs>`` 的容器式（绝大多数文件），以及根本身
    就是单个 Def 的形态。判定条件：直接子元素带 ``defName`` 子元素、或带
    ``Name`` 属性（抽象模板）、或标签以 ``Def`` 结尾（如 SongDef 这类没有
    defName 的 Def）。
    """
    if root.tag.endswith("Def") and (
        root.find("defName") is not None or root.get("Name") is not None
    ):
        yield root
        return

    for child in root:
        if not isinstance(child.tag, str):
            continue
        if child.find("defName") is not None:
            yield child
        elif child.get("Name") is not None:
            yield child
        elif child.tag.endswith("Def"):
            yield child


def extract_def(
    element: etree._Element,
    source: str,
    source_path: str,
) -> dict[str, Any]:
    """把一个 Def 元素投影成一条记录（不做任何继承合并）。"""
    record: dict[str, Any] = {
        "defType": element.tag,
        "defName": text_of_child(element, "defName") or element.get("defName"),
        "Name": element.get("Name"),
        "label": text_of_child(element, "label"),
        "title": text_of_child(element, "title"),
        "ParentName": element.get("ParentName"),
        "parentResolved": None,
        "parentDefName": None,
        "parentDefType": None,
        "parentSource": None,
        "parentUnresolvedReason": None,
        "Abstract": parse_bool_attr(element, "Abstract"),
        "Class": element.get("Class"),
        "MayRequire": element.get("MayRequire"),
        "MayRequireAnyOf": element.get("MayRequireAnyOf"),
        "category": text_of_child(element, "category"),
        "thingCategories": list_of_children_text(element, "thingCategories"),
        "source": source,
        "sourcePath": source_path,
    }
    conditionals = conditional_children(element)
    if conditionals:
        record["conditionalFields"] = conditionals
    graphic = parse_graphic(element)
    if graphic:
        record["graphic"] = graphic
    record["_fields"] = extract_own_fields(element)
    return record


def parse_graphic(element: etree._Element) -> dict[str, Any] | None:
    """读取 ``<graphicData>`` 的 texPath / graphicClass，以及独立的 ``uiIconPath``。

    这里只记录该 Def **自己写的**内容；父级继承的解析在 ``resolve_graphics``
    里完成。三者都没有时返回 None，避免给无关 Def 塞空对象。
    """
    graphic_data = element.find("graphicData")
    tex_path = text_of_child(graphic_data, "texPath") if graphic_data is not None else None
    graphic_class = (
        text_of_child(graphic_data, "graphicClass") if graphic_data is not None else None
    )
    ui_icon_path = text_of_child(element, "uiIconPath")
    if not (tex_path or graphic_class or ui_icon_path):
        return None
    return {"texPath": tex_path, "graphicClass": graphic_class, "uiIconPath": ui_icon_path}


# 常用标量字段（物品种类相关），沿父链取第一个出现的值。
SCALAR_FIELDS: tuple[str, ...] = (
    "size",
    "rotatable",
    "fillPercent",
    "stackLimit",
    "costStuffCount",
    "thingClass",
    "uiIconScale",
    "useHitPoints",
    "selectable",
)


def _scalar_children(element: etree._Element, container_name: str) -> dict[str, str] | None:
    """读取 ``<container><Key>值</Key></container>`` 形式的标量键值。"""
    container = element.find(container_name)
    if container is None:
        return None
    values: dict[str, str] = {}
    for child in container:
        if not isinstance(child.tag, str) or len(child):
            continue
        text = (child.text or "").strip()
        if text:
            values[child.tag] = text
    return values or None


def _parse_comps(element: etree._Element) -> list[dict[str, Any]] | None:
    """读取 ``<comps><li Class=...>`` 的类名与标量子属性。"""
    comps_element = element.find("comps")
    if comps_element is None:
        return None
    entries: list[dict[str, Any]] = []
    for li in comps_element.findall("li"):
        class_name = li.get("Class") or text_of_child(li, "compClass")
        props: dict[str, str] = {}
        for child in li:
            if not isinstance(child.tag, str) or child.tag == "compClass" or len(child):
                continue
            text = (child.text or "").strip()
            if text:
                props[child.tag] = text
        if class_name or props:
            entries.append({"class": class_name, "props": props})
    return entries or None


def _parse_building(element: etree._Element) -> dict[str, Any] | None:
    """读取 ``<building>`` 中的存储设置（标签、优先级、过滤类别）。"""
    building = element.find("building")
    if building is None:
        return None
    result: dict[str, Any] = {}
    storage_tag = text_of_child(building, "storageGroupTag")
    if storage_tag:
        result["storageGroupTag"] = storage_tag
    for key in ("defaultStorageSettings", "fixedStorageSettings"):
        node = building.find(key)
        if node is None:
            continue
        settings: dict[str, Any] = {}
        priority = text_of_child(node, "priority")
        if priority:
            settings["priority"] = priority
        filter_element = node.find("filter")
        if filter_element is not None:
            categories = list_of_children_text(filter_element, "categories")
            if categories:
                settings["categories"] = categories
            disallowed = list_of_children_text(filter_element, "disallowedCategories")
            if disallowed:
                settings["disallowedCategories"] = disallowed
            disallowed_defs = list_of_children_text(filter_element, "disallowedThingDefs")
            if disallowed_defs:
                settings["disallowedThingDefs"] = disallowed_defs
        if settings:
            result[key] = settings
    return result or None


def extract_own_fields(element: etree._Element) -> dict[str, Any]:
    """抽取该 Def 自己写的常用字段；继承解析在 ``resolve_fields`` 里完成。"""
    scalars: dict[str, str] = {}
    for name in SCALAR_FIELDS:
        value = text_of_child(element, name)
        if value:
            scalars[name] = value
    own: dict[str, Any] = {"scalars": scalars}
    stat_bases = _scalar_children(element, "statBases")
    if stat_bases:
        own["statBases"] = stat_bases
    comps = _parse_comps(element)
    if comps:
        own["comps"] = comps
    building = _parse_building(element)
    if building:
        own["building"] = building
    return own


def canonicalize_def_types(defs: list[dict[str, Any]]) -> dict[str, str]:
    """把仅大小写不同的 defType 归并到同一规范拼写。

    真实数据里存在 ``BackStoryDef`` / ``jobDef`` 这类写法，游戏加载器接受，
    但会让同一 Def 类型在数据里裂成两组。取出现次数最多的拼写作为规范名。
    """
    groups: dict[str, dict[str, int]] = {}
    for record in defs:
        key = record["defType"].lower()
        groups.setdefault(key, {})
        groups[key][record["defType"]] = groups[key].get(record["defType"], 0) + 1

    canonical: dict[str, str] = {}
    for key, spellings in groups.items():
        canonical[key] = max(spellings.items(), key=lambda kv: (kv[1], kv[0]))[0]

    for record in defs:
        record["defType"] = canonical[record["defType"].lower()]
    return canonical


def _absorb_definjected(
    root: etree._Element,
    def_type: str,
    target: dict[tuple[str, str], dict[str, str]],
) -> int:
    """把 ``<LanguageData>`` 下的 ``<defName.field>文本`` 收进翻译表。

    DefInjected 的元素名形如 ``Beer.label``、``Beer.tools.bottle.label``，
    点号前是 defName，点号后是字段路径；这里按原样保存字段路径。
    """
    count = 0
    for element in root:
        if not isinstance(element.tag, str) or "." not in element.tag:
            continue
        def_name, field = element.tag.split(".", 1)
        text = (element.text or "").strip()
        if not text or not def_name or not field:
            continue
        # 先读到的来源优先（目录形式先于 tar），同一字段不覆盖。
        target.setdefault((def_type, def_name), {}).setdefault(field, text)
        count += 1
    return count


def load_translations(
    game_root: Path,
    source_names: list[str],
    language: str,
    canonical_types: dict[str, str],
) -> tuple[dict[tuple[str, str], dict[str, str]], list[dict[str, str]], dict[str, int]]:
    """采集 DefInjected 翻译：``Languages/<语言>/DefInjected`` 目录 + ``<语言>.tar``。

    原版把 Core 的翻译解成目录，DLC 的翻译只提供 `.tar`，两种形态都要读。
    目录形式优先（先读、后读的 tar 覆盖不到已有条目）。
    """
    translations: dict[tuple[str, str], dict[str, str]] = {}
    errors: list[dict[str, str]] = []
    stats = {"dirFiles": 0, "tarFiles": 0, "entries": 0}
    parser = etree.XMLParser(
        resolve_entities=False,
        no_network=True,
        remove_comments=True,
        recover=False,
    )

    def canonical_type(folder: str) -> str:
        return canonical_types.get(folder.lower(), folder)

    for source in source_names:
        lang_root = game_root / "Data" / source / "Languages" / language

        injected_dir = lang_root / "DefInjected"
        if injected_dir.is_dir():
            for xml_path in sorted(injected_dir.rglob("*.xml")):
                relative = xml_path.relative_to(injected_dir)
                if len(relative.parts) < 2:
                    continue
                def_type = canonical_type(relative.parts[0])
                try:
                    root = etree.parse(str(xml_path), parser).getroot()
                except (etree.XMLSyntaxError, OSError) as exc:
                    errors.append(
                        {
                            "sourcePath": f"Data/{source}/Languages/{language}/{relative.as_posix()}",
                            "error": f"{type(exc).__name__}: {exc}",
                        }
                    )
                    continue
                stats["dirFiles"] += 1
                stats["entries"] += _absorb_definjected(root, def_type, translations)

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
                        def_type = canonical_type(parts[1])
                        handle = archive.extractfile(member)
                        if handle is None:
                            continue
                        try:
                            root = etree.fromstring(handle.read(), parser)
                        except etree.XMLSyntaxError as exc:
                            errors.append(
                                {
                                    "sourcePath": f"{tar_path.name}:{member.name}",
                                    "error": f"{type(exc).__name__}: {exc}",
                                }
                            )
                            continue
                        stats["tarFiles"] += 1
                        stats["entries"] += _absorb_definjected(root, def_type, translations)
            except (tarfile.TarError, OSError) as exc:
                errors.append(
                    {
                        "sourcePath": f"Data/{source}/Languages/{language}.tar",
                        "error": f"{type(exc).__name__}: {exc}",
                    }
                )
    return translations, errors, stats


def attach_translations(
    defs: list[dict[str, Any]],
    translations: dict[tuple[str, str], dict[str, str]],
) -> dict[str, int]:
    """把 ``label`` / ``title`` 的中文翻译挂到对应 def 上。"""
    stats = {"labelZh": 0, "titleZh": 0}
    for record in defs:
        name = record.get("defName")
        if not name:
            continue
        fields = translations.get((record["defType"], name))
        if not fields:
            continue
        label = fields.get("label")
        if label:
            record["labelZh"] = label
            stats["labelZh"] += 1
        title = fields.get("title")
        if title:
            record["titleZh"] = title
            stats["titleZh"] += 1
    return stats


def def_key(record: dict[str, Any]) -> tuple[str, str, str, str]:
    """变更比对用的稳定标识：类型 + 标识 + 来源 + 是否抽象模板。

    加 ``source`` 是为了区分 Core/Ideology 各定义一次的
    ``MapGen_AncientComplexRoomLoot_Default``；加抽象标记是为了区分
    「抽象模板 + 具体 def」共用同一 defName 的情况。
    """
    identity = record.get("defName") or record.get("Name") or ""
    kind = "abstract" if record.get("Abstract") else "concrete"
    return (
        record.get("defType") or "",
        identity,
        record.get("source") or "",
        kind,
    )


def load_previous(output_path: Path) -> tuple[dict[str, Any] | None, str | None]:
    """读取上一份数据用于对比；读不到或结构版本不同时返回原因。"""
    if not output_path.is_file():
        return None, "no_previous_file"
    try:
        data = json.loads(output_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return None, "previous_unreadable"
    if data.get("schemaVersion") != SCHEMA_VERSION:
        return None, "previous_schema_mismatch"
    return data, None


def compute_changes(
    previous: dict[str, Any] | None,
    new_defs: list[dict[str, Any]],
    note: str | None,
) -> dict[str, Any]:
    """把「本次数据相对上一份数据的差异」整理成结构化变更记录。

    只在这里读一次旧数据；新数据写盘后旧文件即被替换，不再保留。
    """
    if previous is None:
        return {
            "comparedTo": None,
            "firstBuild": True,
            "note": note,
            "summary": {"added": 0, "removed": 0, "changed": 0},
            "items": [],
            "itemsTruncated": False,
        }

    old_index = {def_key(record): record for record in previous.get("defs") or []}
    items: list[dict[str, Any]] = []
    added = removed = changed = 0
    seen: set[tuple[str, str, str, str]] = set()

    for record in new_defs:
        key = def_key(record)
        seen.add(key)
        old = old_index.get(key)
        identity = record.get("defName") or record.get("Name")
        if old is None:
            added += 1
            items.append({"defType": record["defType"], "defName": identity, "kind": "added"})
            continue
        fields = [field for field in COMPARE_FIELDS if old.get(field) != record.get(field)]
        if fields:
            changed += 1
            items.append(
                {
                    "defType": record["defType"],
                    "defName": identity,
                    "kind": "changed",
                    "fields": fields,
                }
            )

    for key, old in old_index.items():
        if key in seen:
            continue
        removed += 1
        items.append(
            {
                "defType": old["defType"],
                "defName": old.get("defName") or old.get("Name"),
                "kind": "removed",
            }
        )

    return {
        "comparedTo": {
            "gameVersion": previous.get("gameVersion"),
            "generatedAt": previous.get("generatedAt"),
        },
        "firstBuild": False,
        "note": note,
        "summary": {"added": added, "removed": removed, "changed": changed},
        "items": items[:CHANGE_ITEM_LIMIT],
        "itemsTruncated": len(items) > CHANGE_ITEM_LIMIT,
    }


def history_path_for(output_path: Path) -> Path:
    """变更历史与数据文件同目录，便于整体搬迁。"""
    return output_path.with_name("changes-history.json")


def record_history(history_file: Path, record: dict[str, Any]) -> None:
    """维护「当前 + 上一次」两条变更记录；更早的记录被挤掉。"""
    entries: list[dict[str, Any]] = []
    if history_file.is_file():
        try:
            payload = json.loads(history_file.read_text(encoding="utf-8-sig"))
            entries = payload.get("entries") or []
        except (OSError, json.JSONDecodeError):
            entries = []
    entries.insert(0, record)
    entries = entries[:CHANGE_HISTORY_LIMIT]
    write_payload(history_file, {"entries": entries}, pretty=False)


def discover_sources(game_root: Path) -> list[str]:
    """发现 ``Data/*/Defs`` 下的全部 source，供游戏新增 DLC 后自动适配。

    已知 source 按 ``SOURCES`` 的顺序排在前面；未知的新目录按字母序追加，
    这样 1.7 → 1.8 新增 DLC 时脚本无需改代码即可采集。
    """
    data_dir = game_root / "Data"
    names = [
        path.name
        for path in sorted(data_dir.iterdir(), key=lambda p: p.name)
        if path.is_dir() and (path / "Defs").is_dir()
    ]
    known = [name for name in SOURCES if name in names]
    unknown = [name for name in names if name not in SOURCES]
    return known + unknown


def collect_defs(
    game_root: Path,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    """扫描全部 source，返回 (defs, sources, errors)。"""
    defs: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    parser = etree.XMLParser(
        resolve_entities=False,
        no_network=True,
        remove_comments=True,
        recover=False,
    )

    for source in discover_sources(game_root):
        defs_dir = game_root / "Data" / source / "Defs"
        if not defs_dir.is_dir():
            continue
        files = sorted(defs_dir.rglob("*.xml"))
        source_def_count = 0
        for xml_path in files:
            relative = xml_path.relative_to(game_root).as_posix()
            try:
                tree = etree.parse(str(xml_path), parser)
            except (etree.XMLSyntaxError, OSError) as exc:
                errors.append(
                    {"sourcePath": relative, "error": f"{type(exc).__name__}: {exc}"}
                )
                continue
            for element in iter_def_elements(tree.getroot()):
                defs.append(extract_def(element, source, relative))
                source_def_count += 1
        sources.append(
            {
                "name": source,
                "path": f"Data/{source}/Defs",
                "fileCount": len(files),
                "defCount": source_def_count,
            }
        )
    return defs, sources, errors


def resolve_parents(defs: list[dict[str, Any]]) -> dict[str, Any]:
    """解析 ParentName，只在扫描范围内查找，绝不猜测模组或未扫描目录。

    RimWorld 的继承是**按标识（defName 或抽象模板的 Name）全局查找**的：
    真实数据里存在 FleckDef 继承 ThingDef、StructureLayoutDef 继承
    StructureStructureLayoutDef 这类跨类型继承，因此不能用 defType 过滤候选。

    候选优先级（尽量贴近游戏加载顺序中「先定义者优先」的直觉）：

    1. 同 defType + 同 source；
    2. 同 defType + 任意 source（Core 优先）；
    3. 同 source + 任意 defType；
    4. Core + 任意 defType；
    5. 其它任意候选。

    找不到时标记 ``parentResolved=false``、原因 ``not_in_scan_scope``。

    返回统计信息，供脚本运行时输出。
    """
    index: dict[str, list[dict[str, Any]]] = {}
    for record in defs:
        for field in IDENTITY_FIELDS:
            key = record.get(field)
            if key:
                index.setdefault(key, []).append(record)

    stats: dict[str, Any] = {
        "total": len(defs),
        "withParent": 0,
        "resolved": 0,
        "unresolved": 0,
        "cross_type": 0,
        "ambiguous": 0,
        "unresolved_by_reason": {},
    }

    for record in defs:
        parent_name = record.get("ParentName")
        if not parent_name:
            continue
        stats["withParent"] += 1
        candidates = [c for c in index.get(parent_name, []) if c is not record]

        if not candidates:
            record["parentResolved"] = False
            record["parentUnresolvedReason"] = "not_in_scan_scope"
            stats["unresolved"] += 1
            stats["unresolved_by_reason"]["not_in_scan_scope"] = (
                stats["unresolved_by_reason"].get("not_in_scan_scope", 0) + 1
            )
            continue

        def rank(candidate: dict[str, Any]) -> tuple[int, int]:
            same_type = candidate["defType"] == record["defType"]
            same_source = candidate["source"] == record["source"]
            is_core = candidate["source"] == "Core"
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

        candidates.sort(key=rank)
        picked = candidates[0]
        if len(candidates) > 1:
            stats["ambiguous"] += 1

        record["parentResolved"] = True
        record["parentDefName"] = picked.get("defName") or picked.get("Name")
        record["parentDefType"] = picked["defType"]
        record["parentSource"] = picked["source"]
        stats["resolved"] += 1
        if picked["defType"] != record["defType"]:
            stats["cross_type"] += 1
    return stats


def resolve_graphics(defs: list[dict[str, Any]]) -> dict[str, int]:
    """解析「有效贴图」：自己没写 texPath 时沿 ParentName 链找第一个有图的祖先。

    与字段合并不同，这里只**指向**祖先的 texPath，不复制其他字段；结果写在
    ``graphic.effective`` 里，并标注来源与层数，供 UI 直接取图。
    """
    index: dict[tuple[str, str, str], dict[str, Any]] = {}
    for record in defs:
        identity = record.get("defName") or record.get("Name")
        if identity:
            index[(record["defType"], identity, record["source"])] = record

    stats = {"own": 0, "inherited": 0, "noGraphic": 0}
    for record in defs:
        graphic = record.get("graphic")
        tex_path = graphic.get("texPath") if graphic else None
        if tex_path:
            graphic["own"] = True
            graphic["effective"] = {
                "texPath": tex_path,
                "graphicClass": graphic.get("graphicClass"),
                "from": "self",
                "depth": 0,
            }
            stats["own"] += 1
            continue

        visited: set[tuple[str, str, str]] = set()
        current = record
        depth = 0
        found = None
        while current and current.get("ParentName") and depth < 32:
            key = (
                current.get("parentDefType") or "",
                current.get("parentDefName") or "",
                current.get("parentSource") or "",
            )
            if key in visited:
                break
            visited.add(key)
            parent = index.get(key)
            if parent is None:
                break
            depth += 1
            parent_graphic = parent.get("graphic") or {}
            if parent_graphic.get("texPath"):
                found = (parent, depth)
                break
            current = parent

        if found is not None:
            parent, depth = found
            parent_graphic = parent["graphic"]
            if graphic is None:
                graphic = {"texPath": None, "graphicClass": None, "uiIconPath": None}
                record["graphic"] = graphic
            identity = parent.get("defName") or parent.get("Name")
            graphic["own"] = False
            graphic["effective"] = {
                "texPath": parent_graphic["texPath"],
                "graphicClass": parent_graphic.get("graphicClass"),
                "from": f'{parent["defType"]}:{identity}',
                "depth": depth,
            }
            stats["inherited"] += 1
        else:
            if graphic is not None:
                graphic["own"] = bool(graphic.get("texPath"))
                graphic["effective"] = None
            else:
                stats["noGraphic"] += 1
    return stats


def resolve_fields(defs: list[dict[str, Any]]) -> dict[str, int]:
    """整理常用字段：标量沿父链取第一个值，statBases 合并，comps/building 取最近来源。

    这不是运行时字段合并：结果只用于展示「这个 Def 的模板级属性大概是什么」，
    每个值都标注来源（self 或祖先标识）。
    """
    by_key: dict[tuple[str, str, str], dict[str, Any]] = {}
    for record in defs:
        identity = record.get("defName") or record.get("Name")
        if identity:
            by_key[(record["defType"], identity, record["source"])] = record

    own_fields = {id(record): (record.pop("_fields", None) or {}) for record in defs}

    def label(record: dict[str, Any]) -> str:
        return f'{record["defType"]}:{record.get("defName") or record.get("Name")}'

    def chain(record: dict[str, Any]) -> list[dict[str, Any]]:
        hops = [record]
        current = record
        seen: set[tuple[str, str, str]] = set()
        while current.get("ParentName") and len(hops) < 32:
            key = (
                current.get("parentDefType") or "",
                current.get("parentDefName") or "",
                current.get("parentSource") or "",
            )
            if key in seen:
                break
            seen.add(key)
            parent = by_key.get(key)
            if parent is None:
                break
            hops.append(parent)
            current = parent
        return hops

    stats = {"withFields": 0, "withInherited": 0}
    for record in defs:
        hops = chain(record)
        result: dict[str, Any] = {}

        scalars: dict[str, Any] = {}
        for name in SCALAR_FIELDS:
            for index, ancestor in enumerate(hops):
                value = own_fields[id(ancestor)].get("scalars", {}).get(name)
                if value:
                    scalars[name] = {
                        "value": value,
                        "from": "self" if index == 0 else label(ancestor),
                    }
                    break
        if scalars:
            result["scalars"] = scalars

        merged: dict[str, str] = {}
        sources: dict[str, str] = {}
        for ancestor in reversed(hops):
            values = own_fields[id(ancestor)].get("statBases")
            if not values:
                continue
            origin = "self" if ancestor is record else label(ancestor)
            for key, value in values.items():
                merged[key] = value
                sources[key] = origin
        if merged:
            inherited = {key: origin for key, origin in sources.items() if origin != "self"}
            entry: dict[str, Any] = {
                "value": merged,
                "from": "merged" if inherited else "self",
            }
            if inherited:
                entry["inheritedFrom"] = inherited
            result["statBases"] = entry

        for index, ancestor in enumerate(hops):
            comps = own_fields[id(ancestor)].get("comps")
            if comps:
                result["comps"] = {
                    "value": comps,
                    "from": "self" if index == 0 else label(ancestor),
                }
                break

        for index, ancestor in enumerate(hops):
            building = own_fields[id(ancestor)].get("building")
            if building:
                result["building"] = {
                    "value": building,
                    "from": "self" if index == 0 else label(ancestor),
                }
                break

        if result:
            record["fields"] = result
            stats["withFields"] += 1
            has_inherited = any(
                isinstance(entry, dict) and entry.get("from") not in ("self", "merged")
                for entry in result.values()
            ) or any(
                isinstance(entry, dict) and entry.get("inheritedFrom")
                for entry in result.values()
            )
            if has_inherited:
                stats["withInherited"] += 1
    return stats


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    game_root = Path(args.game).expanduser().resolve() if args.game else None
    output_path = (
        Path(args.output).expanduser().resolve() if args.output else default_output_path()
    )

    resolved_root, game_source = paths.game_root(game_root, output_path)
    if resolved_root is None:
        print(
            "错误：找不到 RimWorld 根目录（其下应存在 Data/Core/Defs）。"
            "请用 --game 指定，或设置环境变量 RIMWORLD_GAME，"
            f"或在 {paths.local_config_path()} 中写入 gameRoot。",
            file=sys.stderr,
        )
        return 2
    game_root = resolved_root

    if args.check:
        return check_up_to_date(output_path, game_root)

    game_version = read_game_version(game_root)
    if game_version is None:
        print(
            f"警告：{game_root} 下没有 Version.txt，JSON 中 gameVersion 将为空",
            file=sys.stderr,
        )

    defs, sources, errors = collect_defs(game_root)
    canonical_types = canonicalize_def_types(defs)

    translation_stats = {"labelZh": 0, "titleZh": 0}
    translation_meta = {"dirFiles": 0, "tarFiles": 0, "entries": 0}
    if not args.no_translations:
        translations, translation_errors, translation_meta = load_translations(
            game_root,
            [source["name"] for source in sources],
            args.language,
            canonical_types,
        )
        errors.extend(translation_errors)
        translation_stats = attach_translations(defs, translations)

    stats = resolve_parents(defs)
    field_stats = resolve_fields(defs)
    graphic_stats = resolve_graphics(defs)

    # 稳定排序：实际扫描顺序（Core 优先，其后新 DLC）-> defType -> defName/Name
    order = {source["name"]: i for i, source in enumerate(sources)}
    defs.sort(
        key=lambda d: (
            order.get(d["source"], len(order)),
            d["defType"],
            d.get("defName") or d.get("Name") or "",
        )
    )

    previous, previous_note = load_previous(output_path)
    changes = compute_changes(previous, defs, previous_note)

    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": datetime.now(timezone.utc)
        .astimezone()
        .isoformat(timespec="seconds"),
        "gameVersion": game_version,
        "gameRoot": str(game_root),
        "sources": sources,
        "defs": defs,
        "errors": errors,
        "changes": changes,
    }

    write_payload(output_path, payload, pretty=args.pretty)
    record_history(
        history_path_for(output_path),
        {
            "gameVersion": game_version,
            "generatedAt": payload["generatedAt"],
            "comparedTo": changes["comparedTo"],
            "summary": changes["summary"],
            "items": changes["items"],
            "itemsTruncated": changes["itemsTruncated"],
        },
    )

    summary = changes["summary"]
    size_mb = output_path.stat().st_size / (1024 * 1024)
    print(f"扫描目录: {game_root}（来源 {game_source}）")
    print(f"游戏版本: {game_version or '(未知)'}")
    print(f"输出文件: {output_path} ({size_mb:.1f} MB)")
    if changes["firstBuild"]:
        print(f"变更: 首次生成（无上一份数据可比对，原因 {changes.get('note')}）")
    else:
        compared = changes["comparedTo"] or {}
        print(
            f"变更: 对比 {compared.get('gameVersion')} → {game_version}"
            f"（新增 {summary['added']} / 删除 {summary['removed']} / 改动 {summary['changed']}）"
        )
        if changes["itemsTruncated"]:
            print(f"  - 变更清单已截断为前 {CHANGE_ITEM_LIMIT} 条")
    print(f"Def 总数: {stats['total']}，含 ParentName: {stats['withParent']}")
    if args.no_translations:
        print("翻译: 已跳过（--no-translations）")
    else:
        print(
            f"翻译: {translation_meta['entries']} 条 / 目录 {translation_meta['dirFiles']} 文件"
            f" + tar {translation_meta['tarFiles']} 文件；"
            f"中文 label {translation_stats['labelZh']}、title {translation_stats['titleZh']}"
        )
    print(
        f"父级已解析: {stats['resolved']}（其中跨 defType: {stats['cross_type']}，"
        f"多候选: {stats['ambiguous']}），未解析: {stats['unresolved']}"
    )
    print(
        f"贴图: 自有 texPath {graphic_stats['own']}，继承祖先 {graphic_stats['inherited']}，"
        f"无图 {graphic_stats['noGraphic']}"
    )
    print(
        f"字段: 有属性 {field_stats['withFields']}（其中含继承来源 {field_stats['withInherited']}）"
    )
    for reason, count in sorted(stats["unresolved_by_reason"].items()):
        print(f"  - 未解析原因 {reason}: {count}")
    print(f"解析错误（含翻译）: {len(errors)}")
    for source in sources:
        print(
            f"  - {source['name']}: {source['defCount']} defs / {source['fileCount']} files"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

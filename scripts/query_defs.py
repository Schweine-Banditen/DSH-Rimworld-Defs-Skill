#!/usr/bin/env python3
"""RimWorld Defs 查询层：加载提取出的 JSON，提供四个查询与数据版本提示。

设计要点：

- 既可作为库被 Skill 的接入层 import，也可作为 CLI 直接调试；
- 只读：不修改数据文件、不触发重建；
- 数据过期时只返回 notice，不自动更新（更新由使用者确认后执行提取脚本）。

CLI 示例::

    python scripts/query_defs.py info
    python scripts/query_defs.py search-def Steel --def-type ThingDef
    python scripts/query_defs.py search-label 钢 --limit 10
    python scripts/query_defs.py list-source Royalty --limit 20
    python scripts/query_defs.py list-category --category Item --thing-categories ResourcesRaw --def-type ThingDef
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Iterable

# 同目录的 paths 模块：脚本与 `import query_defs` 两种用法都能找到。
sys.path.insert(0, str(Path(__file__).resolve().parent))

import paths  # noqa: E402 - 导入位置取决于上面的 sys.path 处理

# 查询层能理解的输出结构版本。
SUPPORTED_SCHEMA_VERSION = 4

# 中文提示文案（工具结果里直接展示）。
NOTE_PARENT_UNRESOLVED = "该 Def 的 ParentName 不在扫描范围内，字段可能不完整，请查看 ParentName 指向的模板。"
NOTE_MAY_REQUIRE = "原始条件，最终是否加载由游戏运行时决定。"


def default_data_path() -> Path:
    """默认数据文件：RIMWORLD_DATA → 本机配置 → 仓库 ``data/rimworld-defs.json``。"""
    return paths.data_path()


def def_identity(record: dict[str, Any]) -> str | None:
    return record.get("defName") or record.get("Name")


class DefsData:
    """一份已加载的 Defs 数据，提供查询与索引。"""

    def __init__(
        self,
        data_path: Path | str,
        game_root: Path | str | None = None,
        scope: str = "all",
    ):
        self.path = Path(data_path).expanduser().resolve()
        if not self.path.is_file():
            raise FileNotFoundError(f"数据文件不存在：{self.path}")
        self.payload = json.loads(self.path.read_text(encoding="utf-8-sig"))
        self.scope = scope if scope in ("all", "g", "c", "m") else "all"
        self.defs: list[dict[str, Any]] = self._apply_scope(
            self.path.parent, list(self.payload.get("defs") or [])
        )
        self.game_root = Path(game_root).expanduser().resolve() if game_root else None
        if self.game_root is None and self.payload.get("gameRoot"):
            self.game_root = Path(self.payload["gameRoot"])

        self._by_identity: dict[str, list[dict[str, Any]]] = {}
        self._by_key: dict[tuple[str, str, str], dict[str, Any]] = {}
        self._label_entries: list[tuple[str, str, dict[str, Any]]] = []
        self._build_indexes()
        self._notice_cache: dict[str, Any] | None = None

    # ------------------------------------------------------------------
    # 来源范围（本体/DLC、创意工坊、我的模组）
    # ------------------------------------------------------------------

    def _apply_scope(
        self, base_dir: Path, game_defs: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """按 ``--scope`` 合并三个来源；工坊/我的模组取自数据目录下的子目录。"""

        def load(directory: Path, origin: str) -> list[dict[str, Any]]:
            records: list[dict[str, Any]] = []
            if not directory.is_dir():
                return records
            for file in sorted(directory.glob("*.json")):
                try:
                    payload = json.loads(file.read_text(encoding="utf-8-sig"))
                except (OSError, json.JSONDecodeError):
                    continue
                name = payload.get("name") or file.stem
                for record in payload.get("defs") or []:
                    item = dict(record)
                    # 来源用模组/文件夹名更可读；原始 source 在文件里仍是 workshop:<id>。
                    item["source"] = name
                    item["origin"] = origin
                    records.append(item)
            return records

        workshop = load(base_dir / "workshop", "workshop") if self.scope in ("all", "c") else []
        mine = load(base_dir / "mine", "mine") if self.scope in ("all", "m") else []

        if self.scope == "g":
            return [dict(record, origin="game") for record in game_defs]
        if self.scope == "c":
            return workshop
        if self.scope == "m":
            return mine
        return [dict(record, origin="game") for record in game_defs] + workshop + mine

    # ------------------------------------------------------------------
    # 索引
    # ------------------------------------------------------------------

    def _build_indexes(self) -> None:
        for record in self.defs:
            identity = def_identity(record)
            if identity:
                self._by_identity.setdefault(identity, []).append(record)
                self._by_key[
                    (record.get("defType") or "", identity, record.get("source") or "")
                ] = record
            for field in ("label", "labelZh", "title", "titleZh", "defName", "Name"):
                text = record.get(field)
                if isinstance(text, str) and text:
                    self._label_entries.append((field, text.casefold(), record))

    # ------------------------------------------------------------------
    # 数据版本提示（只检测，不更新）
    # ------------------------------------------------------------------

    def notice(self) -> dict[str, Any]:
        if self._notice_cache is not None:
            return self._notice_cache

        data_version = self.payload.get("gameVersion")
        current_version = None
        if self.game_root is not None:
            version_file = self.game_root / "Version.txt"
            if version_file.is_file():
                try:
                    for line in version_file.read_text(
                        encoding="utf-8-sig", errors="replace"
                    ).splitlines():
                        text = line.strip().lstrip("\ufeff").strip()
                        if text:
                            current_version = text
                            break
                except OSError:
                    current_version = None

        if current_version is None:
            notice = {
                "status": "unknown",
                "dataGameVersion": data_version,
                "gameVersion": None,
                "message": "无法确认游戏版本（Version.txt 不存在或路径失效），数据可能不是当前版本生成的。",
            }
        elif current_version == data_version:
            notice = {
                "status": "current",
                "dataGameVersion": data_version,
                "gameVersion": current_version,
                "message": None,
            }
        else:
            notice = {
                "status": "stale",
                "dataGameVersion": data_version,
                "gameVersion": current_version,
                "message": (
                    f"数据来自 {data_version}，当前游戏为 {current_version}（可能升级或回退）。"
                    "数据未更新；需要时请确认后重新运行提取脚本。"
                ),
            }
        self._notice_cache = notice
        return notice

    # ------------------------------------------------------------------
    # 公共辅助
    # ------------------------------------------------------------------

    def _result(self, record: dict[str, Any]) -> dict[str, Any]:
        """把一条 def 记录整理成查询结果（附父链与提示）。"""
        result = dict(record)
        chain = self.parent_chain(record)
        result["parentChain"] = chain
        notes: list[str] = []
        if record.get("parentResolved") is False:
            notes.append(NOTE_PARENT_UNRESOLVED)
        if record.get("MayRequire") or record.get("MayRequireAnyOf"):
            notes.append(NOTE_MAY_REQUIRE)
        if notes:
            result["notes"] = notes
        return result

    def parent_chain(self, record: dict[str, Any], limit: int = 32) -> list[dict[str, Any]]:
        """返回 ParentName 链（不含自身），逐跳标注是否能定位到记录。"""
        chain: list[dict[str, Any]] = []
        current = record
        seen: set[tuple[str, str]] = set()
        while current.get("ParentName") and len(chain) < limit:
            key = (current.get("defType") or "", current["ParentName"])
            if key in seen:
                chain.append({"detached": True, "reason": "cycle"})
                break
            seen.add(key)

            parent_name = current.get("parentDefName") or current["ParentName"]
            parent_type = current.get("parentDefType") or current.get("defType") or ""
            parent_source = current.get("parentSource") or ""
            parent = self._by_key.get((parent_type, parent_name, parent_source))
            if parent is None:
                chain.append(
                    {
                        "defType": parent_type or None,
                        "defName": parent_name,
                        "resolved": False,
                        "reason": current.get("parentUnresolvedReason") or "not_found",
                    }
                )
                break

            chain.append(
                {
                    "defType": parent.get("defType"),
                    "defName": parent.get("defName"),
                    "Name": parent.get("Name"),
                    "source": parent.get("source"),
                    "abstract": bool(parent.get("Abstract")),
                    "resolved": True,
                }
            )
            current = parent
        return chain

    def _lookup_parent(self, record: dict[str, Any]) -> dict[str, Any] | None:
        name = record.get("parentDefName") or record.get("ParentName")
        if not name:
            return None
        def_type = record.get("parentDefType") or record.get("defType") or ""
        source = record.get("parentSource") or ""
        return self._by_key.get((def_type, name, source))

    def effective_value(self, record: dict[str, Any], field: str, limit: int = 32) -> tuple[Any, int, dict | None]:
        """沿父链取第一个非空字段值（用于 category / thingCategories 这类常写基类的字段）。

        返回 (值, 层数, 来源记录)；自有值层数为 0；找不到返回 (None, 0, None)。
        """
        current = record
        depth = 0
        seen: set[int] = set()
        while current is not None and depth < limit:
            if id(current) in seen:
                break
            seen.add(id(current))
            value = current.get(field)
            if value not in (None, "", []):
                return value, depth, current
            current = self._lookup_parent(current)
            depth += 1
        return None, 0, None

    @staticmethod
    def _matches_scope(record: dict[str, Any], def_type: str | None, include_abstract: bool) -> bool:
        if not include_abstract and record.get("Abstract") is True:
            return False
        if def_type and (record.get("defType") or "").lower() != def_type.lower():
            return False
        return True

    # ------------------------------------------------------------------
    # 四个查询
    # ------------------------------------------------------------------

    def search_def(
        self,
        def_name: str,
        def_type: str | None = None,
        include_abstract: bool = False,
    ) -> list[dict[str, Any]]:
        """按 defName（或抽象模板的 Name）精确查找。"""
        candidates = self._by_identity.get(def_name, [])
        results = [
            self._result(record)
            for record in candidates
            if self._matches_scope(record, def_type, include_abstract)
        ]
        results.sort(key=lambda r: (r.get("defType") or "", r.get("source") or ""))
        return results

    def search_by_label(
        self,
        query: str,
        limit: int = 20,
        include_abstract: bool = False,
    ) -> list[dict[str, Any]]:
        """按 label / title / defName 模糊搜索，支持中英文关键词。"""
        needle = query.casefold().strip()
        if not needle:
            return []

        field_weight = {
            "label": 3.0,
            "labelZh": 3.0,
            "title": 2.5,
            "titleZh": 2.5,
            "defName": 1.0,
            "Name": 1.0,
        }
        scored: list[tuple[float, dict[str, Any], str, str]] = []
        seen: set[int] = set()

        for field, text, record in self._label_entries:
            if not self._matches_scope(record, None, include_abstract):
                continue
            if needle not in text:
                continue
            if text == needle:
                quality = 3.0
            elif text.startswith(needle):
                quality = 2.0
            else:
                quality = 1.0
            score = field_weight.get(field, 0.5) + quality
            key = id(record)
            if key in seen:
                continue
            seen.add(key)
            scored.append((score, record, field, text))

        scored.sort(key=lambda item: (-item[0], def_identity(item[1]) or ""))
        results = []
        for score, record, field, text in scored[: max(1, limit)]:
            result = self._result(record)
            result["matchedField"] = field
            result["matchedText"] = record.get(field)
            result["score"] = round(score, 2)
            results.append(result)
        return results

    def list_by_source(
        self,
        source: str,
        limit: int | None = None,
        include_abstract: bool = False,
    ) -> list[dict[str, Any]]:
        """按 source 过滤（严格按路径判定，不用 MayRequire 推断）。"""
        target = source.casefold()
        rows = [
            record
            for record in self.defs
            if (record.get("source") or "").casefold() == target
            and self._matches_scope(record, None, include_abstract)
        ]
        rows.sort(key=lambda r: (r.get("defType") or "", def_identity(r) or ""))
        if limit is not None:
            rows = rows[: max(1, limit)]
        return [
            {
                "defType": record.get("defType"),
                "defName": record.get("defName"),
                "Name": record.get("Name"),
                "label": record.get("label"),
                "labelZh": record.get("labelZh"),
                "abstract": bool(record.get("Abstract")),
                "sourcePath": record.get("sourcePath"),
            }
            for record in rows
        ]

    def list_by_category(
        self,
        category: str | None = None,
        thing_categories: Iterable[str] | None = None,
        def_type: str | None = None,
        include_abstract: bool = False,
        limit: int | None = 200,
    ) -> list[dict[str, Any]]:
        """按 category 与 thingCategories 组合过滤（两者都是可选条件）。"""
        wanted_categories = [c.casefold() for c in (thing_categories or []) if c]
        wanted_category = category.casefold() if category else None
        if wanted_category is None and not wanted_categories:
            raise ValueError("至少提供 category 或 thingCategories 之一")

        rows: list[dict[str, Any]] = []
        for record in self.defs:
            if not self._matches_scope(record, def_type, include_abstract):
                continue
            category_value, depth, source_record = self.effective_value(record, "category")
            if wanted_category is not None:
                if not isinstance(category_value, str) or category_value.casefold() != wanted_category:
                    continue

            categories_value, categories_depth, categories_source = self.effective_value(
                record, "thingCategories"
            )
            categories_list = [
                str(item) for item in (categories_value or []) if isinstance(item, str)
            ]
            if wanted_categories:
                values = {item.casefold() for item in categories_list}
                if not all(item in values for item in wanted_categories):
                    continue

            rows.append(
                {
                    "record": record,
                    "category": category_value,
                    "categoryDepth": depth,
                    "categoryFrom": (
                        (source_record.get("defName") or source_record.get("Name"))
                        if depth and source_record is not None
                        else None
                    ),
                    "thingCategories": categories_list,
                    "thingCategoriesDepth": categories_depth,
                    "thingCategoriesFrom": (
                        (categories_source.get("defName") or categories_source.get("Name"))
                        if categories_depth and categories_source is not None
                        else None
                    ),
                }
            )

        rows.sort(key=lambda row: (row["record"].get("defType") or "", def_identity(row["record"]) or ""))
        if limit is not None:
            rows = rows[: max(1, limit)]
        return [
            {
                "defType": row["record"].get("defType"),
                "defName": row["record"].get("defName"),
                "label": row["record"].get("label"),
                "labelZh": row["record"].get("labelZh"),
                "category": row["category"],
                "categoryDepth": row["categoryDepth"],
                "categoryFrom": row["categoryFrom"],
                "thingCategories": row["thingCategories"],
                "thingCategoriesDepth": row["thingCategoriesDepth"],
                "thingCategoriesFrom": row["thingCategoriesFrom"],
                "source": row["record"].get("source"),
            }
            for row in rows
        ]

    # ------------------------------------------------------------------
    # 元信息
    # ------------------------------------------------------------------

    def info(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.payload.get("schemaVersion"),
            "supportedSchemaVersion": SUPPORTED_SCHEMA_VERSION,
            "gameVersion": self.payload.get("gameVersion"),
            "generatedAt": self.payload.get("generatedAt"),
            "gameRoot": self.payload.get("gameRoot"),
            "defCount": len(self.defs),
            "sources": [
                {"name": item.get("name"), "defCount": item.get("defCount")}
                for item in self.payload.get("sources") or []
            ],
            "changes": self.payload.get("changes"),
            "notice": self.notice(),
        }


# ----------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    # 全局参数可放在子命令前或后：用 SUPPRESS 避免子解析器的默认值覆盖主解析器已解析的值。
    common.add_argument("--json", default=argparse.SUPPRESS, metavar="FILE", help="数据文件路径（默认 <脚本目录>/../data/rimworld-defs.json）")
    common.add_argument("--game", default=argparse.SUPPRESS, metavar="DIR", help="游戏根目录（默认用 JSON 中记录的 gameRoot）")
    common.add_argument("--output", default=argparse.SUPPRESS, metavar="FILE", help="把结果写入文件而不是 stdout")
    common.add_argument("--pretty", default=argparse.SUPPRESS, action="store_true", help="缩进输出")
    common.add_argument("--unicode", default=argparse.SUPPRESS, action="store_true", help="输出原始中文（默认转义为 \\uXXXX）")
    common.add_argument(
        "--scope",
        default=argparse.SUPPRESS,
        choices=("all", "g", "c", "m"),
        help="来源过滤：g=仅本体与 DLC，c=仅创意工坊，m=仅我的模组；默认 all",
    )

    parser = argparse.ArgumentParser(
        prog="query_defs",
        description="RimWorld Defs 查询层（只读）",
        parents=[common],
    )
    parser.set_defaults(json=None, game=None, output=None, pretty=False, unicode=False)
    sub = parser.add_subparsers(dest="command", required=True)

    def add_scope(p: argparse.ArgumentParser) -> None:
        p.add_argument("--def-type", default=None, help="限定 defType（如 ThingDef）")
        p.add_argument("--include-abstract", action="store_true", help="包含 Abstract 模板")

    p_def = sub.add_parser("search-def", help="按 defName 精确查找", parents=[common])
    p_def.add_argument("name")
    add_scope(p_def)

    p_label = sub.add_parser("search-label", help="按 label/title/defName 模糊搜索", parents=[common])
    p_label.add_argument("query")
    p_label.add_argument("--limit", type=int, default=20)
    add_scope(p_label)

    p_source = sub.add_parser("list-source", help="按 source 列出", parents=[common])
    p_source.add_argument("source")
    p_source.add_argument("--limit", type=int, default=None)
    add_scope(p_source)

    p_cat = sub.add_parser("list-category", help="按 category / thingCategories 过滤", parents=[common])
    p_cat.add_argument("--category", default=None)
    p_cat.add_argument("--thing-categories", nargs="*", default=None)
    p_cat.add_argument("--limit", type=int, default=200)
    add_scope(p_cat)

    sub.add_parser("info", help="显示数据元信息与版本提示", parents=[common])
    return parser


def run_command(data: DefsData, args: argparse.Namespace) -> dict[str, Any]:
    notice = data.notice()
    if args.command == "info":
        return data.info()
    if args.command == "search-def":
        results = data.search_def(args.name, args.def_type, args.include_abstract)
    elif args.command == "search-label":
        results = data.search_by_label(args.query, args.limit, args.include_abstract)
    elif args.command == "list-source":
        results = data.list_by_source(args.source, args.limit, args.include_abstract)
    elif args.command == "list-category":
        results = data.list_by_category(
            category=args.category,
            thing_categories=args.thing_categories,
            def_type=args.def_type,
            include_abstract=args.include_abstract,
            limit=args.limit,
        )
    else:  # pragma: no cover - argparse 已限制
        raise SystemExit(f"未知命令: {args.command}")
    return {"notice": notice, "count": len(results), "results": results}


def emit(payload: dict[str, Any], output: str | None, pretty: bool, unicode: bool) -> None:
    text = json.dumps(payload, ensure_ascii=not unicode, indent=2 if pretty else None)
    if output:
        Path(output).expanduser().write_text(text + "\n", encoding="utf-8", newline="\n")
        return
    sys.stdout.buffer.write((text + "\n").encode("utf-8"))
    sys.stdout.buffer.flush()


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    resolved_path = paths.data_path(args.json)
    resolved_game, _ = paths.game_root(args.game, resolved_path)
    try:
        data = DefsData(resolved_path, resolved_game, scope=getattr(args, "scope", "all"))
    except FileNotFoundError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except json.JSONDecodeError as exc:
        print(f"数据文件无法解析：{exc}", file=sys.stderr)
        return 2

    payload = run_command(data, args)
    emit(payload, args.output, args.pretty, args.unicode)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

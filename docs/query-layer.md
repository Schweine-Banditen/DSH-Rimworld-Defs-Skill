# 查询层（query_defs.py）

`scripts/query_defs.py` 是只读查询层：加载 `data/rimworld-defs.json`，提供四个查询与数据版本提示。**它不修改数据、不触发重建**。

- 可被 Skill 的接入层 `import`；
- 也可作为 CLI 直接调试。

## CLI

```bash
python scripts/query_defs.py info
python scripts/query_defs.py search-def Steel
python scripts/query_defs.py search-def Otter --def-type PawnKindDef
python scripts/query_defs.py search-label 钢 --limit 10
python scripts/query_defs.py list-source Odyssey --limit 20
python scripts/query_defs.py list-category --category Item --thing-categories ResourcesRaw --def-type ThingDef
```

| 参数 | 说明 |
| --- | --- |
| `--json FILE` | 数据文件路径，默认 `<脚本目录>/../data/rimworld-defs.json` |
| `--game DIR` | 游戏目录；默认使用 JSON 中记录的 `gameRoot` |
| `--output FILE` | 写入文件而不是 stdout（推荐，避免 Windows 管道编码问题） |
| `--pretty` | 缩进输出 |
| `--unicode` | 输出原始中文；默认转义为 `\uXXXX` |
| `--def-type` / `--include-abstract` | 限定类型 / 包含 Abstract 模板（默认排除） |
| `--limit` | 结果上限 |

输出结构：

```json
{ "notice": {...}, "count": 1, "results": [...] }
```

## Python API

```python
from pathlib import Path
from query_defs import DefsData

data = DefsData(Path("data/rimworld-defs.json"))
data.notice()                      # 数据是否过期（只检测）
data.search_def("Steel", def_type="ThingDef")
data.search_by_label("钢", limit=10)
data.list_by_source("Odyssey", limit=20)
data.list_by_category(category="Item", thing_categories=["ResourcesRaw"], def_type="ThingDef")
data.parent_chain(record)          # ParentName 链
data.info()                        # 元信息 + notice
```

## 语义约定

| 项 | 约定 |
| --- | --- |
| Abstract 模板 | **默认排除**；`include_abstract=True` 才返回 |
| `search_def` | 精确匹配 `defName` 或抽象模板的 `Name`；同名跨类型会返回多条，需要时用 `def_type` 限定 |
| `search_by_label` | 在 `label`/`labelZh`/`title`/`titleZh`/`defName`/`Name` 上做大小写不敏感的包含匹配；按字段权重与匹配质量排序，结果带 `matchedField`/`score` |
| `list_by_source` | 严格按 `source`（路径判定）过滤，与 `MayRequire` 无关 |
| `list_by_category` | `category` 与 `thingCategories` 都是可选条件（AND）；**两者沿父链取有效值**，结果标注 `categoryDepth`/`categoryFrom` 等 |
| `notice` | `current` / `stale` / `unknown`；**只提示，不自动更新** |
| 父链 | 逐跳标注 `resolved`；找不到时给出原因，不猜测 |

## 为什么 category 要沿父链

原版里 `category` 常写在抽象基类上：`ThingDef Steel` 自己没有 `<category>`，继承自 `ResourceBase` 的 `Item`。若只查自有值，`list_by_category` 会几乎为空。因此查询层对 `category` / `thingCategories` 做**有效值解析**，并明确标注继承层数与来源。

这只用于“过滤与展示”，不代表数据层做了字段合并——JSON 中仍只保留各自声明的原始值。

## 自测

本地自测覆盖：`defCount`、版本提示、精确查找、跨类型同名、中文搜索、来源过滤、category+thingCategories、Abstract 默认排除、缺失返回空。当前全部通过。

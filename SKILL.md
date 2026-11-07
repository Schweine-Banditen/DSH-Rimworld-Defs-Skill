---
name: rimworld-defs-viewer
description: 查询 RimWorld（环世界）原版与官方 DLC 的 Def 定义资料，辅助编写模组 XML：确认 defName 是否存在、由哪个 DLC 定义、label 中英文、category/thingCategories、ParentName 继承链、MayRequire 条件与贴图引用。只返回 XML 模板层信息，不返回游戏运行时合并后的最终值。
---

# RimWorld Defs 查看器

在**编写 RimWorld 模组**时查询 Def 的静态资料：某个 `defName` 是否存在、长什么样、由谁定义、继承自谁、属于什么分类。

## 什么时候用

- 写 `PatchOperation` 前，要确认目标 `defName` 拼写、所属 DLC、是否 `Abstract`。
- 想知道某个 Def 的 `label`（英文/中文）、`category`、`thingCategories`。
- 想确认 `ParentName` 指向的模板是否存在、是否在当前扫描范围内。
- 想知道某条 Def 是否带 `MayRequire` / `MayRequireAnyOf`（原版/DLC 条件加载）。
- 想找某个物品的贴图路径（`graphic.texPath` / `uiIconPath`）。

## 什么时候不用

- 询问**运行时**行为（实际数值、代码逻辑、补丁合并结果）——本数据不含这些，请用游戏内 DevMode 或源码。
- 查询**创意工坊模组**里的 Def——当前数据只扫描原版与官方 DLC。
- 需要 Def 的**全部字段**（`statBases`、`comps`、`verbs`……）——本工具只存少量元数据，应顺着 `sourcePath` 读原始 XML。

## 数据与边界

- 数据文件：仓库根下 `data/rimworld-defs.json`（由 `scripts/extract_defs.py` 生成，gitignore，不入库）。
- 只覆盖 `Data/Core` 与官方 DLC（Royalty、Ideology、Biotech、Anomaly、Odyssey，且按目录自动发现）。
- **静态模板层**：不合并 `ParentName` 的字段；`MayRequire` 只保留原始字符串，不代表“当前一定加载”。
- `Abstract: true` 的条目是模板，不是运行时 Def；查询默认排除它们。

## 路径与数据位置

本 Skill 的 **Base directory 就是仓库根**：`scripts/`、`assets/`、`data/` 都在其下，正文里的相对路径一律相对仓库根解析，**不需要替换任何占位符**。

| 需要什么 | 解析顺序（自高到低） |
| --- | --- |
| 游戏根目录 | `--game` / `RIMWORLD_GAME` → `rimworld-defs.local.json` 的 `gameRoot` → 数据文件里记录的 `gameRoot` → Steam 自动发现（注册表 → `libraryfolders.vdf` → 各库）→ 常见目录兜底 |
| 数据文件 | `--json` / `RIMWORLD_DATA` → 本机配置 `dataPath` → `data/rimworld-defs.json` |
| Python 解释器 | `RIMWORLD_PYTHON` → 本机配置 `pythonExe` → PATH 上的 `python` |

- 仓库内**不含任何绝对路径**；本机差异只放在 `rimworld-defs.local.json`（gitignore）或环境变量里。
- 自检：`python scripts/paths.py --json` 打印每个路径的来源（`env` / `local-config` / `steam` / `derived`）与是否存在；迁移后先用它定位问题。
- 数据文件是**本机生成物**：换机器后重新生成一次，不要从旧机器复制——旧文件内嵌旧的 `gameRoot`，会让 `notice` 变成 `unknown`。

## 查询方式

### 优先：Skill 工具

若接入层已注册以下工具，直接调用：

| 工具 | 参数 | 用途 |
| --- | --- | --- |
| `search_def` | `defName`、可选 `defType`、`includeAbstract` | 精确查 defName（或模板 Name） |
| `search_by_label` | `query`、`limit` | 中英文关键词模糊搜索 |
| `list_by_source` | `source`、`limit` | 按 DLC/来源列出 |
| `list_by_category` | `category`、`thingCategories`、`defType`、`limit` | 按分类组合过滤 |

### 回退：命令行

工具不可用时，在仓库根目录（即 Base directory）执行：

```bash
python scripts/query_defs.py search-def Steel
python scripts/query_defs.py search-def Otter --def-type PawnKindDef
python scripts/query_defs.py search-label 钢 --limit 10
python scripts/query_defs.py list-source Odyssey --limit 20
python scripts/query_defs.py list-category --category Item --thing-categories ResourcesRaw --def-type ThingDef
```

命令输出 JSON：`{ "notice": {...}, "count": n, "results": [...] }`。用 `--output <file>` 写文件再读取，避免 Windows 管道编码问题。

## 典型任务配方

**1. 确认 defName 是否存在、由谁定义**

```
search_def("Gun_Revolver") → 若无结果，说明拼写错误或该 Def 来自未扫描的模组；
有结果时看 defType、source（Core/DLC）、sourcePath。
```

**2. 写 ``<PatchOperationReplace>`` 前确认父级**

```
search_def("Apparel_PowerArmor") → 看 parentChain 与 parentResolved；
parentResolved 为 false 时不要假设字段齐全。
```

**3. 查分类（写 recipe 的 thingCategories、筛选建筑）**

```
list_by_category(defType="ThingDef", thingCategories=["ResourcesRaw"])
```

注意：`category` 常写在抽象基类上，工具返回的 `categoryDepth`/`categoryFrom` 表示继承来源；`category` 与 `thingCategories` 是两个维度，不能互相替代。

**4. 查中英文显示名**

```
search_by_label("钢") / search_by_label("steel")
```

结果里的 `matchedField` 告诉你命中的是 `label`、`labelZh`、`title` 还是 `defName`。

**5. 查贴图路径**

```
search_def("Steel") → graphic.effective.texPath
```

`effective` 是沿父链解析出的有效贴图；`own: false` 表示图来自祖先。贴图文件在游戏根目录 `Assets.zip`，不在 `data/` 里。

**6. 判断内容是否来自 DLC**

```
list_by_source("Royalty") / 看 def 的 source 与 MayRequire
```

`source` 严格按文件路径判定；`MayRequire` 只是原始条件。

## 结果怎么呈现给用户

- 至少给出：`defType`、`defName`、`label`/`labelZh`、`source`。
- 若 `parentResolved: false`，必须说明：“该 Def 的 ParentName 不在扫描范围内，字段可能不完整，请查看 ParentName 指向的模板。”
- 若带 `MayRequire` / `MayRequireAnyOf`，原样展示并标注“原始条件，最终是否加载由游戏运行时决定”。
- 命中多条（同名跨类型）时，列出各自的 `defType` 并询问是否要限定。
- 不要编造未返回的字段；需要更多字段时，读 `sourcePath` 指向的 XML。

## 数据过期时（notice.stale）

查询结果里的 `notice.status`：

| 状态 | 含义 | 处理 |
| --- | --- | --- |
| `current` | 数据与游戏版本一致 | 正常使用 |
| `stale` | 数据来自旧版本 / 游戏已更新或回退 | **先询问用户**，不要自动重建 |
| `unknown` | 找不到 `Version.txt` | 提示数据可能过期，继续使用但说明风险 |

`stale` 时用 `ask_user_question` 询问，选项建议：

1. 立即重建（在仓库根运行 `python scripts/extract_defs.py`，约 2 秒；游戏目录自动发现，非标准安装时加 `--game` 或设 `RIMWORLD_GAME`）；
2. 本次保持旧数据（只在本次运行内不再提示）；
3. 以后都保持旧数据（直到用户主动解除）。

**绝不自动重建**：版本变化可能是升级，也可能是回退；是否更新由用户决定。

## 已知限制

- 不含创意工坊 mod；mod 里的 defName 查不到是正常现象。
- 不合并继承字段：`label`、`statBases` 等可能来自父级，本数据只标注继承状态（`graphic` 与 `category` 例外，已提供 effective 值）。
- 不判断 `MayRequire` 是否满足，不模拟 `PatchOperation`。
- `SongDef` 等少数类型没有 `defName`，无法按名称检索。

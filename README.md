# RimWorld Defs 查看器（DSH Skill）

RimWorld（环世界）XML 定义的**静态参考工具**：由 Python 脚本把游戏 `Defs/` 解析成结构化 JSON，再由 DSH Skill 提供查询工具。

> 当前状态：提取脚本、查询层、DSH 面板（文件树 + 详情 + 贴图/染色/XML/翻译）均已实现。
>
> 维护与交接：见 [AGENTS.md](AGENTS.md)；完整使用手册见 [docs/manual.md](docs/manual.md)。

## 项目构成

1. **提取脚本**（`scripts/extract_defs.py`，Python + lxml）：扫描游戏 `Data/*/Defs` 与 `Languages/*/DefInjected`，产出 `data/rimworld-defs.json`。
2. **DSH Skill**（本仓库 `SKILL.md` + `ui/` 面板）：查询层已实现；四个 DSH 工具的接入层待补。

## 核心边界：静态参考 ≠ 运行时真相

JSON 记录的是 **Def XML 的模板层面信息**（每个 `Def` 节点写了什么、`ParentName` 指向谁、`Abstract` 等声明）。

它**不是**游戏运行时合并后的最终生效值：

- 继承（`ParentName`）后的字段合并结果、`MayRequire` 条件是否满足、代码侧运行时修改（补丁、`DefModExtension`、模组代码动态生成）都不在 JSON 中。
- 因此涉及「运行时实际值」的问题，请以游戏内 DevMode 的 `Def` 查看器或实际加载日志为准。

## 技术栈

| 项 | 选型 |
| --- | --- |
| 脚本语言 | Python 3.11+（本机 3.14.4） |
| XML 解析 | `lxml`（必须；不使用 `xmltodict` / 标准库 `ElementTree`） |
| CLI 参数 | `argparse`（标准库足够，脚本无子命令树，避免引入额外依赖） |
| 工具注册 | 自写薄 TS 壳 + 官方 `@deepseek-ai/*` 包（不使用第三方 bridge 包） |

依赖安装：`lxml==6.1.3` 已装入本机 `D:\tools\python`（`pip install lxml==6.1.3`），解析脚本直接调用 `python` 即可运行。

## 目录结构

```text
.
├── AGENTS.md                 # 后续会话的项目规则（必读）
├── SKILL.md                  # DSH Skill 入口（frontmatter: name + description）
├── README.md                 # 本文件
├── scripts/
│   ├── extract_defs.py       # 提取脚本（唯一入口）
│   ├── query_defs.py         # 查询层（只读，可 import / CLI）
│   ├── render_icon.py        # 从 Assets.zip 解码 DDS 贴图为 PNG
│   └── verify_defs.py        # 抽样校验（测试专用，不参与运行时）
├── docs/
│   ├── manual.md             # 使用与维护手册
│   ├── query-layer.md        # 查询层 API 与语义
│   └── verify-testing.md     # 校验工具使用说明
├── assets/
│   └── placeholder.jpg       # 贴图缺失时的占位图
├── ui/                       # DSH 面板 bundle（Host 路由 + Client 面板）
└── data/                     # 生成的 JSON（.gitignore 忽略）
    ├── .gitkeep
    └── .gitignore
```

## 提取脚本用法

```bash
# 默认输出到本仓库 data/rimworld-defs.json
python scripts/extract_defs.py --game "E:\SteamLibrary\steamapps\common\RimWorld"

# 输出到别处 + 缩进（人工检查用）
python scripts/extract_defs.py --game "<RimWorld 根目录>" --output ./sample.json --pretty
```

| 参数 | 说明 |
| --- | --- |
| `--game DIR` | 必填，RimWorld 根目录（其下须存在 `Data/Core/Defs`），否则退出码 2 |
| `--output FILE` | 可选，默认 `<脚本目录>/../data/rimworld-defs.json`（基于 `__file__`，不写死绝对路径） |
| `--pretty` | 缩进输出；默认紧凑 JSON（6.0 MB vs 8.3 MB） |
| `--check` | 只比对该 JSON 的 `gameVersion` 与当前游戏版本；不扫描、不写文件。退出码：`0`=一致，`1`=需要重新生成，`2`=路径错误 |
| `--language NAME` | 采集的 DefInjected 语言目录名，默认 `ChineseSimplified (简体中文)` |
| `--no-translations` | 跳过翻译采集（只输出英文 `label`/`title`） |

扫描范围：`Data/*/Defs`（**自动发现**）。已知 DLC 按 `Core → Royalty → Ideology → Biotech → Anomaly → Odyssey` 排序，游戏新增的 DLC 目录按字母序追加，脚本无需改动即可采集。不存在的目录跳过；**不扫描创意工坊 mod**。

翻译范围：`Data/<source>/Languages/<语言>/DefInjected`（目录形式）与 `Data/<source>/Languages/<语言>.tar`（DLC 只提供 tar）。目录优先，同字段不覆盖。

### 随游戏更新

游戏版本变了（`Version.txt` 变化）就重跑同一条命令即可，脚本会整份重建数据并原子替换：

```bash
python scripts/extract_defs.py --game "<RimWorld 根目录>"          # 重建
python scripts/extract_defs.py --game "<RimWorld 根目录>" --check  # 确认最新（退出码 0）
```

- JSON 内的 `gameVersion` 取自游戏根目录 `Version.txt`，`schemaVersion` 表示输出结构版本；
- 写入采用「临时文件 + 原子替换」，中途失败不会留下半个 JSON；
- 重建时会读一次旧 JSON 生成 `changes`，随后旧文件被覆盖（不保留历史数据）；
- `--check` 只做廉价版本比对（不扫描 XML）；若怀疑 XML 被改但版本号未变，直接重跑即可。

## 查询层

```bash
python scripts/query_defs.py info
python scripts/query_defs.py search-def Steel
python scripts/query_defs.py search-label 钢 --limit 10
python scripts/query_defs.py list-source Odyssey --limit 20
python scripts/query_defs.py list-category --category Item --thing-categories ResourcesRaw --def-type ThingDef
```

只读：不修改数据、不触发重建。四个查询与版本提示的语义见 [docs/query-layer.md](docs/query-layer.md)。

## 输出结构

顶层：

```json
{
  "schemaVersion": 4,
  "generatedAt": "...",
  "gameVersion": "1.7.5000 rev1275",
  "gameRoot": "...",
  "sources": [...],
  "defs": [...],
  "errors": [...]
}
```

- `schemaVersion`：输出结构版本；字段含义变化时递增，Skill 侧据此判断能否读取
- `gameVersion`：来自游戏根目录 `Version.txt`，用于判断数据是否过期
- `sources`：每个被扫描目录的 `{name, path, fileCount, defCount}`
- `errors`：单个 XML 解析失败时记录 `{sourcePath, error}` 并继续，不会整体中断
- `defs`：按扫描顺序（Core 优先）→ `defType` → `defName/Name` 稳定排序
- `changes`：本次数据相对上一份数据的差异（见下）

### 变更记录（changes）

每次重建时读取上一份 JSON（仅这一次，不保留），按 `defType + 标识 + source + 是否抽象` 比对，写入：

```json
"changes": {
  "comparedTo": {"gameVersion": "1.6.4566 rev607", "generatedAt": "..."},
  "firstBuild": false,
  "note": null,
  "summary": {"added": 12, "removed": 3, "changed": 45},
  "items": [
    {"defType": "ThingDef", "defName": "X", "kind": "changed", "fields": ["label", "labelZh"]}
  ],
  "itemsTruncated": false
}
```

- `kind`：`added` / `removed` / `changed`；`changed` 记录到字段级
- `items` 最多 1000 条，超出时 `itemsTruncated: true`（计数仍完整）
- 首次生成或旧数据结构不兼容时 `firstBuild: true`，`note` 说明原因

同时维护 `data/changes-history.json`（与数据文件同目录，gitignore）：

- 只保留 **2 条**记录（当前 + 上一次）；第三次更新会挤掉最早的一条；
- 每条含 `gameVersion`、`comparedTo`、`summary`、`items`；
- 供 Skill 展示「上一次更新改了什么」。

单条 Def 字段：

| 字段 | 含义 |
| --- | --- |
| `defType` | Def 类型（XML 标签名，已归并大小写变体） |
| `defName` | 具体 def 的标识；部分类型（如 `SongDef`）没有 |
| `Name` | 抽象模板的标识（`ParentName` 引用的就是它或 `defName`） |
| `label` | `<label>` 文本（显示名） |
| `labelZh` | 中文显示名（来自 DefInjected；422 个 def 没有英文 `label` 但有中文） |
| `title` | `<title>` 文本（`BackstoryDef` 等没有 `label` 的类型用它） |
| `titleZh` | 中文 `title`（来自 DefInjected） |
| `ParentName` | 原始父级标识字符串，**不做合并** |
| `parentResolved` | `true` / `false` / `null`（无 ParentName） |
| `parentDefName` | 解析到的父级标识 |
| `parentDefType` | 父级的 defType（可能与本条不同，见「跨类型继承」） |
| `parentSource` | 父级所在 source |
| `parentUnresolvedReason` | 仅在 `false` 时出现：`not_in_scan_scope` |
| `Abstract` | `true` 表示模板，不进入游戏 `DefDatabase` |
| `Class` | Def 元素的 `Class` 属性（原版数据未出现，保留以兼容模组） |
| `MayRequire` / `MayRequireAnyOf` | 原始条件字符串，**不判断当前是否满足** |
| `category` | `<category>` 顶层大类；**语义随 defType 变化**（ThingDef 为 `Item/Building`，StatDef 为 `PawnWork` 等），跨类型混用无意义 |
| `thingCategories` | `<thingCategories><li>` 细分类列表（可能与 `category` 同时存在） |
| `graphic` | 贴图引用：`texPath` / `graphicClass` / `uiIconPath`（自有）+ `own` + `effective`（沿父链解析出的有效贴图与来源） |
| `fields` | 常用属性：`scalars`（size/stackLimit/thingClass…）、`statBases`（沿父链合并，标注继承来源）、`building`（存储组/过滤/优先级）、`comps`（最近来源的组件与标量属性） |
| `conditionalFields` | 顶层子元素上的字段级条件（如某个字段只在 Odyssey 下生效） |
| `source` | `Core`/`Royalty`/…，**严格按文件路径判定** |
| `sourcePath` | 相对游戏根目录的路径（正斜杠） |

## 贴图引用（graphic）

`graphic` 只存**引用**，不存图片副本。原版纹理在游戏根目录 `Assets.zip` 内（ZIP 方法 93 = ZSTD，需 Python 3.14；条目形如 `Resources/Textures/Things/Item/Resource/Steel/Steel_a.psd.dds.split`，内容为 DDS）。

```json
"graphic": {
  "texPath": null,
  "graphicClass": null,
  "uiIconPath": null,
  "own": false,
  "effective": {
    "texPath": "Things/Item/Resource/Steel",
    "graphicClass": "Graphic_StackCount",
    "from": "ThingDef:SteelBase",
    "depth": 1
  }
}
```

- `texPath` / `graphicClass` / `uiIconPath`：该 Def **自己写的**值（没有则为 `null`）；
- `own`：是否自带 `texPath`；
- `effective`：沿 `ParentName` 链找到的第一个有图祖先（`from: "self"` 表示自己），供 UI 直接取图；
- 无静态贴图的 Def（如动物走 PawnRenderTree、抽象模板）`effective` 为 `null`，UI 回落到占位图 `assets/placeholder.jpg`。

## 属性字段（fields）

为「物品/建筑有哪些属性」提供静态视图，全部沿父链标注来源：

```json
"fields": {
  "scalars": {"size": {"value": "(2,1)", "from": "self"}},
  "statBases": {"value": {"MaxHitPoints": "100"}, "from": "merged",
                "inheritedFrom": {"Beauty": "ThingDef:ShelfBase"}},
  "building": {"value": {"storageGroupTag": "Shelf", "defaultStorageSettings": {"priority": "Preferred", "categories": ["Foods"]}},
               "from": "ThingDef:StorageShelfBase"},
  "comps": {"value": [{"class": "CompProperties_Styleable", "props": {}}], "from": "ThingDef:ShelfBase"}
}
```

- `statBases` 是**模板级合并**（父先子后），只用于展示；`inheritedFrom` 标出哪些键来自祖先；
- `building` 提供 `storageGroupTag`、过滤类别与优先级——**具体能存多少格/覆盖范围由 `Building_Storage` 在运行时决定，XML 中没有数字**；
- `comps` 取最近一个定义处，只收类名与标量属性，不展开嵌套结构。

## ParentName 解析规则

继承在游戏里是**按标识全局查找**的（真实数据存在 `FleckDef` 继承 `ThingDef`、`StructureLayoutDef` 继承 `StructureStructureLayoutDef` 这类跨类型继承），因此索引不按 defType 过滤，而是按标识建全局索引，候选按以下优先级取一个：

1. 同 defType + 同 source
2. 同 defType + Core
3. 同 defType + 其它 source
4. 同 source + 任意 defType
5. Core + 任意 defType
6. 其它

找不到 → `parentResolved: false` + `parentUnresolvedReason: "not_in_scan_scope"`，**不猜测**模组或未扫描目录。

## 真实数据特性（实现时已处理）

- **defType 大小写变体**：`BackStoryDef`（1 处）归并为 `BackstoryDef`，`jobDef`（6 处）归并为 `JobDef`。
- **Abstract 模板与具体 def 同名**：例如 `PawnKindDef Mercenary_Slasher` 既有抽象模板又有具体 def，`defName` 重复属正常；查询层应按 `Abstract` 过滤。
- **无 defName 的 Def**：`SongDef` 共 77 个，其中 53 个没有 `defName`（只有 `clipPath` 等字段）；查询时不可按 `defName` 命中。
- **跨类型继承**：8 处（`FleckDef→ThingDef`、`ThingDef→FleckDef`、`StructureLayoutDef→StructureStructureLayoutDef` 等）。
- **字段级 MayRequire**：101 个 def 的某个顶层子元素带条件，记录在 `conditionalFields`。
- **中文翻译的两种载体**：Core 为 `DefInjected` 目录（514 个文件），DLC 只有 `<语言>.tar`；脚本两者都读。
- **中文 label 多于英文 label**：422 个 def 没有英文 `label`，但有中文翻译（英文名来自基类继承）。

## 参考规模（原版 + 5 DLC）

| 项 | 值 |
| --- | --- |
| Def 总数 | 14084 |
| 含 ParentName | 4554（全部在扫描范围内解析成功） |
| 翻译条目 | 39,010（目录 514 文件 + tar 1470 文件） |
| 中文 label / title | 6493 / 845 |
| 贴图（自有/继承/无图） | 1796 / 249 / 11959 |
| XML 解析错误 | 0 |
| 输出体积 | 紧凑 8.1 MB / 缩进 11.9 MB |
| 提取耗时 | 约 2.4 s |

## 生成数据不入库

`data/*.json` 由游戏内容派生，体积大且含 Ludeon 版权内容，默认不提交（`data/.gitignore` 已忽略）。需要分发时在目标机本地生成。

## 可视化面板（ui/）

`ui/` 是一个 DSH bundle：Host 半注册本机路由（`/rimworld-defs/api/*`），Client 半在侧栏注册入口并渲染面板。

- 左侧文件树：来源（Core / DLC）→ 分类（武器与装备、物品、建筑、植物、动物与生物、生产与配方、研究、能力与状态、世界与地形、其他）→ Def；
- 右侧结构树：根节点为贴图 + 名称，下分「属性」（含 `fields` 展开）与「来源与继承」；
- 搜索：中英文关键词，结果保留在左侧，可点 × 清除；命中后自动展开树路径并有动画；
- 贴图：Host 调 `scripts/render_icon.py` 从 `Assets.zip` 解码 DDS，失败回落 `assets/placeholder.jpg`。

安装（会改动 profile 全局状态）：

```bash
# 由 DSH 的 plugin_manager 安装本目录，例如：
# install_bundle target=E:\DataE\condex_file\git_repository\RimWorld_Mod\ui
```

`ui/cordis.patch.yml` 里是**本机绝对路径**（数据、游戏、Python、渲染脚本、占位图），移动仓库或换机后需要修改并重装。

## 待决事项

1. **Skill 查询层**：四个工具（`search_def`、`search_by_label`、`list_by_source`、`list_by_category`）尚未实现。
2. **bundle 打包与安装**：薄 TS 壳需要打成 bundle 装进 DSH profile 才能全局可见；安装会改变 profile 状态，动手前单独确认。
3. **数据文件位置（打包后）**：装成 bundle 后 `Path(__file__)` 指向 `node_modules`，而 JSON 是本地生成物；拟「默认技能目录、允许配置覆盖」。

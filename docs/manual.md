# RimWorld Defs Viewer 使用与维护手册

> 面向：项目使用者（写模组时查资料）与后续维护者（改代码/更新数据）。
> 仓库：`E:\DataE\condex_file\git_repository\RimWorld_Mod`

## 1. 这是什么

RimWorld 1.7（原版 + 官方 DLC）的 **Def 静态查看器**：

- Python 脚本把游戏 `Data/*/Defs` 的 XML 解析成 JSON；
- Python 查询层提供四个查询（精确查找、按名称搜索、按来源、按分类）；
- DSH 面板在 Web GUI 里提供文件树、详情、贴图、材质预览、XML 预览与翻译表。

**适用场景**：写 `PatchOperation` 前确认 defName/父级/分类；查中英文名；查 `statBases`、存储设置、贴图路径；判断内容属于哪个 DLC。

## 2. 边界（必须理解）

- 只记录 **XML 模板层**：不做继承字段合并（`fields.statBases` 的合并仅用于展示）；
- `MayRequire` 只保留原始字符串，不判断当前是否加载；
- 不含创意工坊 mod；不模拟 `PatchOperation` / 运行时行为；
- 需要完整字段或运行时值，以 `sourcePath` 指向的 XML、游戏内 DevMode 为准。

## 3. 功能一览

| 功能 | 说明 |
| --- | --- |
| 左侧文件树 | 来源（Core/DLC）→ 分类（武器与装备、物品、建筑、植物、动物与生物、生产与配方、研究、能力与状态、世界与地形、其他）→ Def |
| 顶部固定栏 | 收起全部（⤒）、搜索框、清除 × |
| 搜索 | 中英文关键词，结果保留；点击后自动展开树路径并高亮 |
| 右侧结构树 | 根卡片（贴图 + 名称）；「属性」分支（含关键字段、statBases、存储/建筑、comps）；「来源与继承」分支（来源、类型、ParentName 链、贴图、sourcePath） |
| 材质预览 | 可染色物品（服饰 / 有 `costStuffCount`）根卡片右下角下拉：默认、钢铁、玻璃钢、铀矿 |
| XML 预览 | 鼠标悬停 `sourcePath` 显示该 Def 附近的 XML 片段 |
| 翻译设置 | 右上角齿轮 → 翻译表：英文关键字段 → 自定义中文；带搜索；保存在浏览器 localStorage |
| 数据状态 | 顶部状态芯片：最新 / 过期 / 未知；过期时显示提示 |
| 变更记录 | 数据文件内 `changes`：新增/删除/改动（字段级，最多 1000 条）；`data/changes-history.json` 保留 2 条 |

## 4. 安装与更新（DSH 面板）

面板是一个 DSH bundle，位于 `<repo>/ui`，以 link 方式安装进 profile `desktop`。

```text
安装：plugin_manager install_bundle   target = E:\DataE\condex_file\git_repository\RimWorld_Mod\ui
更新：plugin_manager remove_bundle   target = @local/dsh-rimworld-defs
      plugin_manager install_bundle   target = <同上>
```

- 安装/更新后**刷新页面**（客户端 bundle 不会自动热更，除非同时跑 dev watcher）；
- `ui/cordis.patch.yml` 是**本机绝对路径**配置：`dataPath`、`gameRoot`、`pythonExe`、`renderScript`、`placeholderPath`、`cacheDir`、`unityPyPath`；
- 移动仓库或换机后必须改这些路径并重装。

## 5. 数据更新流程

游戏更新后：

```bash
# 1) 检查数据是否过期（0=一致，1=需重建，2=路径错误）
python scripts/extract_defs.py --game "E:\SteamLibrary\steamapps\common\RimWorld" --check

# 2) 重建（约 2.4 s，原子写入；自动对比上一份并写 changes）
python scripts/extract_defs.py --game "E:\SteamLibrary\steamapps\common\RimWorld"

# 3) 抽样校验（可选，但建议）
python scripts/verify_defs.py --json data/rimworld-defs.json --game "E:\SteamLibrary\steamapps\common\RimWorld" --samples 100
```

- 数据文件 `data/rimworld-defs.json`（schema 4）与 `data/changes-history.json` 均被 gitignore，不进仓库；
- **不会自动重建**：UI 只显示“数据过期”，是否更新由人决定（版本变化可能是回退）；
- 提取脚本自动发现 `Data/*/Defs`，新 DLC 目录无需改代码。

## 6. 查询层（CLI）

```bash
python scripts/query_defs.py info
python scripts/query_defs.py search-def Steel
python scripts/query_defs.py search-def Otter --def-type PawnKindDef
python scripts/query_defs.py search-label 钢 --limit 10
python scripts/query_defs.py list-source Odyssey --limit 20
python scripts/query_defs.py list-category --category Item --thing-categories ResourcesRaw --def-type ThingDef
```

- 输出 `{ notice, count, results }`；`--output` 写文件可避开 Windows 管道编码问题；
- Abstract 模板默认排除；`category` / `thingCategories` 沿父链取有效值并标注来源。

## 7. 目录结构

```text
.
├── AGENTS.md                 # 后续会话的项目规则（必读）
├── SKILL.md                  # DSH Skill 说明（给模型）
├── README.md                 # 项目简介
├── docs/
│   ├── manual.md             # 本手册
│   ├── query-layer.md        # 查询层 API/语义
│   └── verify-testing.md     # 校验工具说明
├── scripts/
│   ├── extract_defs.py       # 提取（XML → JSON）
│   ├── query_defs.py         # 查询层（库 + CLI）
│   ├── render_icon.py        # 贴图解码（Assets.zip / DLC AssetBundles）
│   └── verify_defs.py        # 抽样校验（测试专用）
├── ui/                       # DSH bundle（Host 路由 + Client 面板）
├── assets/placeholder.jpg    # 贴图缺失占位
└── data/                     # 生成数据（gitignore）
```

## 8. 技术栈与架构

```text
XML（Data/*/Defs、Languages DefInjected）
   │ extract_defs.py（lxml；中文标签来自目录 + DLC tar）
   ▼
JSON（schema 4：sources/defs/fields/graphic/changes）
   │ query_defs.py（只读；四个查询 + notice）
   ▼
ui/index.js（Host 路由，本机 127.0.0.1:53701）
   │ /meta /index /def /search /keys /icon /xml /placeholder
   ▼
ui/client.js（React 面板：sidebar.panellist + main）
```

- Python 3.14（必须：`Assets.zip` 的 ZSTD 需要 3.13+）；lxml；Pillow；
- DLC 贴图：UnityPy 读 `Data/<DLC>/AssetBundles/resources_<dlc>`；
- UI 无构建步骤，React 由浏览器模块表提供。

## 9. 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| Core 物品显示占位图 + 提示 | `Assets.zip` 的 `.split` 贴图格式未解析 | 已知限制；DLC 正常。见 AGENTS.md §6 |
| DLC 图标不显示 | UnityPy 缺失或 `unityPyPath` 失效 | `pip install UnityPy` 到 `D:\tools\python`，改配置并重装 |
| 面板不出现 | bundle 未安装 / 页面未刷新 | 重新安装 bundle，刷新页面 |
| 数据过期提示 | 游戏版本与数据不一致 | 按 §5 重建；是否重建由人确认 |
| 搜索无结果 | 该 Def 来自 mod，或数据未包含 DLC | 确认来源；本工具只扫原版 + 官方 DLC |
| 属性中文没出现 | 翻译未保存 | 设置 → 翻译 → 输入后自动保存；刷新仍生效 |

## 10. 维护流程（严格 Git）

1. **先 `git status`**，工作区干净再开分支：`feature/*`、`fix/*`、`docs/*`；禁止直接在 `main` 提交。
2. 小步提交，中文 Conventional Commits（`feat(ui): …`、`fix(scripts): …`）。
3. 提交前跑检查：
   ```bash
   python -m py_compile scripts/*.py
   node --check ui/index.js ui/client.js
   python scripts/extract_defs.py --game "<根>" --check
   ```
   数据变更时再跑一次 `verify_defs.py`。
4. 合并：`git merge --no-ff <branch>`，随后删除分支。
5. 禁止 force push、改写历史、擅自添加 remote 或推送。
6. 安装/卸载 bundle 会改 profile 全局状态，先征得使用者同意。
7. 每次功能合并后更新本手册与 `AGENTS.md` 的“已知限制/下一步”。

## 11. 当前版本状态（供交接）

- 提交历史：见 `git log --oneline`；最近合并为「材质染色预览 / XML 悬停 / 翻译设置」。
- 数据：schema 4，14,084 Defs。
- 已实现：提取、查询层、校验、面板（树/详情/贴图/染色/XML/翻译）、数据变更记录。
- 未实现：Core `.split` 贴图解码、DSH `@tool` 注册、遮罩染色、UI i18n。

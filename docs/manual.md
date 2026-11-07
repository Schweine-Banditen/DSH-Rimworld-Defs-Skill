# RimWorld Defs Viewer 使用与维护手册

> 面向：项目使用者（写模组时查资料）与后续维护者（改代码/更新数据）。
> 仓库：`<repo>`（本机实际路径见 `AGENTS.md` §9；工具本身不依赖绝对路径）。

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
安装：plugin_manager install_bundle   target = <repo>\ui
更新：plugin_manager remove_bundle   target = @local/dsh-rimworld-defs
      plugin_manager install_bundle   target = <同上>
```

- 安装/更新后**刷新页面**（客户端 bundle 不会自动热更，除非同时跑 dev watcher）；
- **路径不再写在 `ui/cordis.patch.yml` 里**：由 `ui/paths.js` 解析（环境变量 → `rimworld-defs.local.json` → 面板 config → 仓库位置派生）。`dataPath`、`renderScript`、`placeholderPath`、`cacheDir` 全部由仓库位置推出，不需要配置；
- `gameRoot` 是唯一需要外部信息的项：先自动发现（Steam 注册表 → `libraryfolders.vdf` → 候选目录），失败时用 `RIMWORLD_GAME` 或本机配置；
- `/meta` 的 `paths` 会列出每条路径的 `source`（`env` / `local-config` / `derived` / `steam` / `data-file`）与 `valid`，迁移后先看它；
- 换机流程：`git clone` → `python scripts/extract_defs.py` → 重建工作区联接（见 §4.1）→ 重装/刷新面板。

### 4.1 Skill 发现：工作区联接（不装 bundle、不改全局 profile）

本项目有两半：**面板**由 `ui/` bundle 提供；**`SKILL.md`（给模型的操作手册）**由 DSH 的 filesystem skill 提供方扫描目录发现。后者不需要安装，但必须放在 DSH 会扫描的位置。

本机采用「工作区联接」：只在**当前工作目录**生效，不改全局 profile。

```powershell
# 建（每台主机 / 每个工作目录一次；同盘、无需管理员权限）
# <workspace> = 会话的工作目录；<repo> = 本仓库目录
New-Item -ItemType Junction `
  -Path '<workspace>\.dsh\skills\RimWorld_Mod' `
  -Target '<repo>'
```

- DSH 扫描 `<项目根>/.dsh/skills`；项目根 = 最近的含 `.git` 的祖先目录，没有则是会话的当前工作目录；
- **必须与仓库同盘**（本机都在 `E:`）。跨盘只能改用目录符号链接，需要管理员或开发者模式；
- 发现是**即时**的：建好联接后下一轮对话就能在技能目录里看到 `rimworld-defs-viewer`，**无需重启**；
- 删除：`cmd /c rmdir "<workspace>\.dsh\skills\RimWorld_Mod"`（只删链接，不碰仓库内容）；
- 该目录（`.dsh/`）不属于本仓库，也不进 git。

为什么不用全局配置：改 `~/.dsh/profiles/<profile>/cordis.patch.yml` 的 `customSkillDirs` 也能生效，但那是**进程级**配置，会影响该 profile 下所有会话；本仓库只需要服务固定工作目录，故用会话级的项目根。

### 4.2 智能体工具（设置 → 智能体工具）

面板的 Host 半在启动时把查询层注册为 DSH 工具，会话里可直接调用：

| 工具 | 参数 | 用途 |
| --- | --- | --- |
| `rimworld_search_def` | `defName`、可选 `defType`、`includeAbstract` | 精确查 defName（或抽象模板 Name） |
| `rimworld_search_by_label` | `query`、`limit` | 中英文关键词模糊搜索 |
| `rimworld_list_by_source` | `source`、`limit` | 按来源列出 |
| `rimworld_list_by_category` | `category`、`thingCategories`、`defType`、`limit` | 按分类组合过滤 |

- 工具**不重写查询逻辑**，一律调用 `scripts/query_defs.py`，语义与命令行完全一致；
- 注册用作用域 `ctx.inject(['tools'])`：没有 `tools` 服务的环境（headless / 精简 profile）自动跳过，面板照常工作；
- 面板右上角齿轮 → **智能体工具**：列出每个工具的名称、参数、必填与用法，并标注「已注册 / 未注册」；该页**不需要任何配置**；
- 显示「未注册」时：看启动日志里的 `已注册 N 个智能体工具`，确认当前 profile 是否加载了 `tools` 服务；
- `ui/tools.js`、`ui/query.js` 属于 Host 半，改动后**需要重启 DSH** 才生效。

## 5. 数据更新流程

游戏更新后：

```bash
# 0) 先看路径解析结果（游戏目录/数据/解释器各来自哪里、是否存在）
python scripts/paths.py --json

# 1) 检查数据是否过期（0=一致，1=需重建，2=路径错误）
python scripts/extract_defs.py --check

# 2) 重建（约 2.4 s，原子写入；自动对比上一份并写 changes）
python scripts/extract_defs.py

# 3) 抽样校验（可选，但建议；路径同样自动解析）
python scripts/verify_defs.py --samples 100
```

- 游戏目录**自动发现**：`--game` / `RIMWORLD_GAME` → `rimworld-defs.local.json` → 数据文件记录 → Steam（注册表 + `libraryfolders.vdf`）；三个脚本都支持省略路径参数；

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
│   ├── paths.py              # 本机路径解析（游戏目录/数据/解释器）
│   └── verify_defs.py        # 抽样校验（测试专用）
├── ui/                       # DSH bundle（Host 路由 + Client 面板）
├── assets/placeholder.jpg    # 贴图缺失占位
├── rimworld-defs.local.example.json  # 本机覆盖模板（实际文件 gitignore）
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
| DLC 图标不显示 | UnityPy 缺失或 `unityPyPath` 失效 | `pip install UnityPy` 到 `python` 所在环境，删掉该配置并重装 |
| 面板不出现 | bundle 未安装 / 页面未刷新 | 重新安装 bundle，刷新页面 |
| Skill 不出现（面板正常） | 工作区联接缺失、失效或跨盘 | 重建 junction；确认会话 cwd 在该工作区（见 §4.1） |
| 提示找不到游戏目录 | 非标准安装 / 自动发现失败 | `python scripts/paths.py --json` 看来源，再设 `RIMWORLD_GAME` 或写本机配置 |
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
8. **对既有代码做大范围修改前先询问可行性**：说明影响面、风险与回滚方案，获得确认后再动手。

## 11. 当前版本状态（供交接）

- 提交历史：见 `git log --oneline`。
- 数据：schema 4，14,084 Defs。
- 已实现：提取、查询层、校验、面板（树/详情/贴图/染色/XML/翻译）、数据变更记录、路径解析（env + 本机配置 + Steam 自动发现）、Skill 发现（工作区联接）、四个智能体工具、文件树展开/收起动画。
- **待处理优化**：
  1. **Core 贴图渲染**：`Assets.zip` 里的 `.split` 容器尚未解码，Core 物品显示占位图；可行路线是"运行时导出模组"或"逆向容器"（见 `AGENTS.md` §6.1、§7.1）。
  2. **遮罩染色**：护甲与部分服装是灰度图，需按 def 的 `color` / 材料色上色。
  3. **UI i18n**：界面文案仍写死中文，`locale/*.json` 尚未接入。

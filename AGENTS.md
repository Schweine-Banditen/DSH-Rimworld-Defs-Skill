# RimWorld Defs Viewer —— 项目规则与交接（后续会话必读）

本文件写给**之后的 AI 会话或协作者**。开始任何工作前先读本文件；它与项目代码同级，优先于个人习惯。

## 0. 一句话

RimWorld 1.7（原版 + 官方 DLC）的 **Def 静态查看器**：Python 抽取 XML → JSON → Python 查询层 → DSH 面板（Host 本机路由 + Client 侧栏页面）。用于辅助编写模组时查 defName、分类、继承、属性与中英文名。

## 1. 关键路径（不含本机绝对路径）

| 项 | 路径 |
| --- | --- |
| 仓库 | `<repo>`（可位于任意目录；工具不依赖它的绝对位置） |
| 游戏根目录 | 自动发现：`RIMWORLD_GAME` → 本机配置 → 数据文件记录 → Steam（注册表 + `libraryfolders.vdf`）→ 候选目录 |
| 数据文件 | `<repo>/data/rimworld-defs.json`（`schemaVersion` 4，gitignore） |
| 变更历史 | `<repo>/data/changes-history.json`（gitignore，保留 2 条） |
| 图标缓存 | `<repo>/data/icon-cache/`（gitignore） |
| Python | PATH 上的 `python`；或 `RIMWORLD_PYTHON` / 本机配置 `pythonExe` |
| UnityPy | 可选依赖，用本机配置 `unityPyPath` 指向（临时安装即可，见 §6） |
| UI bundle | `<repo>/ui`（以 link 方式装进 DSH profile） |
| DSH profile | 由 DSH 管理，不在仓库内 |
| 本机路径覆盖 | `<repo>/rimworld-defs.local.json`（gitignore；模板见 `.example.json`） |
| Skill 发现 | `<workspace>/.dsh/skills/<名称>` → 仓库根（目录联接，会话级；见 `docs/manual.md` §4.1） |

本机实际路径见 §9；发布前该节整节删除。

## 2. 架构（四层）

```text
Data/*/Defs + DefInjected（目录与 DLC .tar）
        │  scripts/extract_defs.py（lxml）
        ▼
data/rimworld-defs.json（schema 4：defs/fields/graphic/changes）
        │  scripts/query_defs.py（只读查询层，CLI 与库）
        ▼
ui/（DSH bundle：Host 路由 + Client 面板）
   Host：/meta /index /def /search /keys /icon /xml /placeholder
   Client：sidebar.panellist + main 槽位；文件树 + 结构树 + 设置页
        ▼
DSH Web GUI（本机回环，端口由 DSH 分配，不联网）
```

- **提取层**：`scripts/extract_defs.py`，输出 schema 4；含 `fields`（scalars/statBases/building/comps）、`graphic`（含 `effective`）、`changes`。
- **查询层**：`scripts/query_defs.py`，四个查询 + `notice`；只读，不自动重建。
- **接入层**：`ui/index.js`（Host 路由）与 `ui/client.js`（React 面板）。
- **文档层**：`SKILL.md`（给模型的行为约定）、本文件、`docs/manual.md`。

## 3. 技术栈

- Python 3.14（必须：读 `Assets.zip` 的 ZSTD 需要 3.13+）、lxml、Pillow。
- DLC 贴图：UnityPy（读 `Data/<DLC>/AssetBundles/resources_<dlc>`）。
- UI：纯 JS（无构建步骤）+ React（浏览器模块表提供），DSH bundle（`dsh.bundle.patch` + `dsh.client`）。
- 数据：JSON；不引入数据库。

## 4. Git 工作流（**严格**，必须遵守）

1. **每次开始先 `git status`**；工作区不干净时先解释原因，不要直接覆盖。
2. **禁止直接在 `main` 上开发/提交**（用户明确要求时除外）。所有改动走分支：
   - 功能：`feature/<主题>`，修复：`fix/<主题>`，文档：`docs/<主题>`。
3. 提交信息用**中文 Conventional Commits**：`feat(ui): …`、`fix(scripts): …`、`docs: …`、`test: …`。一次提交只做一件事。
4. 提交前必须跑检查（缺一不可）：
   ```bash
   python -m py_compile scripts/*.py
   node --check ui/index.js ui/client.js
   python scripts/extract_defs.py --game "<游戏根>" --check
   # 数据有变更时：
   python scripts/verify_defs.py --json data/rimworld-defs.json --game "<游戏根>"
   ```
   并确认 JSON / YAML 可解析。
5. **不入库**：`data/**`（JSON、icon-cache）、`__pycache__`、`node_modules`、`out/`、任何游戏本体文件。
6. 合并用 `git merge --no-ff <branch>`，合并后删除分支。
7. **禁止** force push、改写历史、rebase 公共分支、修改他人提交；确需改写必须先征得用户同意。
8. **不擅自添加 remote、不推送**。需要远程时先问。
9. 安装/卸载 DSH bundle 会改变 profile 的全局状态：**先告知用户并等确认**。更新 UI 的步骤是 `remove_bundle` → `install_bundle`，然后让用户刷新页面。
10. 大改动前先给方案与影响分析，等用户点头；每完成一个可审查单元就停下来让用户 review。
11. **对既有代码做大范围修改前，必须先询问用户可行性**：先说明影响面（哪些文件/接口/数据格式会变）、风险与回滚方式，得到明确许可后再执行；不要先改完再解释。
12. **仓库内禁止提交绝对路径**：本机差异放 `rimworld-defs.local.json`（gitignore）或环境变量（`RIMWORLD_GAME` / `RIMWORLD_DATA` / `RIMWORLD_PYTHON`）；路径解析统一走 `scripts/paths.py`，不要在脚本里另写一套。改动后用 `python scripts/paths.py --json` 确认来源正确。

## 5. 常用命令

```bash
# 路径自检（游戏目录/数据/解释器各来自哪里）
python scripts/paths.py --json

# 重建数据（约 2.4 s；游戏目录自动发现）
python scripts/extract_defs.py

# 版本检查（0=最新，1=需重建，2=路径错误）
python scripts/extract_defs.py --check

# 查询层
python scripts/query_defs.py search-def Steel --unicode
python scripts/query_defs.py search-label 钢 --limit 10
python scripts/query_defs.py list-category --category Item --thing-categories ResourcesRaw --def-type ThingDef

# 抽样校验（路径自动解析）
python scripts/verify_defs.py --samples 100

# 单张图标（调试）
python scripts/render_icon.py --game "<根>" --source Royalty --tex "Things/Pawn/Humanlike/Apparel/CataphractArmor/CataphractArmor" > icon.png

# UI 安装 / 更新（通过 DSH plugin_manager）
#   install_bundle   target = <repo>\ui
#   更新前先 remove_bundle target=@local/dsh-rimworld-defs
```

## 6. 已知限制（不要当成 bug 修）

1. **Core 贴图无法解码**：`Assets.zip` 里 3,404 个 `.split` 是自定义容器（DDS 头 + 约 1.108 倍的表/索引数据），Pillow / texture2ddecoder / imagecodecs 全部解出噪声；UI 对 Core 显示占位图与提示。DLC（Unity 资源包）解码正常。**不要**用通用 DDS 解码器“修复”它。
2. **染色是预览**：用 CSS `mix-blend-mode: multiply` 叠色，不是游戏真实材质染色算法。
3. **UnityPy 是临时安装**：位于工作区的 `out/unitypy`，由本机配置 `unityPyPath` 指向（不写进 bundle）。换机或清理工作区后 DLC 图标会失效；正确做法是 `pip install UnityPy` 到 `python` 所在环境，并删掉该配置项。
4. **工具由面板注册，不是独立包**：`ui/tools.js` 在面板 `apply()` 里通过作用域 `ctx.inject(['tools'])` 注册四个工具；缺 `tools` 服务（headless）时跳过，面板照常工作。工具只调用 `scripts/query_defs.py`，不重写查询逻辑。
5. **遮罩类贴图**（护甲、部分服装）是灰度图，游戏运行时染色；静态显示为灰色剪影。
6. 路径**不写在** `ui/cordis.patch.yml`：`ui/paths.js` 从包位置派生 `dataPath` / `renderScript` / `placeholderPath` / `cacheDir`，游戏目录靠 Steam 自动发现；本机差异放 `rimworld-defs.local.json` 或环境变量。换机后重建工作区联接并重新生成数据即可。

## 7. 建议的下一步（按优先级）

1. **Core 贴图**：写一个运行时导出模组（游戏内用 Unity `Texture2D` 导出 PNG 到 `data/icon-cache`），这是最可靠的路线；或逆向 `.split` 容器。
2. **遮罩染色**：读取 def 的 `color` / `colorTwo` 或材料色做上色。
3. **翻译表**扩展：分类值、comps 属性等；可考虑按 `defType` 分组或只列常用键。
4. **i18n**：UI 文案接入 DSH locale 服务（当前写死中文）。
5. **面板设置页**扩展：智能体工具页目前只读展示；后续可加"复制调用示例"或"一键试跑"。

## 8. 发布前检查（对外发布本仓库时）

1. **全仓库不得出现本机绝对路径**（§9 除外）：
   ```powershell
   Select-String -Path *.md,docs\*.md,ui\*.js,scripts\*.py -Pattern '[A-Za-z]:\\'
   ```
   命中项要么改成 `<repo>` / `<game>` / `<workspace>` 占位符，要么归入 §9。
2. **删除 §9「开发机备注」整节**（它是发布前唯一允许保留本机信息的地方）。
3. 确认这些没有入库：`data/`、`rimworld-defs.local.json`、`out/`、`__pycache__/`、`node_modules/`。
4. 确认 `SKILL.md` 全篇只有相对路径，且 Base directory = 仓库根。
5. 新机器验收四步：`git clone` → `python scripts/extract_defs.py` → 建工作区联接（§4.1）→ 刷新面板，能查到 def 即通过。

## 9. 开发机备注（发布前删除整节）

> 以下内容只对开发机有效，**不随仓库发布**。

| 项 | 本机值 |
| --- | --- |
| 仓库 | `E:\DataE\condex_file\git_repository\RimWorld_Mod` |
| 游戏根目录 | `E:\SteamLibrary\steamapps\common\RimWorld`（`1.7.5000 rev1275`，Steam） |
| Python | `D:\tools\python\python.exe`（3.14.4；lxml 6.1.3、Pillow 11.3.0） |
| UnityPy 临时安装 | `E:\DataE\game\Rimworld_mod\out\unitypy`（写入本机配置 `unityPyPath`） |
| 工作区 | `E:\DataE\game\Rimworld_mod` |
| 技能联接 | `E:\DataE\game\Rimworld_mod\.dsh\skills\RimWorld_Mod` → 仓库根 |
| DSH profile | `C:\Users\<user>\.dsh\profiles\desktop`（`@local/dsh-rimworld-defs` 以 link 装入） |
| 本机配置 | `E:\DataE\condex_file\git_repository\RimWorld_Mod\rimworld-defs.local.json` |

（用户名按约定隐去；其余为排障所需的最小信息。）

## 10. 项目制作规矩

1. **改文档先问**：新增或删除章节、条目之前，先说明「必要性 + 原因 + 影响面」，得到用户明确同意后再编辑 md；不要先改再解释。
2. **一次提交一件事**：功能 / 修复 / 文档分开提交，信息用中文 Conventional Commits。
3. **不确定就停**：接口、数据格式、外部契约有疑问时先问，不猜、不做试错式改动。
4. **大改动先给方案**：影响面、风险、回滚写清楚（与 §4.11 一致），确认后再动手。
5. **保持可迁移**：仓库内不出现本机绝对路径（§4.12），本机信息只放 §9。

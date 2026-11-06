# RimWorld Defs 查看器（DSH Skill）

RimWorld（环世界）XML 定义的**静态参考工具**，以 DSH Skill 形式提供查询能力。

> 当前状态：**骨架**。本仓库只有目录约定、`SKILL.md` 与文档，暂未包含任何爬取或查询逻辑。

## 项目构成

两部分：

1. **爬取脚本**（`scripts/`，Python）：扫描游戏 `Defs/` 目录，产出结构化 JSON。
2. **DSH Skill**（本仓库，`SKILL.md`）：加载该 JSON，向使用方提供查询工具。

## 核心边界：静态参考 ≠ 运行时真相

JSON 记录的是 **Def XML 的模板层面信息**（每个 `Def` 节点的字段、`ParentName`、`Abstract` 等声明）。

它**不是**游戏运行时合并后的最终生效值：

- 继承（`ParentName`）后的字段合并结果、`MayRequire` 条件加载、代码侧运行时修改（补丁、`DefModExtension`、模组代码动态生成）都不在 JSON 中。
- 因此涉及「运行时实际值」的问题，请以游戏内 DevMode 的 `Def` 查看器或实际加载日志为准。

## 技术栈

| 项 | 选型 |
| --- | --- |
| 脚本语言 | Python 3.11+ |
| XML 解析 | `lxml`（必须；不使用 `xmltodict` / 标准库 `ElementTree`） |
| CLI 参数 | `argparse` 或 `click`，第二次交谈基于仓库现状二选一 |
| 工具注册 | 路线待定（见下方「待决事项」） |

运行环境提示：本机系统 Python 为 3.14.4，**未安装 `lxml`**；DSH 运行时自带 Python 3.12.14 并已内置 `lxml 6.1.3`。抓取脚本应通过 `load_workspace_dependencies` 返回的捆绑解释器运行，或在项目内建 venv 后显式安装 `lxml`。

## 目录结构

```text
.
├── SKILL.md                 # DSH Skill 入口（frontmatter: name + description）
├── README.md                # 本文件
├── scripts/                 # Python 爬取脚本（占位，暂无实现）
└── data/                    # 结构化 JSON（占位，暂无内容）
    ├── .gitkeep
    └── .gitignore           # 忽略生成的 *.json
```

## 数据文件位置约定

- 路径：**Skill 目录内**的 `data/rimworld-defs.json`。
- 抓取脚本与查询工具都用 `Path(__file__).parent` 定位（脚本在 `scripts/`，Skill 根在其上一级），**不硬编码绝对路径**。
- 整个 Skill 目录必须可移植：拷贝到任意机器、任意路径后仍能工作。

## 生成数据不入库

`data/*.json` 由游戏 `Defs/` 目录生成，属于游戏内容派生物，体积大且含 Ludeon 版权内容，默认不提交（`.gitignore` 已忽略）。需要分发时在目标机本地生成。

## 待决事项（第二次交谈处理）

1. **工具注册路线**：`@tool` 装饰器路线能否在本 DSH profile 落地，取决于是否安装 `@peroxider/dsh-python-bridge-runtime`（宿主侧）与 codegen 产物；否则改用「薄 TS 壳 + Python 子进程」。
2. **Skill 目录名**：DSH 约定 `SKILL.md` 的 `name` 与目录名一致（小写、连字符）。本仓库目录名为 `RimWorld_Mod`，安装时需放到名为 `rimworld-defs-viewer` 的目录下，或后续调整为 `skills/rimworld-defs-viewer/` 结构。
3. **数据文件规模**：全量 Defs 的 JSON 体量与检索结构（是否分片、是否建立索引）留待实现阶段确定。

## 未实现（明确不做）

- 任何 XML 解析、继承合并、查询工具逻辑。
- `ParentName` 未解析语义、`MayRequire` 过滤、`thingCategories` 与 `category` 的区分。

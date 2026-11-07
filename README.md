# RimWorld Defs 查看器（DSH Skill）

把 RimWorld（环世界）的 Def 定义解析成 JSON，用 DSH 面板浏览、给智能体查询。
**不包含游戏文件**：数据由你本机的游戏生成。

仓库：<https://github.com/Schweine-Banditen/DSH-Rimworld-Defs-Skill>

## 快速开始

```bash
pip install lxml pillow        # 需要 Python ≥ 3.11
python scripts/init.py         # 自动发现游戏目录并生成 data/rimworld-defs.json
```

- **安装面板**：用 DSH 的 `plugin_manager` 安装本目录下的 `ui/`，然后刷新页面。
- **让 DSH 发现 Skill**：调用 `rimworld_init({ workspace: "<会话目录>", link: true })`，或手动在 `<workspace>/.dsh/skills/` 建目录联接指向本仓库。
- **找不到游戏目录**：设环境变量 `RIMWORLD_GAME`，或写 `rimworld-defs.local.json`（参考 `rimworld-defs.local.example.json`）。

## 功能

- 文件树：Core / 官方 DLC / 创意工坊 / 我的模组（工作文件夹可动态增删）。
- 详情：父链、字段、贴图、XML 高亮预览、中英文字段翻译。
- 智能体工具：精确查、按名搜索、按来源、按分类、初始化；查询工具均支持 `scope`（`g`=本体+DLC，`c`=创意工坊，`m`=我的模组）。

## 目录

| 路径 | 说明 |
| --- | --- |
| `scripts/` | 提取、查询、校验、初始化 |
| `ui/` | DSH 面板（Host 路由 + 前端） |
| `assets/` | 空状态与占位图 |
| `data/` | 生成的 JSON（不入库） |

## 已知限制

- Core 的 `.split` 贴图格式尚未解码，物品图标显示占位图。
- 数据是静态快照：游戏更新后运行 `python scripts/init.py --force` 重建。
- 创意工坊 / 我的模组的数据保存在数据目录下，可在面板「基础设置」中修改位置。

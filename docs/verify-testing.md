# 抽样校验工具（测试专用）

`scripts/verify_defs.py` 是开发期的**回归测试工具**，不参与 Skill 的运行时逻辑，也不会被 Skill 调用。

## 用途

从 `data/rimworld-defs.json` 随机抽取若干 Def，回到游戏安装目录的原始 `sourcePath` XML 与 DefInjected 翻译，**独立地**逐字段比对，确认提取结果没有偏差。

它刻意**不 import** `extract_defs.py`：解析、定位、字段读取全部重新实现，避免“用同一份代码验证自己”。

## 使用

```bash
python scripts/verify_defs.py --json data/rimworld-defs.json --game "<RimWorld 根目录>"
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--json FILE` | 必填 | 要校验的数据文件 |
| `--game DIR` | 必填 | 游戏根目录（与生成数据时使用的一致） |
| `--samples N` | 100 | 抽样条数 |
| `--seed N` | 20261106 | 随机种子；改动后用同一种子可复现 |
| `--language NAME` | `ChineseSimplified (简体中文)` | 校验中文标签时使用的语言目录 |

退出码：`0` = 全部一致；`1` = 存在不一致（会打印最多 20 条差异）。

## 校验内容

每条样本比对：

- `defType`、`defName`、`Name`、`label`、`ParentName`、`Abstract`、`Class`
- `MayRequire`、`MayRequireAnyOf`、`category`、`thingCategories`
- `source`（由路径反推）、`sourcePath`（文件存在性）
- `labelZh`、`titleZh`（回查 DefInjected 目录与 DLC 的 `.tar`）

## 定位规则（容易踩的坑）

游戏里 `defName` 只在**同类型**内唯一：`Otter` 同时是 `ThingDef` 和 `PawnKindDef`，`DarkRed` 同时是 `ColorDef` 和 `IdeoColorDef`。因此定位元素必须同时匹配 **defType + defName/Name + Abstract**；只按 defName 会取到错误元素，产生假警报。

## 已知限制

- 抽样不是全量：默认 100 条，只证明样本内一致；需要更强证据时调大 `--samples` 或换多个 `--seed`。
- 无 `defName` 的 Def（53 个 `SongDef`）不参与抽样，因为无法稳定定位。
- 假设 `--game` 与生成数据时是同一份安装；游戏更新后应先重建数据再校验。
- 校验中文标签依赖 DefInjected 与数据文件同时存在；缺失时两边都为 `None` 会“通过”，不代表翻译完整。

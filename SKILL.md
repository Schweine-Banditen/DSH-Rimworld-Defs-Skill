---
name: rimworld-defs-viewer
description: 查询 RimWorld（环世界）XML Def 定义（物品、生物、建筑、研究等）的模板层面字段与继承声明。用于回答「某个 Def 有哪些字段」「哪个模组定义了某 Def」等静态参考问题；不代表游戏运行时合并后的最终生效值。
---

# RimWorld Defs 查看器

本 Skill 提供 RimWorld `Defs/` 目录 XML 定义的**静态查询**能力。

## 何时使用

- 需要查看某个 `Def`（如 `ThingDef`、`PawnKindDef`、`ResearchProjectDef`）在 XML 中的原始字段与取值。
- 需要确认某个 `Def` 由哪个模组/哪个文件定义。
- 需要了解某类 Def 的字段结构，用于写模组或排查 `Def` 相关报错。

## 边界（重要）

- 数据来自 **XML 模板层**：`ParentName` 继承、`MayRequire` 条件、代码侧运行时修改均未被合并。
- 回答运行时生效值时，本 Skill 只能给出「XML 声明了什么」，不能替代游戏内 DevMode `Def` 查看器。

## 数据文件

- 路径：本 Skill 目录下 `data/rimworld-defs.json`（由 `scripts/` 中的抓取脚本生成）。
- 该文件不随仓库提交，需在本机生成。

## 当前状态

**骨架阶段**：查询工具尚未实现。此文件仅声明 Skill 元信息与边界，正文将在功能实现后补全。

## 依赖

- Python 3.11+
- `lxml`

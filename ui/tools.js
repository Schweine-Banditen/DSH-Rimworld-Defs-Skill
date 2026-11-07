/**
 * 智能体工具：把查询层的四个查询注册成会话可调用的工具。
 *
 * 设计取舍：工具**不重写查询逻辑**，一律调用 `scripts/query_defs.py`，
 * 因此查询语义（父链解析、category 有效值、Abstract 默认排除）只有一份实现。
 *
 * 同一个模块同时给出两份东西：
 * - `createTools()`：给 `ctx.tools.register()` 用的真实工具对象；
 * - `TOOL_CATALOG`：给面板「设置 → 智能体工具」展示的元数据（名称/参数/用法）。
 */
import { join } from 'node:path'

import { REPO_ROOT } from './paths.js'
import { runQuery } from './query.js'

/**
 * 四个工具的定义。`params` 会被翻译成 JSON Schema，也会原样展示在设置页，
 * 所以这里是唯一事实来源。
 */
const DEFINITIONS = [
  {
    name: 'rimworld_search_def',
    title: '精确查 Def',
    summary: '按 defName（或抽象模板的 Name）查一条定义',
    description:
      '按 defName 精确查找 RimWorld 的 Def（也匹配抽象模板的 Name）。默认排除 Abstract 模板；同名跨类型会返回多条，用 defType 限定。返回字段含 source、sourcePath、parentChain、graphic、fields。',
    usage: 'rimworld_search_def({ defName: "Steel", defType: "ThingDef" })',
    params: [
      { key: 'defName', type: 'string', required: true, description: '目标 defName，或抽象模板的 Name' },
      { key: 'defType', type: 'string', description: '限定类型，例如 ThingDef、PawnKindDef' },
      { key: 'includeAbstract', type: 'boolean', description: '包含 Abstract 模板（默认 false）' },
    ],
    toArgs: (a) => [
      'search-def',
      a.defName,
      ...(a.defType ? ['--def-type', a.defType] : []),
      ...(a.includeAbstract ? ['--include-abstract'] : []),
    ],
  },
  {
    name: 'rimworld_search_by_label',
    title: '按名称搜索',
    summary: '用中英文关键词模糊搜索 label / title / defName',
    description:
      '在 label、labelZh、title、titleZh、defName、Name 上做大小写不敏感的包含匹配，按字段权重与匹配质量排序。结果里的 matchedField 表示命中的字段。',
    usage: 'rimworld_search_by_label({ query: "钢", limit: 10 })',
    params: [
      { key: 'query', type: 'string', required: true, description: '关键词，支持中文' },
      { key: 'limit', type: 'number', description: '返回条数上限（默认 20）' },
    ],
    toArgs: (a) => ['search-label', a.query, ...(a.limit ? ['--limit', String(a.limit)] : [])],
  },
  {
    name: 'rimworld_list_by_source',
    title: '按来源列出',
    summary: '列出某个来源（Core / Royalty / …）的 Def',
    description:
      '按 source 过滤（严格按文件路径判定，与 MayRequire 无关）。默认排除 Abstract 模板。返回精简字段：defType、defName、label、labelZh、sourcePath。',
    usage: 'rimworld_list_by_source({ source: "Royalty", limit: 20 })',
    params: [
      { key: 'source', type: 'string', required: true, description: '来源名，例如 Core、Royalty、Odyssey' },
      { key: 'limit', type: 'number', description: '返回条数上限' },
    ],
    toArgs: (a) => ['list-source', a.source, ...(a.limit ? ['--limit', String(a.limit)] : [])],
  },
  {
    name: 'rimworld_list_by_category',
    title: '按分类过滤',
    summary: '按 category / thingCategories 组合过滤',
    description:
      'category 与 thingCategories 都是可选条件（AND），且都沿父链取有效值，结果带 categoryDepth / categoryFrom 说明继承来源。至少提供其中一个。常用于写 recipe 的 thingCategories 或筛建筑。',
    usage: 'rimworld_list_by_category({ category: "Item", thingCategories: ["ResourcesRaw"], defType: "ThingDef", limit: 50 })',
    params: [
      { key: 'category', type: 'string', description: '顶层大类，例如 Item、Building' },
      { key: 'thingCategories', type: 'array', items: 'string', description: '细分类列表，例如 ["ResourcesRaw"]' },
      { key: 'defType', type: 'string', description: '限定类型，例如 ThingDef' },
      { key: 'limit', type: 'number', description: '返回条数上限（默认 200）' },
    ],
    validate: (a) => {
      if (!a.category && !(a.thingCategories && a.thingCategories.length > 0)) {
        throw new Error('至少提供 category 或 thingCategories 之一')
      }
    },
    toArgs: (a) => [
      'list-category',
      ...(a.category ? ['--category', a.category] : []),
      ...(a.thingCategories && a.thingCategories.length > 0
        ? ['--thing-categories', ...a.thingCategories.map(String)]
        : []),
      ...(a.defType ? ['--def-type', a.defType] : []),
      ...(a.limit ? ['--limit', String(a.limit)] : []),
    ],
  },
]

/** 面板设置页展示用的元数据（不含执行逻辑，可安全序列化成 JSON）。 */
export const TOOL_CATALOG = DEFINITIONS.map((definition) => ({
  name: definition.name,
  title: definition.title,
  summary: definition.summary,
  description: definition.description,
  usage: definition.usage,
  parameters: definition.params.map((param) => ({
    name: param.key,
    type: param.type,
    required: param.required === true,
    description: param.description,
  })),
}))

function parametersSchema(definition) {
  const properties = {}
  for (const param of definition.params) {
    const property = { type: param.type, description: param.description }
    if (param.items) property.items = { type: param.items }
    properties[param.key] = property
  }
  return {
    type: 'object',
    properties,
    required: definition.params.filter((param) => param.required).map((param) => param.key),
    additionalProperties: false,
  }
}

function normalizeArgs(definition, args) {
  const normalized = {}
  for (const param of definition.params) {
    const value = args?.[param.key]
    if (value === undefined || value === null || value === '') continue
    if (param.type === 'array' && !Array.isArray(value)) {
      throw new Error(`${param.key} 需要数组`)
    }
    if (param.type === 'number' && !Number.isFinite(Number(value))) {
      throw new Error(`${param.key} 需要数字`)
    }
    normalized[param.key] = value
  }
  const missing = definition.params.filter((param) => param.required && normalized[param.key] === undefined)
  if (missing.length > 0) {
    throw new Error(`缺少参数：${missing.map((param) => param.key).join('、')}`)
  }
  definition.validate?.(normalized)
  return normalized
}

/**
 * 构造可注册的工具对象数组。
 *
 * @param options - `{ pythonExe, script }`；`script` 省略时用仓库内的查询层。
 */
export function createTools(options = {}) {
  const pythonExe = options.pythonExe || 'python'
  const script = options.script || join(REPO_ROOT, 'scripts', 'query_defs.py')

  return DEFINITIONS.map((definition) => ({
    name: definition.name,
    description: `${definition.description}\n用法：${definition.usage}`,
    parameters: parametersSchema(definition),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    timeoutMs: 45_000,
    async execute(args) {
      const normalized = normalizeArgs(definition, args)
      return runQuery({ pythonExe, script, args: definition.toArgs(normalized) })
    },
  }))
}

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
const SCOPE_PARAM = {
  key: 'scope',
  type: 'string',
  enum: ['g', 'c', 'm'],
  description: '来源过滤：g=仅本体与 DLC，c=仅创意工坊，m=仅我的模组；留空=全部',
}

const SCOPE_DOC = '可用 scope 限定来源：g=本体与 DLC，c=创意工坊，m=我的模组；省略则查询全部。'

const DEFINITIONS = [
  {
    name: 'rimworld_search_def',
    title: '精确查 Def',
    summary: '按 defName（或抽象模板的 Name）查一条定义',
    description:
      '按 defName 精确查找 RimWorld 的 Def（也匹配抽象模板的 Name）。默认排除 Abstract 模板；同名跨类型会返回多条，用 defType 限定。返回字段含 source、sourcePath、parentChain、graphic、fields。' +
      SCOPE_DOC,
    usage: 'rimworld_search_def({ defName: "Steel", defType: "ThingDef", scope: "g" })',
    params: [
      { key: 'defName', type: 'string', required: true, description: '目标 defName，或抽象模板的 Name' },
      { key: 'defType', type: 'string', description: '限定类型，例如 ThingDef、PawnKindDef' },
      { key: 'includeAbstract', type: 'boolean', description: '包含 Abstract 模板（默认 false）' },
      SCOPE_PARAM,
    ],
    toArgs: (a) => [
      'search-def',
      a.defName,
      ...(a.defType ? ['--def-type', a.defType] : []),
      ...(a.includeAbstract ? ['--include-abstract'] : []),
      ...(a.scope ? ['--scope', a.scope] : []),
    ],
  },
  {
    name: 'rimworld_search_by_label',
    title: '按名称搜索',
    summary: '用中英文关键词模糊搜索 label / title / defName',
    description:
      '在 label、labelZh、title、titleZh、defName、Name 上做大小写不敏感的包含匹配，按字段权重与匹配质量排序。结果里的 matchedField 表示命中的字段。' +
      SCOPE_DOC,
    usage: 'rimworld_search_by_label({ query: "钢", limit: 10, scope: "g" })',
    params: [
      { key: 'query', type: 'string', required: true, description: '关键词，支持中文' },
      { key: 'limit', type: 'number', description: '返回条数上限（默认 20）' },
      SCOPE_PARAM,
    ],
    toArgs: (a) => [
      'search-label',
      a.query,
      ...(a.limit ? ['--limit', String(a.limit)] : []),
      ...(a.scope ? ['--scope', a.scope] : []),
    ],
  },
  {
    name: 'rimworld_list_by_source',
    title: '按来源列出',
    summary: '列出某个来源（Core / Royalty / 模组名）的 Def',
    description:
      '按 source 过滤（严格按文件路径判定，与 MayRequire 无关）。默认排除 Abstract 模板。返回精简字段：defType、defName、label、labelZh、sourcePath。工坊与我的模组的 source 显示为模组/文件夹名。' +
      SCOPE_DOC,
    usage: 'rimworld_list_by_source({ source: "Royalty", limit: 20, scope: "g" })',
    params: [
      { key: 'source', type: 'string', required: true, description: '来源名，例如 Core、Royalty、Odyssey，或工坊模组名' },
      { key: 'limit', type: 'number', description: '返回条数上限' },
      SCOPE_PARAM,
    ],
    toArgs: (a) => [
      'list-source',
      a.source,
      ...(a.limit ? ['--limit', String(a.limit)] : []),
      ...(a.scope ? ['--scope', a.scope] : []),
    ],
  },
  {
    name: 'rimworld_list_by_category',
    title: '按分类过滤',
    summary: '按 category / thingCategories 组合过滤',
    description:
      'category 与 thingCategories 都是可选条件（AND），且都沿父链取有效值，结果带 categoryDepth / categoryFrom 说明继承来源。至少提供其中一个。常用于写 recipe 的 thingCategories 或筛建筑。' +
      SCOPE_DOC,
    usage:
      'rimworld_list_by_category({ category: "Item", thingCategories: ["ResourcesRaw"], defType: "ThingDef", limit: 50, scope: "g" })',
    params: [
      { key: 'category', type: 'string', description: '顶层大类，例如 Item、Building' },
      { key: 'thingCategories', type: 'array', items: 'string', description: '细分类列表，例如 ["ResourcesRaw"]' },
      { key: 'defType', type: 'string', description: '限定类型，例如 ThingDef' },
      { key: 'limit', type: 'number', description: '返回条数上限（默认 200）' },
      SCOPE_PARAM,
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
      ...(a.scope ? ['--scope', a.scope] : []),
    ],
  },
  {
    name: 'rimworld_init',
    title: '初始化 / 自检',
    summary: '检查环境、生成数据、验证查询，可选建立 Skill 联接',
    description:
      '首次安装、换机或数据缺失/过期时先调用。依次检查游戏目录、Python 依赖（lxml/Pillow）、数据文件；缺失或 force=true 时重新生成；返回路径、依赖版本、defs 数量、执行的动作与告警。提供 workspace 时检查其 .dsh/skills 是否已链接本技能，link=true 则在缺失时创建目录联接。' +
      '该工具幂等，可重复调用。',
    usage: 'rimworld_init({ workspace: "E:\\\\MyWorkspace", link: true })',
    script: 'init.py',
    timeoutMs: 600_000,
    params: [
      { key: 'force', type: 'boolean', description: '即使数据已存在也重新生成' },
      { key: 'workspace', type: 'string', description: '会话工作目录；提供后检查其 .dsh/skills 是否已链接本技能' },
      { key: 'link', type: 'boolean', description: '与 workspace 搭配：缺失时创建目录联接（Windows junction / 符号链接）' },
    ],
    toArgs: (a) => [
      '--json',
      ...(a.force ? ['--force'] : []),
      ...(a.workspace ? ['--workspace', a.workspace] : []),
      ...(a.link ? ['--link'] : []),
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
    ...(param.enum ? { options: param.enum.join(' / ') } : {}),
  })),
}))

function parametersSchema(definition) {
  const properties = {}
  for (const param of definition.params) {
    const property = { type: param.type, description: param.description }
    if (param.items) property.items = { type: param.items }
    if (param.enum) property.enum = param.enum
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
    if (param.enum && !param.enum.includes(String(value))) {
      throw new Error(`${param.key} 只能是 ${param.enum.join(' / ')}`)
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
    timeoutMs: definition.timeoutMs || 45_000,
    async execute(args) {
      const normalized = normalizeArgs(definition, args)
      const target = definition.script ? join(REPO_ROOT, 'scripts', definition.script) : script
      return runQuery({
        pythonExe,
        script: target,
        args: definition.toArgs(normalized),
        timeoutMs: definition.timeoutMs || 45_000,
      })
    },
  }))
}

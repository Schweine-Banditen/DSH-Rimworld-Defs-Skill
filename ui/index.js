/**
 * Host half of the RimWorld Defs panel.
 *
 * Serves a browsing index (source → category → defs), one def's full record,
 * quick search and rendered item textures. Textures come from Assets.zip as
 * split DDS compressed with ZSTD; the project's Python renderer decodes them.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { resolve as resolvePath, sep } from 'node:path'
import { resolvePaths } from './paths.js'
import { TOOL_CATALOG, createTools } from './tools.js'

export const name = 'rimworld-defs-ui'

// 必须等 webServer 就绪后再 apply；否则冷启动时会拿不到服务、路由不会注册。
export const inject = ['webServer']

const API_PREFIX = '/rimworld-defs/api'

/** 浏览树的分类标准（固定顺序）：先匹配先归类，覆盖不到的进「其他」。 */
const GROUPS = [
  { key: 'equipment', label: '武器与装备' },
  { key: 'items', label: '物品' },
  { key: 'building', label: '建筑' },
  { key: 'plants', label: '植物' },
  { key: 'pawn', label: '动物与生物' },
  { key: 'production', label: '生产与配方' },
  { key: 'research', label: '研究' },
  { key: 'ability', label: '能力与状态' },
  { key: 'world', label: '世界与地形' },
  { key: 'other', label: '其他' },
]
const GROUP_LABEL = Object.fromEntries(GROUPS.map((g) => [g.key, g.label]))

const ABILITY_TYPES = new Set([
  'AbilityDef',
  'HediffDef',
  'GeneDef',
  'TraitDef',
  'ThoughtDef',
  'MentalStateDef',
  'InspirationDef',
  'NeedDef',
  'PreceptDef',
])
const WORLD_TYPES = new Set([
  'IncidentDef',
  'GameConditionDef',
  'QuestScriptDef',
  'WorldObjectDef',
  'SiteDef',
  'MapGeneratorDef',
  'FactionDef',
  'WeatherDef',
  'BiomeDef',
  'TerrainDef',
  'RiverDef',
  'RoadDef',
])
const EQUIPMENT_CATEGORIES = new Set([
  'weapons',
  'weaponsranged',
  'weaponsmelee',
  'apparel',
  'apparelarmor',
  'apparelutility',
])

function makeLookup(defs) {
  const map = new Map()
  for (const record of defs || []) {
    const identity = record.defName || record.Name
    if (!identity) continue
    map.set(`${record.defType}|${identity}|${record.source}`, record)
  }
  return map
}

/** 沿父链取第一个非空字段（category / thingCategories 常写在抽象基类上）。 */
function effectiveValue(record, field, lookup, depth = 0) {
  if (!record || depth > 24) return null
  const value = record[field]
  if (value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0)) {
    return value
  }
  const parent = lookup.get(
    `${record.parentDefType || record.defType}|${record.parentDefName || record.ParentName}|${record.parentSource || ''}`,
  )
  return effectiveValue(parent, field, lookup, depth + 1)
}

function classify(record, lookup) {
  const type = record.defType || ''
  const thingCategories = new Set(
    (effectiveValue(record, 'thingCategories', lookup) || []).map((value) =>
      String(value).toLowerCase(),
    ),
  )
  const category = String(effectiveValue(record, 'category', lookup) || '').toLowerCase()

  if (type === 'ThingDef') {
    for (const key of thingCategories) {
      if (EQUIPMENT_CATEGORIES.has(key)) return 'equipment'
    }
    if (category === 'building') return 'building'
    if (category === 'plant') return 'plants'
    if (category === 'pawn') return 'pawn'
    if (category === 'item') return 'items'
    return 'other'
  }
  if (type === 'PawnKindDef') return 'pawn'
  if (type === 'RecipeDef' || type === 'DrugPolicyDef') return 'production'
  if (type === 'ResearchProjectDef') return 'research'
  if (ABILITY_TYPES.has(type)) return 'ability'
  if (WORLD_TYPES.has(type)) return 'world'
  return 'other'
}

export function apply(ctx, config = {}) {
  const web = ctx.webServer
  if (!web) {
    ctx.logger?.warn?.('rimworld-defs: webServer unavailable, panel API disabled')
    return
  }

  // 所有路径都由 ui/paths.js 解析：环境变量 → 本机配置 → bundle 配置 → 仓库派生。
  // 仓库里不再存放绝对路径，换机只需重建工作区联接、重新生成数据。
  const paths = resolvePaths(config)
  const dataPath = paths.dataPath.value
  const gameRoot = paths.gameRoot.value
  const pythonExe = paths.pythonExe.value
  const renderScript = paths.renderScript.value
  const placeholderPath = paths.placeholderPath.value
  const cacheDir = paths.cacheDir.value
  const unityPyPath = paths.unityPyPath.value

  ctx.logger?.info?.(
    `rimworld-defs: 路径解析 data=${paths.dataPath.source} game=${paths.gameRoot.source} python=${paths.pythonExe.source}`,
  )
  if (!gameRoot) {
    ctx.logger?.warn?.(
      'rimworld-defs: 未找到 RimWorld 目录，版本提示与 XML 预览不可用；可设 RIMWORLD_GAME 或写 rimworld-defs.local.json',
    )
  }

  // 智能体工具：注册四个查询。用作用域 inject 而不是顶层 inject —— 缺少 tools
  // 服务的环境（headless / 精简 profile）不应该连面板路由一起消失。
  const registeredTools = []
  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (scope) => {
      for (const tool of createTools({ pythonExe })) {
        try {
          scope.tools.register(tool)
          registeredTools.push(tool.name)
        } catch (error) {
          ctx.logger?.warn?.(`rimworld-defs: 工具 ${tool.name} 注册失败：${error}`)
        }
      }
      ctx.logger?.info?.(`rimworld-defs: 已注册 ${registeredTools.length} 个智能体工具`)
    })
  } else {
    ctx.logger?.warn?.('rimworld-defs: ctx.inject 不可用，跳过智能体工具注册')
  }

  let cache = { mtimeMs: 0, payload: null, index: null, lookup: null }
  const iconCache = new Map()
  const TEX_PATTERN = /^[A-Za-z0-9 _\-/.]+$/

  function loadData() {
    if (!dataPath) throw new Error('尚未解析到数据文件路径')
    if (!existsSync(dataPath)) {
      throw new Error(`数据文件不存在：${dataPath}（先运行 python scripts/extract_defs.py）`)
    }
    const mtimeMs = statSync(dataPath).mtimeMs
    if (cache.payload === null || cache.mtimeMs !== mtimeMs) {
      const payload = JSON.parse(readFileSync(dataPath, 'utf8'))
      cache = {
        mtimeMs,
        payload,
        index: null,
        lookup: makeLookup(payload.defs),
      }
      iconCache.clear()
    }
    return cache
  }

  function buildIndex(payload) {
    if (cache.index !== null) return cache.index
    const bySource = new Map()
    for (const record of payload.defs || []) {
      if (record.Abstract === true) continue
      const name = record.defName
      if (!name) continue
      const source = record.source || 'Unknown'
      const group = classify(record, cache.lookup)
      if (!bySource.has(source)) bySource.set(source, new Map())
      const groups = bySource.get(source)
      if (!groups.has(group)) groups.set(group, [])
      groups.get(group).push({
        defName: name,
        label: record.labelZh || record.label || record.titleZh || record.title || '',
        defType: record.defType,
      })
    }

    const orderedSources = (payload.sources || []).map((item) => item.name)
    const sourceNames = [...bySource.keys()].sort(
      (a, b) => orderedSources.indexOf(a) - orderedSources.indexOf(b) || a.localeCompare(b),
    )
    const sources = sourceNames.map((sourceName) => {
      const groups = bySource.get(sourceName)
      const orderedGroups = GROUPS.filter((group) => groups.has(group.key)).map((group) => {
        const items = groups.get(group.key).sort((a, b) =>
          (a.label || a.defName).localeCompare(b.label || b.defName),
        )
        return { key: group.key, label: group.label, count: items.length, items }
      })
      return {
        name: sourceName,
        count: orderedGroups.reduce((sum, group) => sum + group.count, 0),
        groups: orderedGroups,
      }
    })
    cache.index = sources
    return sources
  }

  function readGameVersion() {
    if (!gameRoot) return null
    try {
      const text = readFileSync(`${gameRoot}/Version.txt`, 'utf8')
      const line = text.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
      return line || null
    } catch {
      return null
    }
  }

  function notice(payload) {
    const dataVersion = payload.gameVersion || null
    const gameVersion = readGameVersion()
    if (!gameVersion) {
      return {
        status: 'unknown',
        dataGameVersion: dataVersion,
        gameVersion: null,
        message: '无法确认游戏版本（Version.txt 不存在或路径失效）。',
      }
    }
    if (gameVersion === dataVersion) {
      return { status: 'current', dataGameVersion: dataVersion, gameVersion, message: null }
    }
    return {
      status: 'stale',
      dataGameVersion: dataVersion,
      gameVersion,
      message: `数据来自 ${dataVersion}，当前游戏为 ${gameVersion}（可能升级或回退）。数据未更新。`,
    }
  }

  function search(payload, query, limit, defType) {
    const needle = String(query || '').trim().toLowerCase()
    if (!needle) return []
    const fields = ['label', 'labelZh', 'title', 'titleZh', 'defName', 'Name']
    const scored = []
    for (const record of payload.defs || []) {
      if (record.Abstract === true && record.defName === undefined) continue
      if (defType && String(record.defType || '').toLowerCase() !== defType.toLowerCase()) continue
      let best = null
      for (const field of fields) {
        const value = record[field]
        if (typeof value !== 'string') continue
        const text = value.toLowerCase()
        if (!text.includes(needle)) continue
        const weight = field.startsWith('label') || field.startsWith('title') ? 3 : 1
        const quality = text === needle ? 3 : text.startsWith(needle) ? 2 : 1
        const score = weight + quality
        if (best === null || score > best.score) best = { field, score }
      }
      if (best) scored.push({ record, matchField: best.field, score: best.score })
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        `${a.record.defType}:${a.record.defName}`.localeCompare(`${b.record.defType}:${b.record.defName}`),
    )
    return scored.slice(0, limit)
  }

  function renderIcon(texPath, source) {
    if (!gameRoot) return Promise.reject(new Error('未找到 RimWorld 目录，无法渲染贴图'))
    if (!renderScript) return Promise.reject(new Error('renderScript not configured'))
    const cacheKey = `${source}|${texPath}`
    if (iconCache.has(cacheKey)) return Promise.resolve(iconCache.get(cacheKey))
    const args = [renderScript, '--game', gameRoot, '--source', source || 'Core', '--tex', texPath]
    if (cacheDir) args.push('--cache-dir', cacheDir)
    const env = { ...process.env }
    if (unityPyPath) env.PYTHONPATH = env.PYTHONPATH ? `${unityPyPath};${env.PYTHONPATH}` : unityPyPath
    return new Promise((resolve, reject) => {
      const child = spawn(pythonExe, args, { windowsHide: true, env })
      const chunks = []
      let stderr = ''
      const timer = setTimeout(() => child.kill(), 20000)
      child.stdout.on('data', (chunk) => chunks.push(chunk))
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0 && chunks.length > 0) {
          const buffer = Buffer.concat(chunks)
          iconCache.set(cacheKey, buffer)
          resolve(buffer)
        } else {
          reject(new Error(`render_icon exit ${code}: ${stderr.trim()}`))
        }
      })
    })
  }

  function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  /** `/meta` 回显每条路径的来源；迁移到新主机后一眼看出哪条没解析上。 */
  function pathSummary(resolved) {
    const field = (item) => ({ value: item.value, source: item.source, valid: item.valid })
    return {
      repoRoot: resolved.repoRoot,
      localConfig: resolved.localConfig,
      dataPath: field(resolved.dataPath),
      gameRoot: field(resolved.gameRoot),
      pythonExe: field(resolved.pythonExe),
      renderScript: field(resolved.renderScript),
      placeholderPath: field(resolved.placeholderPath),
      cacheDir: field(resolved.cacheDir),
      unityPyPath: field(resolved.unityPyPath),
      discoveredGameRoots: resolved.discoveredGameRoots.slice(0, 8),
    }
  }

  async function route(request) {
    const url = new URL(request.url)
    const path = url.pathname
    if (path === `${API_PREFIX}/meta`) {
      const { payload } = loadData()
      return json({
        schemaVersion: payload.schemaVersion,
        gameVersion: payload.gameVersion,
        generatedAt: payload.generatedAt,
        defCount: (payload.defs || []).length,
        changes: payload.changes || null,
        notice: notice(payload),
        paths: pathSummary(paths),
      })
    }
    if (path === `${API_PREFIX}/index`) {
      const { payload } = loadData()
      return json({ notice: notice(payload), groups: GROUPS, sources: buildIndex(payload) })
    }
    if (path === `${API_PREFIX}/def`) {
      const { payload } = loadData()
      const name = url.searchParams.get('name') || ''
      const defType = url.searchParams.get('type') || ''
      const record = (payload.defs || []).find(
        (item) =>
          item.defName === name &&
          (!defType || String(item.defType || '').toLowerCase() === defType.toLowerCase()),
      )
      if (!record) return json({ error: 'not found', name, defType }, 404)
      return json({ notice: notice(payload), record })
    }
    if (path === `${API_PREFIX}/search`) {
      const { payload } = loadData()
      const query = url.searchParams.get('q') || ''
      const limit = Math.min(Number(url.searchParams.get('limit') || 20) || 20, 100)
      const defType = url.searchParams.get('defType') || ''
      const hits = search(payload, query, limit, defType)
      return json({
        notice: notice(payload),
        count: hits.length,
        results: hits.map((hit) => ({
          matchField: hit.matchField,
          score: hit.score,
          group: classify(hit.record, cache.lookup),
          groupLabel: GROUP_LABEL[classify(hit.record, cache.lookup)],
          record: hit.record,
        })),
      })
    }
    if (path === `${API_PREFIX}/keys`) {
      const { payload } = loadData()
      const keys = new Set()
      for (const record of payload.defs || []) {
        const fields = record.fields
        if (!fields) continue
        for (const name of Object.keys(fields.scalars || {})) keys.add(name)
        if (fields.statBases && fields.statBases.value) {
          for (const name of Object.keys(fields.statBases.value)) keys.add(name)
        }
        if (fields.comps && fields.comps.value) {
          for (const comp of fields.comps.value) {
            if (comp.class) keys.add(comp.class)
            for (const name of Object.keys(comp.props || {})) keys.add(name)
          }
        }
        if (record.category) keys.add(record.category)
        for (const name of record.thingCategories || []) keys.add(name)
      }
      return json({ keys: [...keys].sort((a, b) => a.localeCompare(b)) })
    }
    if (path === `${API_PREFIX}/tools`) {
      return json({ tools: TOOL_CATALOG, registered: registeredTools })
    }
    if (path === `${API_PREFIX}/xml`) {
      const rel = url.searchParams.get('path') || ''
      if (!rel.startsWith('Data/') || !rel.endsWith('.xml') || rel.includes('..')) {
        return new Response('bad path', { status: 400 })
      }
      if (!gameRoot) {
        return json({ error: '未找到 RimWorld 目录，无法读取 XML', paths: pathSummary(paths) }, 503)
      }
      const root = resolvePath(gameRoot)
      const full = resolvePath(root, rel)
      if (!full.startsWith(root + sep)) return new Response('bad path', { status: 400 })
      try {
        const stat = statSync(full)
        if (stat.size > 4 * 1024 * 1024) return new Response('file too large', { status: 413 })
        return new Response(readFileSync(full, 'utf8'), {
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
        })
      } catch {
        return new Response('not found', { status: 404 })
      }
    }
    if (path === `${API_PREFIX}/icon`) {
      const tex = url.searchParams.get('tex') || ''
      const source = url.searchParams.get('source') || 'Core'
      if (!TEX_PATTERN.test(tex) || !TEX_PATTERN.test(source)) {
        return new Response('bad tex', { status: 400 })
      }
      try {
        const png = await renderIcon(tex, source)
        return new Response(png, {
          headers: { 'content-type': 'image/png', 'cache-control': 'max-age=3600' },
        })
      } catch (error) {
        return new Response(`icon unavailable: ${error.message}`, { status: 404 })
      }
    }
    if (path === `${API_PREFIX}/placeholder`) {
      if (!placeholderPath) return new Response('no placeholder', { status: 404 })
      try {
        const bytes = readFileSync(placeholderPath)
        return new Response(bytes, {
          headers: { 'content-type': 'image/jpeg', 'cache-control': 'max-age=3600' },
        })
      } catch {
        return new Response('no placeholder', { status: 404 })
      }
    }
    return new Response('not found', { status: 404 })
  }

  /** 可预期错误（数据缺失、无游戏目录）统一转 503 + 路径快照，而不是未捕获异常。 */
  async function handle(request) {
    try {
      return await route(request)
    } catch (error) {
      return json({ error: `rimworld-defs: ${error?.message ?? error}`, paths: pathSummary(paths) }, 503)
    }
  }

  ctx.effect(() =>
    web.register({
      kind: 'prefix',
      path: API_PREFIX,
      resource: handle,
    }),
  )
  ctx.logger?.info?.('rimworld-defs: panel API registered')
}

/**
 * Host half of the RimWorld Defs panel.
 *
 * Serves a browsing index (source → category → defs), one def's full record,
 * quick search and rendered item textures. Textures come from Assets.zip as
 * split DDS compressed with ZSTD; the project's Python renderer decodes them.
 */
import { cpSync, mkdirSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve as resolvePath, dirname, join, sep } from 'node:path'
import { PACKAGE_DIR, REPO_ROOT, resolvePaths } from './paths.js'
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
  // 这些变量可在「基础设置」里修改数据目录后热重载。
  let paths = resolvePaths(config)
  let dataPath = paths.dataPath.value
  let dataDir = dirname(dataPath)
  let gameRoot = paths.gameRoot.value
  let pythonExe = paths.pythonExe.value
  let renderScript = paths.renderScript.value
  let placeholderPath = paths.placeholderPath.value
  let cacheDir = paths.cacheDir.value
  let unityPyPath = paths.unityPyPath.value

  ctx.logger?.info?.(
    `rimworld-defs: 路径解析 data=${paths.dataPath.source} game=${paths.gameRoot.source} python=${paths.pythonExe.source}`,
  )
  if (!gameRoot) {
    ctx.logger?.warn?.(
      'rimworld-defs: 未找到 RimWorld 目录，版本提示与 XML 预览不可用；可设 RIMWORLD_GAME 或写 rimworld-defs.local.json',
    )
  }

  // ---- 创意工坊：状态 + 检测 / 拉取 / 删除（不做任何自动爬取）----
  let workshopDir = join(dataDir, 'workshop')
  let workshopStatePath = join(dataDir, 'workshop-state.json')
  const workshopScript = join(REPO_ROOT, 'scripts', 'workshop_defs.py')
  const workshopCache = new Map()

  function readWorkshopState() {
    try {
      const parsed = JSON.parse(readFileSync(workshopStatePath, 'utf8'))
      if (parsed && typeof parsed === 'object' && parsed.mods && typeof parsed.mods === 'object') return parsed
    } catch {
      /* 状态文件缺失或损坏：从空状态开始 */
    }
    return { mods: {}, lastDetect: null, contentDir: null, gameMajor: null }
  }

  function writeWorkshopState(state) {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(workshopStatePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }

  /** 跑一次 Python 脚本并返回 stdout；失败时把 stderr 原文抛出来。 */
  function runPython(args, timeoutMs) {
    return new Promise((resolve, reject) => {
      execFile(
        pythonExe,
        args,
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
        (error, stdout, stderr) => {
          if (error) {
            if (error.code === 'ENOENT') {
              reject(new Error(`找不到 Python 解释器「${pythonExe}」`))
              return
            }
            reject(new Error(String(stderr || '').trim() || error.message))
            return
          }
          resolve(String(stdout || ''))
        },
      )
    })
  }

  /** 检测工坊模组，并把结果与已有状态合并（保留已拉取但暂时缺失的模组）。 */
  async function detectWorkshopMods() {
    mkdirSync(workshopDir, { recursive: true })
    const outFile = join(workshopDir, `detect-${Date.now()}.json`)
    await runPython(
      [workshopScript, 'list', '--json', '--out', outFile, ...(gameRoot ? ['--game', gameRoot] : [])],
      120000,
    )
    const detected = JSON.parse(readFileSync(outFile, 'utf8'))
    try {
      unlinkSync(outFile)
    } catch {
      /* 忽略清理失败 */
    }

    const state = readWorkshopState()
    const next = {}
    for (const mod of detected.mods || []) {
      const previous = state.mods[mod.id] || {}
      const pulled = previous.pulled === true
      next[mod.id] = {
        ...mod,
        pulled,
        pulledAt: previous.pulledAt || null,
        defsCount: previous.defsCount || 0,
        missing: false,
        // 已拉取且 manifest 变化 → 前端显示黄色「更新」
        updateAvailable: pulled && Boolean(previous.manifest) && previous.manifest !== mod.manifest,
      }
    }
    for (const [id, previous] of Object.entries(state.mods)) {
      if (next[id]) continue
      // 已拉取的保留（标注 missing）；未拉取的记录直接丢弃。
      if (previous.pulled === true) next[id] = { ...previous, missing: true, updateAvailable: false }
    }

    const merged = {
      mods: Object.fromEntries(Object.entries(next).sort((a, b) => a[1].name.localeCompare(b[1].name))),
      lastDetect: new Date().toISOString(),
      contentDir: detected.contentDir || state.contentDir || null,
      gameMajor: detected.gameMajor || state.gameMajor || null,
    }
    writeWorkshopState(merged)
    return merged
  }

  function statePayload(state) {
    return {
      contentDir: state.contentDir || null,
      gameMajor: state.gameMajor || null,
      lastDetect: state.lastDetect || null,
      mods: Object.values(state.mods || {}),
    }
  }

  /** 读取已拉取的模组 Defs 文件（带 mtime 缓存）。 */
  function loadWorkshopMod(id, state) {
    const entry = (state || readWorkshopState()).mods[id]
    if (!entry || entry.pulled !== true) return null
    const file = join(workshopDir, `${id}.json`)
    if (!existsSync(file)) return null
    const mtimeMs = statSync(file).mtimeMs
    const cached = workshopCache.get(id)
    if (cached && cached.mtimeMs === mtimeMs) return cached.payload
    const payload = JSON.parse(readFileSync(file, 'utf8'))
    workshopCache.set(id, { mtimeMs, payload })
    return payload
  }

  /** 把已拉取的工坊模组挂到索引里：一个 "Mods" 来源，按模组分组，不再细分。 */
  function appendWorkshopIndex(sources) {
    const state = readWorkshopState()
    const groups = []
    for (const mod of Object.values(state.mods || {})) {
      if (mod.pulled !== true) continue
      const payload = loadWorkshopMod(mod.id, state)
      if (!payload) continue
      const items = (payload.defs || [])
        .filter((record) => (record.defName || record.Name) && record.Abstract !== true)
        .map((record) => ({
          defName: record.defName || record.Name,
          defType: record.defType,
          label: record.labelZh || record.label || record.titleZh || record.title || record.defName || record.Name || '',
        }))
      if (items.length === 0) continue
      items.sort((a, b) => (a.label || a.defName).localeCompare(b.label || b.defName))
      groups.push({ key: `mod:${mod.id}`, label: mod.name || mod.id, count: items.length, items })
    }
    // 即使一个模组都没拉取，也保留 "Mods" 节点，避免文件树结构忽隐忽现。
    sources.push({ name: 'Mods', count: groups.reduce((sum, group) => sum + group.count, 0), groups })
  }

  /** 在已拉取的工坊模组里按 defName/Name + defType 找一条记录。 */
  function findWorkshopDef(name, defType) {
    const state = readWorkshopState()
    for (const mod of Object.values(state.mods || {})) {
      if (mod.pulled !== true) continue
      const payload = loadWorkshopMod(mod.id, state)
      if (!payload) continue
      const hit = (payload.defs || []).find(
        (record) =>
          (record.defName === name || record.Name === name) &&
          (!defType || String(record.defType || '').toLowerCase() === defType.toLowerCase()),
      )
      if (hit) return hit
    }
    return null
  }

  function workshopTexture(id, texPath, state) {
    const entry = (state || readWorkshopState()).mods[id]
    const contentDir = (state || readWorkshopState()).contentDir
    if (!entry || !contentDir) return null
    const modDir = join(contentDir, id)
    const base = String(texPath || '').replace(/^\/+/, '').replace(/\\/g, '/')
    const rel = base.startsWith('Textures/') ? base : `Textures/${base}`
    const candidates = [join(modDir, rel), entry.defsDir ? join(modDir, entry.defsDir, '..', rel) : null].filter(Boolean)
    for (const candidate of candidates) {
      for (const extension of ['.png', '.jpg', '.jpeg']) {
        const file = `${candidate}${extension}`
        if (existsSync(file)) {
          return { bytes: readFileSync(file), type: extension === '.png' ? 'image/png' : 'image/jpeg' }
        }
      }
    }
    return null
  }

  // ---- 我的模组：用户自己的工作文件夹（可能含多个 Mod）----
  let mineDir = join(dataDir, 'mine')
  let mineStatePath = join(dataDir, 'mymods-state.json')
  const mineScript = join(REPO_ROOT, 'scripts', 'mymods_defs.py')
  const mineCache = new Map()

  function mineFolderId(folderPath) {
    const normalized = String(folderPath).replace(/\\/g, '/').toLowerCase()
    return createHash('sha1').update(normalized).digest('hex').slice(0, 12)
  }

  function readMineState() {
    try {
      const parsed = JSON.parse(readFileSync(mineStatePath, 'utf8'))
      if (parsed && Array.isArray(parsed.folders)) return parsed
    } catch {
      /* 状态文件缺失或损坏 */
    }
    return { folders: [] }
  }

  function writeMineState(state) {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(mineStatePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }

  function loadMineFolder(id, state) {
    const entry = (state || readMineState()).folders.find((item) => item.id === id)
    if (!entry) return null
    const file = join(mineDir, `${id}.json`)
    if (!existsSync(file)) return null
    const mtimeMs = statSync(file).mtimeMs
    const cached = mineCache.get(id)
    if (cached && cached.mtimeMs === mtimeMs) return cached.payload
    const payload = JSON.parse(readFileSync(file, 'utf8'))
    mineCache.set(id, { mtimeMs, payload })
    return payload
  }

  function appendMineIndex(sources) {
    const state = readMineState()
    const groups = []
    for (const folder of state.folders) {
      const payload = loadMineFolder(folder.id, state)
      if (!payload) continue
      const items = (payload.defs || [])
        .filter((record) => (record.defName || record.Name) && record.Abstract !== true)
        .map((record) => ({
          defName: record.defName || record.Name,
          defType: record.defType,
          label: record.labelZh || record.label || record.titleZh || record.title || record.defName || record.Name || '',
        }))
      if (items.length === 0) continue
      items.sort((a, b) => (a.label || a.defName).localeCompare(b.label || b.defName))
      groups.push({ key: `mine:${folder.id}`, label: folder.name, count: items.length, items })
    }
    sources.push({ name: 'Mine', count: groups.reduce((sum, group) => sum + group.count, 0), groups })
  }

  function findMineDef(name, defType) {
    const state = readMineState()
    for (const folder of state.folders) {
      const payload = loadMineFolder(folder.id, state)
      if (!payload) continue
      const hit = (payload.defs || []).find(
        (record) =>
          (record.defName === name || record.Name === name) &&
          (!defType || String(record.defType || '').toLowerCase() === defType.toLowerCase()),
      )
      if (hit) return hit
    }
    return null
  }

  function mineTexture(id, texPath, state) {
    const folder = (state || readMineState()).folders.find((item) => item.id === id)
    if (!folder) return null
    const base = String(texPath || '').replace(/^\/+/, '').replace(/\\/g, '/')
    const rel = base.startsWith('Textures/') ? base : `Textures/${base}`
    for (const extension of ['.png', '.jpg', '.jpeg']) {
      const file = join(folder.path, `${rel}${extension}`)
      if (existsSync(file)) {
        return { bytes: readFileSync(file), type: extension === '.png' ? 'image/png' : 'image/jpeg' }
      }
    }
    return null
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
  const TEX_PATTERN = /^[A-Za-z0-9 _\-/.:]+$/

  // ---- 基础设置：数据目录（写回 rimworld-defs.local.json 的 dataPath）----
  const localConfigPath = join(REPO_ROOT, 'rimworld-defs.local.json')

  function readLocalConfig() {
    try {
      const parsed = JSON.parse(readFileSync(localConfigPath, 'utf8'))
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      /* 配置缺失或损坏 */
    }
    return {}
  }

  function basicSettings() {
    const local = readLocalConfig()
    const saved = typeof local.dataPath === 'string' && local.dataPath.trim() ? local.dataPath : null
    return {
      dataPath: { value: dataPath, source: paths.dataPath.source, exists: existsSync(dataPath) },
      savedDataPath: saved || join(REPO_ROOT, 'data', 'rimworld-defs.json'),
      defaultDataPath: join(REPO_ROOT, 'data', 'rimworld-defs.json'),
      dataDir,
      localConfig: localConfigPath,
    }
  }

  /** 配置变更后重解析路径并丢弃所有派生缓存。 */
  function reloadPaths() {
    paths = resolvePaths(config)
    dataPath = paths.dataPath.value
    dataDir = dirname(dataPath)
    gameRoot = paths.gameRoot.value
    pythonExe = paths.pythonExe.value
    renderScript = paths.renderScript.value
    placeholderPath = paths.placeholderPath.value
    cacheDir = paths.cacheDir.value
    unityPyPath = paths.unityPyPath.value
    workshopDir = join(dataDir, 'workshop')
    workshopStatePath = join(dataDir, 'workshop-state.json')
    mineDir = join(dataDir, 'mine')
    mineStatePath = join(dataDir, 'mymods-state.json')
    cache = { mtimeMs: 0, payload: null, index: null, lookup: null }
    workshopCache.clear()
    mineCache.clear()
  }

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
      // buildIndex 会缓存并复用同一个数组，先过滤掉旧的 Mods 再追加，
      // 否则多次请求会在这个缓存数组里累积出多个 "Mods" 来源。
      const sources = buildIndex(payload).filter((source) => source.name !== 'Mods' && source.name !== 'Mine')
      appendWorkshopIndex(sources)
      appendMineIndex(sources)
      return json({ notice: notice(payload), groups: GROUPS, sources })
    }
    if (path === `${API_PREFIX}/settings/basic`) {
      return json(basicSettings())
    }
    if (path === `${API_PREFIX}/settings/basic/set`) {
      const dir = (url.searchParams.get('dir') || '').trim()
      if (!dir) return json({ error: '请填写数据目录' }, 400)
      const resolvedDir = resolvePath(dir)
      // 只接受已存在的目录：不存在就保持原样并报错，不替用户创建。
      if (!existsSync(resolvedDir) || !statSync(resolvedDir).isDirectory()) {
        return json({ error: `目录不存在：${resolvedDir}` }, 404)
      }
      const localConfig = readLocalConfig()
      localConfig.dataPath = join(resolvedDir, 'rimworld-defs.json')
      try {
        // 换目录时把工坊/我的模组的状态与已拉取数据迁移过去，避免静默丢失。
        if (resolvedDir !== dataDir) {
          for (const name of ['workshop-state.json', 'mymods-state.json']) {
            const source = join(dataDir, name)
            const target = join(resolvedDir, name)
            if (existsSync(source) && !existsSync(target)) cpSync(source, target)
          }
          for (const name of ['workshop', 'mine']) {
            const source = join(dataDir, name)
            const target = join(resolvedDir, name)
            if (existsSync(source) && !existsSync(target)) cpSync(source, target, { recursive: true })
          }
        }
        writeFileSync(localConfigPath, `${JSON.stringify(localConfig, null, 2)}\n`, 'utf8')
      } catch (error) {
        return json({ error: `写入配置失败：${error.message}` }, 500)
      }
      reloadPaths()
      return json(basicSettings())
    }
    if (path === `${API_PREFIX}/settings/basic/regenerate`) {
      try {
        const output = await runPython([join(REPO_ROOT, 'scripts', 'extract_defs.py')], 300000)
        reloadPaths()
        return json({ ok: true, output: String(output).trim().slice(-600), settings: basicSettings() })
      } catch (error) {
        return json({ error: `生成失败：${error.message}` }, 502)
      }
    }
    if (path === `${API_PREFIX}/workshop/state`) {
      return json(statePayload(readWorkshopState()))
    }
    if (path === `${API_PREFIX}/workshop/detect`) {
      try {
        return json(statePayload(await detectWorkshopMods()))
      } catch (error) {
        return json({ error: `检测失败：${error.message}` }, 502)
      }
    }
    if (path === `${API_PREFIX}/workshop/pull` || path === `${API_PREFIX}/workshop/update`) {
      const id = url.searchParams.get('id') || ''
      if (!/^\d+$/.test(id)) return json({ error: 'bad id' }, 400)
      const state = readWorkshopState()
      const entry = state.mods[id]
      if (!entry) return json({ error: '该模组不在检测结果中，请先检测' }, 404)
      try {
        mkdirSync(workshopDir, { recursive: true })
        const outFile = join(workshopDir, `${id}.json`)
        await runPython(
          [workshopScript, 'extract', '--id', id, '--out', outFile, ...(gameRoot ? ['--game', gameRoot] : [])],
          180000,
        )
        const payload = JSON.parse(readFileSync(outFile, 'utf8'))
        entry.pulled = true
        entry.pulledAt = new Date().toISOString()
        entry.defsCount = (payload.defs || []).length
        entry.missing = false
        entry.updateAvailable = false
        writeWorkshopState(state)
        workshopCache.delete(id)
        return json({ mod: entry })
      } catch (error) {
        return json({ error: `拉取失败：${error.message}` }, 502)
      }
    }
    if (path === `${API_PREFIX}/workshop/remove`) {
      const id = url.searchParams.get('id') || ''
      if (!/^\d+$/.test(id)) return json({ error: 'bad id' }, 400)
      const state = readWorkshopState()
      const entry = state.mods[id]
      if (!entry) return json({ error: '该模组不在检测结果中' }, 404)
      // 只删数据，保留卡片：下次仍能直接再次拉取。
      entry.pulled = false
      entry.defsCount = 0
      entry.pulledAt = null
      entry.updateAvailable = false
      writeWorkshopState(state)
      try {
        unlinkSync(join(workshopDir, `${id}.json`))
      } catch {
        /* 文件可能已不存在 */
      }
      workshopCache.delete(id)
      return json({ mod: entry })
    }
    if (path === `${API_PREFIX}/mymods/state`) {
      return json(readMineState())
    }
    if (path === `${API_PREFIX}/mymods/add`) {
      const folderPath = (url.searchParams.get('path') || '').trim()
      if (!folderPath) return json({ error: '请填写文件夹路径' }, 400)
      const resolved = resolvePath(folderPath)
      if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
        return json({ error: `文件夹不存在：${resolved}` }, 404)
      }
      const id = mineFolderId(resolved)
      try {
        mkdirSync(mineDir, { recursive: true })
        const outFile = join(mineDir, `${id}.json`)
        await runPython([mineScript, 'extract', '--dir', resolved, '--id', id, '--out', outFile], 180000)
        const payload = JSON.parse(readFileSync(outFile, 'utf8'))
        const state = readMineState()
        const existing = state.folders.find((item) => item.id === id)
        const entry = {
          id,
          path: resolved,
          name: payload.name || resolved.split(/[\\/]/).filter(Boolean).pop() || resolved,
          defsCount: (payload.defs || []).length,
          addedAt: existing ? existing.addedAt : new Date().toISOString(),
        }
        state.folders = existing
          ? state.folders.map((item) => (item.id === id ? entry : item))
          : [...state.folders, entry]
        writeMineState(state)
        mineCache.delete(id)
        return json({ folder: entry })
      } catch (error) {
        return json({ error: `扫描失败：${error.message}` }, 502)
      }
    }
    if (path === `${API_PREFIX}/mymods/remove`) {
      const id = url.searchParams.get('id') || ''
      const state = readMineState()
      const next = state.folders.filter((item) => item.id !== id)
      if (next.length === state.folders.length) return json({ error: '该文件夹不在列表中' }, 404)
      state.folders = next
      writeMineState(state)
      try {
        unlinkSync(join(mineDir, `${id}.json`))
      } catch {
        /* 文件可能已不存在 */
      }
      mineCache.delete(id)
      return json({ ok: true })
    }
    if (path === `${API_PREFIX}/workshop/preview`) {
      const id = url.searchParams.get('id') || ''
      const state = readWorkshopState()
      const entry = state.mods[id]
      if (!/^\d+$/.test(id) || !entry || !entry.preview || !state.contentDir) {
        return new Response('no preview', { status: 404 })
      }
      try {
        const bytes = readFileSync(join(state.contentDir, id, entry.preview))
        const type = entry.preview.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'
        return new Response(bytes, { headers: { 'content-type': type, 'cache-control': 'max-age=3600' } })
      } catch {
        return new Response('no preview', { status: 404 })
      }
    }
    if (path === `${API_PREFIX}/def`) {
      const { payload } = loadData()
      const name = url.searchParams.get('name') || ''
      const defType = url.searchParams.get('type') || ''
      let record = (payload.defs || []).find(
        (item) =>
          item.defName === name &&
          (!defType || String(item.defType || '').toLowerCase() === defType.toLowerCase()),
      )
      if (!record) record = findWorkshopDef(name, defType)
      if (!record) record = findMineDef(name, defType)
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
    if (path === `${API_PREFIX}/presets`) {
      // 内置翻译预设随包分发，只读；面板把它作为「可选翻译集」之一。
      try {
        const raw = readFileSync(join(PACKAGE_DIR, 'presets', 'zh-CN.json'), 'utf8')
        return json(JSON.parse(raw))
      } catch (error) {
        return json({ error: `preset unavailable: ${error.message}` }, 503)
      }
    }
    if (path === `${API_PREFIX}/brand`) {
      // 空状态用图：优先 webp logo，其次 png 备选；都没有就 404，前端回落为纯文字。
      for (const [fileName, contentType] of [
        ['brand.webp', 'image/webp'],
        ['brand.png', 'image/png'],
      ]) {
        try {
          const bytes = readFileSync(join(REPO_ROOT, 'assets', fileName))
          return new Response(bytes, {
            headers: { 'content-type': contentType, 'cache-control': 'max-age=86400' },
          })
        } catch {
          /* 换下一个候选 */
        }
      }
      return new Response('no brand image', { status: 404 })
    }
    if (path === `${API_PREFIX}/tools`) {
      return json({ tools: TOOL_CATALOG, registered: registeredTools })
    }
    if (path === `${API_PREFIX}/xml`) {
      const rel = url.searchParams.get('path') || ''
      const source = url.searchParams.get('source') || ''
      if (!rel.endsWith('.xml') || rel.includes('..')) return new Response('bad path', { status: 400 })

      if (source.startsWith('workshop:')) {
        const id = source.slice('workshop:'.length)
        const state = readWorkshopState()
        if (!/^\d+$/.test(id) || !state.contentDir) return new Response('bad source', { status: 400 })
        const root = resolvePath(state.contentDir, id)
        const full = resolvePath(root, rel)
        if (!full.startsWith(root + sep)) return new Response('bad path', { status: 400 })
        try {
          if (statSync(full).size > 4 * 1024 * 1024) return new Response('file too large', { status: 413 })
          return new Response(readFileSync(full, 'utf8'), {
            headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
          })
        } catch {
          return new Response('not found', { status: 404 })
        }
      }

      if (source.startsWith('mine:')) {
        const state = readMineState()
        const folderEntry = state.folders.find((item) => item.id === source.slice('mine:'.length))
        if (!folderEntry) return new Response('bad source', { status: 400 })
        const root = resolvePath(folderEntry.path)
        const full = resolvePath(root, rel)
        if (!full.startsWith(root + sep)) return new Response('bad path', { status: 400 })
        try {
          if (statSync(full).size > 4 * 1024 * 1024) return new Response('file too large', { status: 413 })
          return new Response(readFileSync(full, 'utf8'), {
            headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
          })
        } catch {
          return new Response('not found', { status: 404 })
        }
      }

      if (!rel.startsWith('Data/')) return new Response('bad path', { status: 400 })
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
      if (source.startsWith('workshop:')) {
        const found = workshopTexture(source.slice('workshop:'.length), tex, readWorkshopState())
        if (!found) return new Response('icon unavailable', { status: 404 })
        return new Response(found.bytes, {
          headers: { 'content-type': found.type, 'cache-control': 'max-age=3600' },
        })
      }
      if (source.startsWith('mine:')) {
        const found = mineTexture(source.slice('mine:'.length), tex, readMineState())
        if (!found) return new Response('icon unavailable', { status: 404 })
        return new Response(found.bytes, {
          headers: { 'content-type': found.type, 'cache-control': 'max-age=3600' },
        })
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

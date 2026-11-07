/**
 * 本机路径解析（Node 侧）：与 `scripts/paths.py` 保持完全相同的优先级。
 *
 * 目标：`ui/` 里不再出现任何绝对路径。所有路径要么由包位置派生，要么来自
 * 环境变量 / 本机配置文件（`rimworld-defs.local.json`，gitignore）。
 *
 * 解析顺序（自高到低）：
 *
 *   游戏根目录：RIMWORLD_GAME → 本机配置 → bundle 配置 → 数据文件记录 → Steam → 兜底目录
 *   数据文件：  RIMWORLD_DATA → 本机配置 → bundle 配置 → <仓库根>/data/rimworld-defs.json
 *   解释器：    RIMWORLD_PYTHON → 本机配置 → bundle 配置 → python
 *
 * Python 侧没有 `reg query` 之外的差异：两边都读注册表 → libraryfolders.vdf →
 * 候选目录，顺序一致，避免出现「命令行找得到、面板找不到」的分裂。
 */
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ENV_GAME = 'RIMWORLD_GAME'
const ENV_DATA = 'RIMWORLD_DATA'
const ENV_PYTHON = 'RIMWORLD_PYTHON'

const LOCAL_CONFIG_NAME = 'rimworld-defs.local.json'
const GAME_MARKER = join('Data', 'Core', 'Defs')

/** `ui/` 包根目录（本文件所在目录）。 */
export const PACKAGE_DIR = resolve(fileURLToPath(new URL('./', import.meta.url)))

/** 仓库根目录（`ui/` 的上一级）；SKILL.md、scripts/、data/ 都在这里。 */
export const REPO_ROOT = resolve(PACKAGE_DIR, '..')

/** 读取头部若干字节；用于从 8 MB 数据文件里只取出 `gameRoot`。 */
function readHead(path, bytes = 8192) {
  let fd
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(bytes)
    const read = readSync(fd, buffer, 0, bytes, 0)
    return buffer.subarray(0, read).toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function clean(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function localConfig() {
  const path = join(REPO_ROOT, LOCAL_CONFIG_NAME)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return { path, value: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {} }
  } catch {
    return { path, value: {} }
  }
}

/** 「这是一个可用的 RimWorld 根目录」的唯一判据，与 Python 侧一致。 */
export function isValidGameRoot(path) {
  return Boolean(path) && existsSync(join(path, GAME_MARKER))
}

/** 从注册表读 Steam 安装目录；非 Windows 或读取失败时返回空数组。 */
function registrySteamPaths() {
  if (process.platform !== 'win32') return []
  const probes = [
    ['HKCU\\Software\\Valve\\Steam', 'SteamPath'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
    ['HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'],
  ]
  const found = []
  for (const [key, valueName] of probes) {
    try {
      const text = execFileSync('reg', ['query', key, '/v', valueName], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed.startsWith(valueName) || !trimmed.includes('REG_')) continue
        const parts = trimmed.split(/\s{2,}/)
        const value = parts[parts.length - 1]
        if (value) found.push(value)
      }
    } catch {
      // 注册表键不存在或 reg 不可用：跳过，继续下一个来源。
    }
  }
  return found
}

/** 解析 `steamapps/libraryfolders.vdf`；Steam 与游戏不同盘时只有这里能拿到库路径。 */
function libraryFolders(steamRoot) {
  const vdf = join(steamRoot, 'steamapps', 'libraryfolders.vdf')
  let text
  try {
    text = readFileSync(vdf, 'utf8')
  } catch {
    return []
  }
  const libraries = []
  for (const match of text.matchAll(/"path"\s+"([^"]+)"/g)) {
    libraries.push(match[1].replace(/\\\\/g, '\\'))
  }
  return libraries
}

function steamCandidates() {
  const candidates = []
  for (const steamRoot of registrySteamPaths()) {
    candidates.push(join(steamRoot, 'steamapps', 'common', 'RimWorld'))
    for (const library of libraryFolders(steamRoot)) {
      candidates.push(join(library, 'steamapps', 'common', 'RimWorld'))
    }
  }
  return candidates
}

function driveRoots() {
  const roots = []
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`
    if (existsSync(root)) roots.push(root)
  }
  return roots
}

function fallbackCandidates() {
  const suffixes = [
    join('steamapps', 'common', 'RimWorld'),
    join('SteamLibrary', 'steamapps', 'common', 'RimWorld'),
    join('Steam', 'steamapps', 'common', 'RimWorld'),
    join('Games', 'SteamLibrary', 'steamapps', 'common', 'RimWorld'),
    join('Program Files (x86)', 'Steam', 'steamapps', 'common', 'RimWorld'),
    join('GOG Games', 'RimWorld'),
  ]
  const candidates = []
  for (const drive of driveRoots()) {
    for (const suffix of suffixes) candidates.push(join(drive, suffix))
  }
  return candidates
}

/** 分开报告 Steam 命中与兜底命中，便于 `/meta` 与排障说明「这条路径哪来的」。 */
export function discoverySources() {
  const unique = (paths) => [...new Set(paths.filter((path) => isValidGameRoot(path)))]
  return {
    steam: unique(steamCandidates()),
    fallback: unique(fallbackCandidates()),
  }
}

/** 全部可用安装（Steam 命中优先，去重）。 */
export function discoverGameRoots() {
  const seen = new Set()
  const found = []
  const sources = discoverySources()
  for (const candidate of [...sources.steam, ...sources.fallback]) {
    const key = candidate.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    found.push(candidate)
  }
  return found
}

/** 数据文件里记录的 gameRoot（只读文件头 8 KB，不解析 8 MB JSON）。 */
function gameRootFromData(dataPath) {
  const head = readHead(dataPath)
  if (head === null) return null
  const match = head.match(/"gameRoot"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  if (match === null) return null
  try {
    return JSON.parse(`"${match[1]}"`)
  } catch {
    return null
  }
}

function entry(value, source, { validate } = {}) {
  const valid = validate ? validate(value) : value !== null
  return { value: value ?? null, source: value === null ? 'none' : source, valid }
}

function pick(entries) {
  for (const item of entries) {
    if (item.value !== null) return item
  }
  return entries[entries.length - 1]
}

/**
 * 解析全部路径。
 * @param config - bundle 配置（`ui/cordis.patch.yml` 的 config），可为空。
 * @returns 每项形如 `{ value, source, valid }`；`source` 说明该值来自哪一层。
 */
export function resolvePaths(config = {}) {
  const local = localConfig()
  const localValue = local.value

  const dataPath = pick([
    entry(clean(process.env[ENV_DATA]), 'env'),
    entry(clean(localValue.dataPath), 'local-config'),
    entry(clean(config.dataPath), 'config'),
    entry(join(REPO_ROOT, 'data', 'rimworld-defs.json'), 'derived'),
  ])
  dataPath.valid = existsSync(dataPath.value)

  const gameCandidates = [
    entry(clean(process.env[ENV_GAME]), 'env', { validate: isValidGameRoot }),
    entry(clean(localValue.gameRoot), 'local-config', { validate: isValidGameRoot }),
    entry(clean(config.gameRoot), 'config', { validate: isValidGameRoot }),
    entry(gameRootFromData(dataPath.value), 'data-file', { validate: isValidGameRoot }),
  ]
  const configured = pick(gameCandidates)
  let gameRoot = configured
  let discovery = { steam: [], fallback: [] }
  if (gameRoot.value === null) {
    discovery = discoverySources()
    const first = discovery.steam[0] ?? discovery.fallback[0] ?? null
    gameRoot = entry(first, discovery.steam.length > 0 ? 'steam' : 'fallback', { validate: isValidGameRoot })
  }

  const pythonExe = pick([
    entry(clean(process.env[ENV_PYTHON]), 'env'),
    entry(clean(localValue.pythonExe), 'local-config'),
    entry(clean(config.pythonExe), 'config'),
    entry('python', 'derived'),
  ])

  const renderScript = pick([
    entry(clean(localValue.renderScript), 'local-config'),
    entry(clean(config.renderScript), 'config'),
    entry(join(REPO_ROOT, 'scripts', 'render_icon.py'), 'derived'),
  ])
  renderScript.valid = existsSync(renderScript.value)

  const placeholderPath = pick([
    entry(clean(localValue.placeholderPath), 'local-config'),
    entry(clean(config.placeholderPath), 'config'),
    entry(join(REPO_ROOT, 'assets', 'placeholder.jpg'), 'derived'),
  ])
  placeholderPath.valid = existsSync(placeholderPath.value)

  const cacheDir = pick([
    entry(clean(localValue.cacheDir), 'local-config'),
    entry(clean(config.cacheDir), 'config'),
    entry(join(REPO_ROOT, 'data', 'icon-cache'), 'derived'),
  ])

  const unityPyPath = pick([
    entry(clean(localValue.unityPyPath), 'local-config'),
    entry(clean(config.unityPyPath), 'config'),
    entry(null, 'none'),
  ])

  return {
    packageDir: PACKAGE_DIR,
    repoRoot: REPO_ROOT,
    localConfig: { path: local.path, exists: existsSync(local.path) },
    dataPath,
    gameRoot,
    pythonExe,
    renderScript,
    placeholderPath,
    cacheDir,
    unityPyPath,
    discovery,
    discoveredGameRoots: discoverGameRoots(),
  }
}

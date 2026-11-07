/**
 * 查询层子进程封装：面板注册的智能体工具与 `/rimworld-defs/api/tools` 共用。
 *
 * 刻意把查询交给 `scripts/query_defs.py` 执行，而不是在 Node 里重写一遍：
 * - 查询语义（父链、category 有效值、Abstract 过滤）只有一份实现，不会漂移；
 * - 输出是 JSON，Node 直接 `JSON.parse`，不经过控制台，因此没有编码问题。
 *
 * 换机健壮性：显式配置的解释器不存在（ENOENT）时，自动回退到
 * `python3` / Windows 的 `py -3`，避免"只有 py 没有 python"的机器直接不可用。
 */
import { execFile } from 'node:child_process'

/** 单次查询的默认超时：Python 冷启动 + 解析 8 MB JSON 通常 < 400 ms。 */
const DEFAULT_TIMEOUT_MS = 30_000

/** stdout 上限：search-label 大 limit 时可能很大，给到 32 MB。 */
const MAX_BUFFER = 32 * 1024 * 1024

/** 解释器回退顺序（去重后依次尝试）。
 *  Windows 上不用 python3：它常被 Microsoft Store 的占位符占用（exit 9009），
 *  真正可用的是 py 启动器；其余平台用 python3。 */
function pythonFallbacks() {
  return process.platform === 'win32' ? ['py'] : ['python3']
}

function runOnce({ pythonExe, script, args, timeoutMs }) {
  const prefix = pythonExe === 'py' ? ['-3'] : []
  return new Promise((resolve, reject) => {
    execFile(
      pythonExe,
      [...prefix, script, ...args],
      { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || '').trim() || error.message
          if (error.code === 'ENOENT' || error.code === 9009) {
            const notFound = new Error(`找不到 Python 解释器「${pythonExe}」`)
            notFound.notFound = true
            reject(notFound)
            return
          }
          if (error.killed) {
            reject(new Error(`查询超时（${timeoutMs} ms）：${detail}`))
            return
          }
          reject(new Error(`查询失败：${detail}`))
          return
        }
        try {
          resolve(JSON.parse(stdout))
        } catch (parseError) {
          reject(new Error(`查询输出不是 JSON：${parseError.message}`))
        }
      },
    )
  })
}

/**
 * 运行一次查询并返回解析后的 JSON。
 *
 * @param options - `{ pythonExe, script, args, timeoutMs }`。
 * @returns 形如 `{ notice, count, results }` 的对象。
 * @throws Error 当所有解释器都缺失、退出码非零或输出不是 JSON。
 */
export async function runQuery(options) {
  const tried = []
  for (const exe of [options.pythonExe, ...pythonFallbacks()]) {
    if (!exe || tried.includes(exe)) continue
    tried.push(exe)
    try {
      return await runOnce({ ...options, pythonExe: exe })
    } catch (error) {
      if (!error.notFound) throw error
    }
  }
  throw new Error(
    `找不到可用的 Python 解释器（已尝试：${tried.join('、')}）：设 RIMWORLD_PYTHON、写本机配置，或确保 python 在 PATH 上`,
  )
}

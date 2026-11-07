/**
 * 查询层子进程封装：面板注册的智能体工具与 `/rimworld-defs/api/tools` 共用。
 *
 * 刻意把查询交给 `scripts/query_defs.py` 执行，而不是在 Node 里重写一遍：
 * - 查询语义（父链、category 有效值、Abstract 过滤）只有一份实现，不会漂移；
 * - 输出是 JSON，Node 直接 `JSON.parse`，不经过控制台，因此没有编码问题。
 */
import { execFile } from 'node:child_process'

/** 单次查询的默认超时：Python 冷启动 + 解析 8 MB JSON 通常 < 400 ms。 */
const DEFAULT_TIMEOUT_MS = 30_000

/** stdout 上限：search-label 大 limit 时可能很大，给到 32 MB。 */
const MAX_BUFFER = 32 * 1024 * 1024

/**
 * 运行一次查询并返回解析后的 JSON。
 *
 * @param options - `{ pythonExe, script, args, timeoutMs }`。
 * @returns 形如 `{ notice, count, results }` 的对象。
 * @throws Error 当解释器缺失、退出码非零或输出不是 JSON。
 */
export function runQuery(options) {
  const { pythonExe, script, args, timeoutMs = DEFAULT_TIMEOUT_MS } = options
  return new Promise((resolve, reject) => {
    execFile(
      pythonExe,
      [script, ...args],
      { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || '').trim() || error.message
          if (error.code === 'ENOENT') {
            reject(new Error(`找不到 Python 解释器「${pythonExe}」：设 RIMWORLD_PYTHON、写本机配置，或确保 python 在 PATH 上`))
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

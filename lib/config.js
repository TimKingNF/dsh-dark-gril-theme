/**
 * 运行期配置的唯一真相源。
 *
 * 配置只存在一个地方：`$DSH_HOME/dsh-dark-gril-theme.json`。
 * 宿主（index.js）与设置卡片（client.js）都走这里定义的键名与校验规则，
 * 页面侧的即时生效走 `POST /dsh-dark-gril-theme/config.json`，
 * 不另开 localStorage 或 profile patch 里的第二份值。
 *
 * 三条约束：
 *   - 只认白名单里的键：写侧丢弃未知键，不让配置文件变成任意读写面。
 *   - 坏值一律不落盘：类型/范围不对的键整条拒收，其余键照常写入。
 *   - 写入是原子的（同目录 tmp + rename），半截文件不会留在磁盘上。
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 配置文件名（在 `$DSH_HOME` 下）。 */
export const CONFIG_FILE_NAME = 'dsh-dark-gril-theme.json'

/** 默认值。阶段一/二的取值原样保留，新增的两个开关默认关。 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  /** 固定播放的素材（assets 目录下的文件名）。 */
  asset: 'idle.webm',
  /** 侧栏/对话区压暗强度，0–1。 */
  sidebarDim: 0.48,
  convDim: 0.54,
  /** 右区光源强度倍率。 */
  glow: 1,
  /** 视频对焦点（object-position），人物偏右。 */
  focusX: 78,
  focusY: 40,
  /** 调试浮窗：开 = 右下角常驻诊断信息。 */
  debug: false,
  /** 打光模式：开 = beautify（撤蒙版、还原素材原本肤色），关 = dark。 */
  beautify: false,
})

/**
 * 每个键的校验规则。`asset` 单独一类：只允许 assets 目录里的裸文件名。
 * @type {Record<string, { kind: 'boolean' | 'number' | 'asset', min?: number, max?: number }>}
 */
const RULES = {
  enabled: { kind: 'boolean' },
  asset: { kind: 'asset' },
  sidebarDim: { kind: 'number', min: 0, max: 1 },
  convDim: { kind: 'number', min: 0, max: 1 },
  glow: { kind: 'number', min: 0, max: 2 },
  focusX: { kind: 'number', min: 0, max: 100 },
  focusY: { kind: 'number', min: 0, max: 100 },
  debug: { kind: 'boolean' },
  beautify: { kind: 'boolean' },
}

/** 配置键清单，顺序与默认值一致。 */
export const CONFIG_KEYS = Object.freeze(Object.keys(DEFAULTS))

/**
 * 配置文件的绝对路径。
 * @param {string} dshHome
 * @returns {string}
 */
export function configPath(dshHome) {
  return path.join(dshHome, CONFIG_FILE_NAME)
}

/**
 * 单个键的合法值；不合法返回 `undefined`。
 * @param {string} key
 * @param {unknown} value
 * @returns {unknown}
 */
function coerce(key, value) {
  const rule = RULES[key]
  if (rule === undefined) return undefined
  if (rule.kind === 'boolean') return typeof value === 'boolean' ? value : undefined
  if (rule.kind === 'asset') {
    if (typeof value !== 'string') return undefined
    // 裸文件名：不允许分隔符与上跳，避免把素材路由变成任意文件读。
    if (!/^[A-Za-z0-9._-]+$/u.test(value) || value === '.' || value === '..') return undefined
    return value
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (typeof rule.min === 'number' && value < rule.min) return undefined
  if (typeof rule.max === 'number' && value > rule.max) return undefined
  return value
}

/**
 * 过滤一次写入：只留下白名单里、值合法的键。
 *
 * 全被拒收时返回空对象——调用方据此回 400，而不是写一次空写。
 *
 * @param {unknown} patch
 * @returns {Record<string, unknown>}
 */
export function sanitizePatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return {}
  /** @type {Record<string, unknown>} */
  const clean = {}
  for (const key of Object.keys(patch)) {
    const value = coerce(key, /** @type {Record<string, unknown>} */ (patch)[key])
    if (value !== undefined) clean[key] = value
  }
  return clean
}

/**
 * 读配置：文件缺失、坏 JSON、坏键都退化成默认值，绝不抛错。
 *
 * @param {string} dshHome
 * @param {(message: string) => void} [onWarn]
 * @returns {Record<string, unknown>}
 */
export function readConfig(dshHome, onWarn) {
  /** @type {Record<string, unknown>} */
  const config = { ...DEFAULTS }
  let raw
  try {
    raw = readFileSync(configPath(dshHome), 'utf8')
  } catch {
    return config
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    if (onWarn) onWarn(`配置解析失败，使用默认值：${String(error)}`)
    return config
  }
  return { ...config, ...sanitizePatch(parsed) }
}

/**
 * 原子写入：先写同目录 tmp，再 rename 覆盖。
 *
 * @param {string} dshHome
 * @param {Record<string, unknown>} config
 * @returns {void}
 */
function writeAtomic(dshHome, config) {
  mkdirSync(dshHome, { recursive: true })
  const target = configPath(dshHome)
  const tmp = `${target}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    renameSync(tmp, target)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      /* tmp 可能压根没建出来 */
    }
    throw error
  }
}

/**
 * 合并一次 patch 并落盘；返回合并后的完整配置。
 *
 * @param {string} dshHome
 * @param {unknown} patch
 * @param {(message: string) => void} [onWarn]
 * @returns {{ rejected: boolean, config: Record<string, unknown> }}
 *   `rejected` 为真表示这次 patch 没有一个键可用（未写盘）。
 */
export function writeConfig(dshHome, patch, onWarn) {
  const clean = sanitizePatch(patch)
  const current = readConfig(dshHome, onWarn)
  if (Object.keys(clean).length === 0) return { rejected: true, config: current }
  const next = { ...current, ...clean }
  writeAtomic(dshHome, next)
  return { rejected: false, config: next }
}

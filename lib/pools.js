/**
 * 态 → 素材桶的映射与桶内抽取规则（纯函数，无 IO，可单测）。
 *
 * 规格见 docs/status.md「态 → 轮播桶」。这里只负责"给定态和上下文，该播哪一段"，
 * 不关心播放器、不关心时间。播放层（runtime/bg.js）在素材边界调 pickNext。
 *
 * 两条硬规则：
 *   - 段数 > 1 的桶，相邻两次不许抽到同一段（不连续重复）；
 *   - 段数 = 1 的桶只能重播，这是规则例外，不是 bug。
 *
 * 2026-11-15 重排：speaking 不再是态，12 段并进 thinking；listening 三段从 approval 挪到 acting
 * （approval 只剩单段 approval.webm）。
 */

/** 素材桶。键名与态名一致，`idleNew` 是"新会话"专用的窄桶。 */
export const POOLS = Object.freeze({
  idleNew: Object.freeze(['idle.webm']),
  idle: Object.freeze(['idle.webm', 'done.webm', 'done-soft.webm', 'done-confirm.webm']),
  thinking: Object.freeze([
    'thinking.webm',
    'speaking.webm',
    'speaking-neutral.webm',
    'speaking-explain.webm',
    'speaking-emphasis.webm',
    'speaking-confident.webm',
    'speaking-confirm.webm',
    'speaking-curious.webm',
    'speaking-happy.webm',
    'speaking-playful.webm',
    'speaking-surprised.webm',
    'speaking-thoughtful.webm',
    'speaking-warm.webm',
  ]),
  acting: Object.freeze(['acting.webm', 'listening.webm', 'listening-focus.webm', 'listening-nod.webm']),
  approval: Object.freeze(['approval.webm']),
})

/** 素材总段数，用来断言"22 段全部投用"。 */
export const ALL_ASSETS = Object.freeze(
  [...new Set(Object.values(POOLS).flat())].sort(),
)

/**
 * 取某个态该用的桶。
 *
 * @param {string} state 态名（idle / thinking / acting / approval）
 * @param {{ isNewSession?: boolean }} [ctx]
 *   isNewSession：该会话还没跑过任何回合（hero 空白态）。只有这种时候 idle 收窄成单段。
 * @returns {readonly string[]}
 */
export function poolFor(state, ctx) {
  const name = String(state || 'idle')
  if (name === 'idle') {
    return ctx && ctx.isNewSession ? POOLS.idleNew : POOLS.idle
  }
  return POOLS[name] || POOLS.idle
}

/**
 * 桶内抽下一段，保证与上一段不同（桶只有 1 段时只能重复）。
 *
 * 一次抽取就完成，不用"抽中重抽"的循环——那种写法在桶很小时会退化成死循环风险。
 *
 * @param {readonly string[]} pool
 * @param {number} lastIndex 上一段的 index，-1 表示没有上一段
 * @param {() => number} [rng] 返回 [0,1) 的随机源，测试可注入
 * @returns {number}
 */
export function pickNext(pool, lastIndex, rng) {
  const len = Array.isArray(pool) ? pool.length : 0
  if (len <= 1) return 0
  const random = typeof rng === 'function' ? rng : Math.random
  const last = Number.isInteger(lastIndex) ? lastIndex : -1
  if (last < 0 || last >= len) {
    return Math.floor(random() * len)
  }
  // 在"除上一段以外"的 len-1 个位置里均匀取一个，再映射回去。
  const offset = 1 + Math.floor(random() * (len - 1))
  return (last + offset) % len
}

/**
 * 摘掉桶里实际缺失的素材。
 *
 * @param {readonly string[]} pool
 * @param {Set<string>} have
 * @returns {string[]}
 */
export function pruneToAssets(pool, have) {
  if (!Array.isArray(pool)) return []
  return pool.filter((name) => have.has(name))
}

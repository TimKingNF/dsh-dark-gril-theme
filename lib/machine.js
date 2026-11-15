/**
 * 单会话的态判定（纯逻辑，无 IO、无定时器，可单测）。
 *
 * 输入是宿主能拿到的原始信号，输出只有 4 个态名：
 *   idle / thinking / acting / approval
 *
 * 判定优先级（docs/status.md「态判定优先级」）：
 *   1. 有人等我 → approval（硬切）
 *   2. 前台工具跑够 3s → acting
 *   3. 回合在跑 / 输出流开着 / 工具刚起头 → thinking
 *   4. 其余 → idle
 *
 * 2026-11-15 起「在出正文」不再单独成态：speaking 的素材并进 thinking 桶随机轮播，
 * 所以 text-delta 只是"回合还在跑"的一个证据，不再需要 300ms / 8 chunk 的成串阈值。
 *
 * 这个模块自己不看表：每次判定都要传入当前时间 t，定时器与节拍由宿主负责。
 * 好处是整台机器可以在测试里"时间旅行"，不需要真等 3 秒。
 */

/** 工具要跑满多久才算一次 acting 插入机会。 */
export const ACTING_MIN_MS = 3000

/** 所有态名。 */
export const STATES = Object.freeze(['idle', 'thinking', 'acting', 'approval'])

/**
 * 建一台状态机。
 *
 * @param {{ actingMinMs?: number }} [options]
 */
export function createMachine(options) {
  const actingMinMs = Number.isFinite(options?.actingMinMs) ? options.actingMinMs : ACTING_MIN_MS

  let approvalPending = false
  let running = false
  let streamOpen = false
  /** 前台工具的起始时刻；-1 表示没有工具在跑（0 是合法的时刻，不能当哨兵）。 */
  let toolSince = -1

  let state = 'idle'
  let seq = 0
  let changedAt = 0

  function compute(t) {
    if (approvalPending) return 'approval'
    if (toolSince >= 0 && t - toolSince >= actingMinMs) return 'acting'
    if (toolSince >= 0 || streamOpen || running) return 'thinking'
    return 'idle'
  }

  return {
    /** 回合级 running（`agent/status`）。 */
    setRunning(next, t = 0) {
      running = Boolean(next)
      // 回合结束：清掉残留的流状态，避免 idle 被上一个回合的流拖住。
      if (!running) streamOpen = false
      return this.tick(t)
    },

    /** 有人在等我（`approval/request` 发出/决定）。 */
    setApproval(next, t = 0) {
      approvalPending = Boolean(next)
      return this.tick(t)
    },

    /** 前台工具开始真执行（`tools/execute` 进入）。 */
    toolStart(t = 0) {
      toolSince = t
      return this.tick(t)
    },

    /** 前台工具执行结束。 */
    toolEnd(t = 0) {
      toolSince = -1
      return this.tick(t)
    },

    /** 一轮模型输出开始（assistant-stream 的 start 帧）。 */
    streamStart(t = 0) {
      streamOpen = true
      return this.tick(t)
    },

    /** 一轮模型输出结束（assistant-stream 的 end 帧）。 */
    streamEnd(t = 0) {
      streamOpen = false
      return this.tick(t)
    },

    /**
     * 吃一个 `StreamChunk`。
     *
     * 现在不区分 chunk 类型：正文和推理都属于 thinking，chunk 只说明回合还在跑。
     * 保留这个方法是为了不改宿主的接线，内部只重新判一次。
     */
    feedChunk(chunk, t = 0) {
      if (!chunk || typeof chunk !== 'object') return this.tick(t)
      return this.tick(t)
    },

    /**
     * 重算一次。状态没变返回 false，变了返回 true。
     * acting 的阈值只有靠这个节拍才会到点，宿主需要以 ~100ms 频率调用。
     */
    tick(t = 0) {
      const next = compute(t)
      if (next === state) return false
      state = next
      seq += 1
      changedAt = t
      return true
    },

    /** 当前快照，可直接进 JSON。 */
    snapshot() {
      return { state, seq, time: changedAt }
    },

    /** 是否还有会自己变化的东西（决定宿主要不要继续打节拍）。 */
    isBusy() {
      return approvalPending || running || toolSince >= 0 || streamOpen
    },

    get state() {
      return state
    },
  }
}

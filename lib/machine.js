/**
 * 单会话的态判定（纯逻辑，无 IO、无定时器，可单测）。
 *
 * 输入是宿主能拿到的原始信号，输出只有 5 个态名：
 *   idle / thinking / speaking / acting / approval
 *
 * 判定优先级（docs/status.md「态判定优先级」）：
 *   1. 有人等我 → approval（硬切）
 *   2. 前台工具跑够 3s → acting
 *   3. 正文流成串 → speaking
 *   4. 推理流成串 / 仍在跑 → thinking
 *   5. 其余 → idle
 *
 * "成串"的阈值不是拍脑袋：`agent/assistant-stream` 逐 chunk 发射且不节流，
 * 单 chunk 不足以下结论，必须攒够 300ms 或 8 个 chunk 才认为真的在出正文/推理。
 *
 * 这个模块自己不看表：每次判定都要传入当前时间 t，定时器与节拍由宿主负责。
 * 好处是整台机器可以在测试里"时间旅行"，不需要真等 3 秒。
 */

/** 工具要跑满多久才算一次 acting 插入机会。 */
export const ACTING_MIN_MS = 3000
/** 单纯按时间累积判定"在出正文/推理"的窗口。 */
export const STREAK_MS = 300
/** 单纯按 chunk 数量判定"在出正文/推理"的阈值。 */
export const STREAK_CHUNKS = 8

/** 所有态名。 */
export const STATES = Object.freeze(['idle', 'thinking', 'speaking', 'acting', 'approval'])

/**
 * 建一台状态机。
 *
 * @param {{ actingMinMs?: number, streakMs?: number, streakChunks?: number }} [options]
 */
export function createMachine(options) {
  const actingMinMs = Number.isFinite(options?.actingMinMs) ? options.actingMinMs : ACTING_MIN_MS
  const streakMs = Number.isFinite(options?.streakMs) ? options.streakMs : STREAK_MS
  const streakChunks = Number.isFinite(options?.streakChunks)
    ? options.streakChunks
    : STREAK_CHUNKS

  let approvalPending = false
  let running = false
  let streamOpen = false
  /** 前台工具的起始时刻；-1 表示没有工具在跑（0 是合法的时刻，不能当哨兵）。 */
  let toolSince = -1
  /** 成串计数：{ start, count }，两种流派互斥。 */
  let textStreak = null
  let reasonStreak = null

  let state = 'idle'
  let seq = 0
  let changedAt = 0

  function qualified(streak, t) {
    if (!streak) return false
    return streak.count >= streakChunks || t - streak.start >= streakMs
  }

  function compute(t) {
    if (approvalPending) return 'approval'
    if (toolSince >= 0 && t - toolSince >= actingMinMs) return 'acting'
    if (qualified(textStreak, t)) return 'speaking'
    if (qualified(reasonStreak, t)) return 'thinking'
    // 还没攒够阈值的流、正在跑回合、工具刚起头：都算 thinking。
    if (toolSince >= 0 || textStreak || reasonStreak || streamOpen || running) return 'thinking'
    return 'idle'
  }

  return {
    /** 回合级 running（`agent/status`）。 */
    setRunning(next, t = 0) {
      running = Boolean(next)
      if (!running) {
        // 回合结束：清掉残留的流状态，避免 idle 被上一个回合的 streak 拖住。
        streamOpen = false
        textStreak = null
        reasonStreak = null
      }
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
      textStreak = null
      reasonStreak = null
      return this.tick(t)
    },

    /** 一轮模型输出结束（assistant-stream 的 end 帧）。 */
    streamEnd(t = 0) {
      streamOpen = false
      // 流一断就清计数：后面是工具执行还是空转，由 toolSince / running 决定。
      textStreak = null
      reasonStreak = null
      return this.tick(t)
    },

    /**
     * 吃一个 `StreamChunk`。
     * 只认 text-delta / reasoning-delta / tool-call-delta 三种；其余不改变判定。
     */
    feedChunk(chunk, t = 0) {
      if (!chunk || typeof chunk !== 'object') return this.tick(t)
      switch (chunk.type) {
        case 'text-delta':
          if (!textStreak) textStreak = { start: t, count: 0 }
          textStreak.count += 1
          reasonStreak = null
          break
        case 'reasoning-delta':
          if (!reasonStreak) reasonStreak = { start: t, count: 0 }
          reasonStreak.count += 1
          textStreak = null
          break
        case 'tool-call-delta':
          // 模型在写工具参数：既不是说话也不是思考，交给工具执行阶段决定画面。
          textStreak = null
          reasonStreak = null
          break
        default:
          break
      }
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
      return approvalPending || running || toolSince >= 0 || Boolean(textStreak) || Boolean(reasonStreak) || streamOpen
    },

    get state() {
      return state
    },
  }
}

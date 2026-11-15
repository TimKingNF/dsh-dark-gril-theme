/**
 * 单会话的态判定（纯逻辑，无 IO、无定时器，可单测）。
 *
 * 输入是宿主能拿到的原始信号，输出只有 5 个态名：
 *   idle / thinking / acting / approval / done
 *
 * 判定优先级（docs/status.md「态判定优先级」）：
 *   1. 有人等我（审批 / 提问） → approval（硬切）
 *   2. 前台工具跑够 3s → acting
 *   3. 回合在跑 / 输出流开着 / 工具刚起头 → thinking
 *   4. 回合刚结束、还在收尾窗口内 → done
 *   5. 其余 → idle
 *
 * 2026-11-15 修订 #10：「在出正文」不再单独成态，speaking 的素材并进 thinking 桶。
 * 修订 #11：「等你回答」并入 approval（提问与审批在画面上是同一种"卡住等人"），
 * 回合结束后的 done 重新成为确定态而不是 idle 池里的随机一段。
 *
 * 这个模块自己不看表：每次判定都要传入当前时间 t，定时器与节拍由宿主负责。
 * 好处是整台机器可以在测试里"时间旅行"，不需要真等 3 秒或 6 秒。
 */

/** 工具要跑满多久才算一次 acting 插入机会。 */
export const ACTING_MIN_MS = 3000

/** 回合结束后的「刚答完」窗口：够让一段 done 素材完整播一遍。 */
export const DONE_HOLD_MS = 6000

/** 所有态名。 */
export const STATES = Object.freeze(['idle', 'thinking', 'acting', 'approval', 'done'])

/**
 * 建一台状态机。
 *
 * @param {{ actingMinMs?: number, doneHoldMs?: number }} [options]
 */
export function createMachine(options) {
  const actingMinMs = Number.isFinite(options?.actingMinMs) ? options.actingMinMs : ACTING_MIN_MS
  const doneHoldMs = Number.isFinite(options?.doneHoldMs) ? options.doneHoldMs : DONE_HOLD_MS

  let approvalPending = false
  let questionPending = false
  let running = false
  let streamOpen = false
  /** 前台工具的起始时刻；-1 表示没有工具在跑（0 是合法的时刻，不能当哨兵）。 */
  let toolSince = -1
  /** 回合结束时刻 + 窗口；0 表示没有在收尾。 */
  let doneUntil = 0

  let state = 'idle'
  let seq = 0
  let changedAt = 0

  function compute(t) {
    if (approvalPending || questionPending) return 'approval'
    if (toolSince >= 0 && t - toolSince >= actingMinMs) return 'acting'
    if (toolSince >= 0 || streamOpen || running) return 'thinking'
    if (doneUntil > 0 && t < doneUntil) return 'done'
    return 'idle'
  }

  return {
    /** 回合级 running（`agent/status`）。回合结束会开一段 done 收尾窗口。 */
    setRunning(next, t = 0) {
      const wasRunning = running
      running = Boolean(next)
      if (running) {
        // 回合又起来了：收尾窗口立即作废。
        doneUntil = 0
      } else {
        // 回合结束：清掉残留的流状态，避免 idle 被上一个回合的流拖住。
        streamOpen = false
        if (wasRunning) doneUntil = t + doneHoldMs
      }
      return this.tick(t)
    },

    /** 权限审批在等我（`approval/request` 发出/决定）。 */
    setApproval(next, t = 0) {
      approvalPending = Boolean(next)
      return this.tick(t)
    },

    /** 提问在等我回答（`user-questions/request` 发出/回答）。与审批同属 approval 态。 */
    setQuestion(next, t = 0) {
      questionPending = Boolean(next)
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
     * acting 的 3s 门槛与 done 的收尾窗口都只有靠这个节拍才会到点，
     * 宿主需要以 ~100ms 频率调用。
     */
    tick(t = 0) {
      if (doneUntil > 0 && t >= doneUntil) doneUntil = 0
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
      return approvalPending || questionPending || running || toolSince >= 0 || streamOpen || doneUntil > 0
    },

    get state() {
      return state
    },
  }
}

/**
 * 宿主侧状态服务：把 DSH 的事件流压成「每个会话一个态」，并广播给页面。
 *
 * 三件事：
 *   ① 订阅原始信号（`agent/status`、`agent/assistant-stream`、`tools/execute`、
 *      `approval/request`、`user-questions/request`），按 agent 各开一台 lib/machine.js 的机器；
 *   ② 用 100ms 节拍推进"靠时间到点"的判定（主要是 acting 的 3s 门槛），
 *      没有机器在忙时自动停表，不留空转定时器；
 *   ③ 状态真变了才广播——`agent/assistant-stream` 是逐 chunk 发射且不节流，
 *      但这里只在态切换时推一次，所以 SSE 流量与 chunk 速率无关。
 *
 * 两条不能省的边界：
 *   - `tools/execute` 与 `approval/request` 是 waterfall，**必须把 next() 的返回值
 *     原样返回**，否则工具/审批链会卡死。观察逻辑一律包在 try/finally 里。
 *   - 这个文件不吞任何异常，但也不许把异常抛给宿主：出问题只 warn，画面回落到
 *     polling 兜底。
 */
import { createMachine } from './machine.js'
import { poolName } from './pools.js'

/** 节拍：够细到能抓住 3s 门槛，又不至于让定时器抢 CPU。 */
const TICK_MS = 100

/**
 * @param {any} ctx 宿主插件上下文
 * @param {{ warn?: (message: string) => void, tickMs?: number }} [options]
 * @returns {{ snapshot: () => object, subscribe: (fn: (snapshot: object) => void) => () => void }}
 */
export function installStateService(ctx, options = {}) {
  const warn = typeof options.warn === 'function' ? options.warn : () => {}
  const tickMs = Number.isFinite(options.tickMs) ? options.tickMs : TICK_MS

  /** Agent 对象 → { id, machine, sawRunning }。WeakMap 不阻碍 agent 回收。 */
  const entries = new WeakMap()
  /** 已登记的 agent，按活跃顺序保留 id 与态，供快照列出多会话。 */
  const roster = new Map()
  let nextId = 1
  let lastActiveId = 0
  let seq = 0
  let lastKey = ''
  let timer = null
  const listeners = new Set()

  function now() {
    return Date.now()
  }

  /** @param {any} agent */
  function entryFor(agent) {
    if (!agent || typeof agent !== 'object') return null
    let entry = entries.get(agent)
    if (!entry) {
      const id = nextId++
      entry = { id, machine: createMachine(), sawRunning: false }
      entries.set(agent, entry)
      roster.set(id, entry)
    }
    lastActiveId = entry.id
    return entry
  }

  /**
   * 屏幕上只有一块背景，所以多 agent 要合成一个态。
   *
   * 规则：approval 压一切（无论哪个 agent 在等人）；acting 只认当前会话那一台
   * （子 agent 在跑工具不该抢画面）；其余只要有 agent 在忙就是 thinking
   * （子 agent 跑起来时主会话可能一声不响，画面不能停在 idle）；收尾窗口同理。
   */
  function aggregateState(current) {
    let acting = false
    let thinking = false
    let done = current ? current.machine.state === 'done' : false
    for (const entry of roster.values()) {
      const name = entry.machine.state
      if (name === 'approval') return 'approval'
      if (name === 'acting') acting = true
      else if (name === 'thinking') thinking = true
      else if (name === 'done') done = true
    }
    if (current && current.machine.state === 'acting') return 'acting'
    if (acting || thinking) return 'thinking'
    if (done) return 'done'
    return 'idle'
  }

  function snapshot() {
    const current = lastActiveId > 0 ? roster.get(lastActiveId) : null
    const agents = []
    for (const entry of roster.values()) {
      const state = entry.machine.snapshot()
      agents.push({ id: entry.id, state: state.state, busy: entry.machine.isBusy() })
    }
    const currentState = current ? aggregateState(current) : null
    // 还没跑过任何回合的会话 = hero 空白态，idle 只播单段。
    const isNew = current ? !current.sawRunning : false
    return {
      seq,
      time: now(),
      current: current
        ? {
            state: currentState,
            isNew,
            // 桶名也由宿主算：页面侧不再复刻 poolFor 的收窄规则。
            pool: poolName(currentState, { isNewSession: isNew }),
          }
        : null,
      agents,
    }
  }

  /** 只有态或"新会话"标记变了才广播。 */
  function publish() {
    const snap = snapshot()
    const key = `${snap.current ? `${snap.current.state}:${snap.current.isNew}` : '-'}|${snap.agents
      .map((a) => `${a.id}:${a.state}`)
      .join(',')}`
    if (key === lastKey) return
    lastKey = key
    seq += 1
    snap.seq = seq
    for (const listener of listeners) {
      try {
        listener(snap)
      } catch (error) {
        warn(`状态广播失败（已跳过该订阅者）：${String(error)}`)
        listeners.delete(listener)
      }
    }
  }

  function tickAll() {
    const t = now()
    for (const entry of roster.values()) entry.machine.tick(t)
    publish()
    if (!someBusy()) stopTimer()
  }

  function someBusy() {
    for (const entry of roster.values()) if (entry.machine.isBusy()) return true
    return false
  }

  function startTimer() {
    if (timer !== null) return
    timer = setInterval(tickAll, tickMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  function stopTimer() {
    if (timer === null) return
    clearInterval(timer)
    timer = null
  }

  /** 每次动过机器后就地判定：变了就广播，没变但还在忙就保证节拍在跑。 */
  function settle() {
    publish()
    if (someBusy()) startTimer()
    else stopTimer()
  }

  // ── 信号接线 ──
  ctx.on('agent/status', (payload) => {
    try {
      const entry = entryFor(payload?.agent)
      if (!entry) return
      const running = payload?.status === 'running'
      if (running) entry.sawRunning = true
      entry.machine.setRunning(running, now())
      settle()
    } catch (error) {
      warn(`agent/status 处理失败：${String(error)}`)
    }
  })

  ctx.on('agent/assistant-stream', (payload) => {
    try {
      const entry = entryFor(payload?.agent)
      const frame = payload?.frame
      if (!entry || !frame) return
      const t = now()
      // chunk 不再参与判定：正文与推理都只说明回合还在跑，态由 tick 与 start/end 决定。
      if (frame.type === 'start') entry.machine.streamStart(t)
      else if (frame.type === 'end') entry.machine.streamEnd(t)
      else return
      settle()
    } catch (error) {
      warn(`agent/assistant-stream 处理失败：${String(error)}`)
    }
  })

  // waterfall：必须原样返回 next() 的结果。
  ctx.on('tools/execute', async (exec, next) => {
    if (typeof next !== 'function') return undefined
    let entry = null
    try {
      entry = entryFor(exec?.agent)
      if (entry) {
        entry.machine.toolStart(now())
        settle()
      }
    } catch (error) {
      warn(`tools/execute 前置观察失败：${String(error)}`)
    }
    try {
      return await next()
    } finally {
      try {
        if (entry) {
          entry.machine.toolEnd(now())
          settle()
        }
      } catch (error) {
        warn(`tools/execute 后置观察失败：${String(error)}`)
      }
    }
  })

  // waterfall：必须原样返回 next() 的结果，否则审批链卡死。
  ctx.on('approval/request', async (req, next) => {
    if (typeof next !== 'function') return undefined
    let entry = null
    try {
      entry = entryFor(req?.agent)
      if (entry) {
        entry.machine.setApproval(true, now())
        settle()
      }
    } catch (error) {
      warn(`approval/request 前置观察失败：${String(error)}`)
    }
    try {
      return await next()
    } finally {
      try {
        if (entry) {
          entry.machine.setApproval(false, now())
          settle()
        }
      } catch (error) {
        warn(`approval/request 后置观察失败：${String(error)}`)
      }
    }
  })

  // waterfall：提问与审批同属「卡住等人」，必须原样返回 next()，否则问答链卡死。
  ctx.on('user-questions/request', async (request, next) => {
    if (typeof next !== 'function') return undefined
    let entry = null
    try {
      entry = entryFor(request?.agent)
      // 没有 agent 归属时记在当前活跃的那台上，别把画面漏成 idle。
      if (!entry && lastActiveId > 0) entry = roster.get(lastActiveId)
      if (entry) {
        entry.machine.setQuestion(true, now())
        settle()
      }
    } catch (error) {
      warn(`user-questions/request 前置观察失败：${String(error)}`)
    }
    try {
      return await next()
    } finally {
      try {
        if (entry) {
          entry.machine.setQuestion(false, now())
          settle()
        }
      } catch (error) {
        warn(`user-questions/request 后置观察失败：${String(error)}`)
      }
    }
  })

  ctx.effect(() => () => {
    stopTimer()
    listeners.clear()
  })

  return {
    snapshot,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

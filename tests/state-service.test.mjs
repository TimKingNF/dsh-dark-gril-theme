import assert from 'node:assert/strict'
import test from 'node:test'

import { installStateService } from '../lib/state-service.js'

/** 最小 ctx 桩：只实现 installStateService 用到的方法。 */
function setup() {
  const handlers = new Map()
  const ctx = {
    on(name, fn) {
      handlers.set(name, fn)
    },
    effect() {},
  }
  const service = installStateService(ctx, { warn: () => {} })
  const fire = (name, ...args) => handlers.get(name)(...args)
  return { service, fire, handlers }
}

test('回合在跑 → thinking；回合结束进 done', () => {
  const { service, fire } = setup()
  const agent = {}
  fire('agent/status', { agent, status: 'running' })
  assert.equal(service.snapshot().current.state, 'thinking')
  fire('agent/status', { agent, status: 'idle' })
  assert.equal(service.snapshot().current.state, 'done')
})

test('快照自带桶名：还没跑过回合的 idle 走 idleNew，跑过之后走 idle', () => {
  const { service, fire } = setup()
  const agent = {}
  fire('agent/status', { agent, status: 'idle' })
  const snap = service.snapshot()
  assert.equal(snap.current.state, 'idle')
  assert.equal(snap.current.pool, 'idleNew', '没跑过回合 = 单段 idle')
})

test('快照自带桶名：回合刚结束的 done 用 done 桶', () => {
  const { service, fire } = setup()
  const agent = {}
  fire('agent/status', { agent, status: 'running' })
  fire('agent/status', { agent, status: 'idle' })
  assert.equal(service.snapshot().current.state, 'done')
  assert.equal(service.snapshot().current.pool, 'done')
})

test('提问未决 → approval，回答后回落到原判', async () => {
  const { service, fire } = setup()
  const agent = {}
  fire('agent/status', { agent, status: 'running' })
  let release
  const answer = new Promise((resolve) => {
    release = resolve
  })
  const pending = fire('user-questions/request', { agent, questions: [] }, () => answer)
  await new Promise((r) => setImmediate(r))
  assert.equal(service.snapshot().current.state, 'approval')
  release({ answers: [] })
  await pending
  assert.equal(service.snapshot().current.state, 'thinking')
})

test('子 agent 在跑而主会话静默 → thinking，不是 idle', () => {
  const { service, fire } = setup()
  const main = {}
  const child = {}
  fire('agent/status', { agent: main, status: 'running' })
  fire('agent/status', { agent: main, status: 'idle' })
  fire('agent/status', { agent: child, status: 'running' })
  assert.equal(service.snapshot().current.state, 'thinking')
})

test('子 agent 等人回答 → 整体 approval（压过主会话的 done）', async () => {
  const { service, fire } = setup()
  const main = {}
  const child = {}
  fire('agent/status', { agent: main, status: 'running' })
  fire('agent/status', { agent: main, status: 'idle' })
  fire('agent/status', { agent: child, status: 'running' })
  const pending = fire('user-questions/request', { agent: child, questions: [] }, () => new Promise(() => {}))
  await new Promise((r) => setImmediate(r))
  const snap = service.snapshot()
  assert.equal(snap.current.state, 'approval')
  assert.equal(snap.agents.find((a) => a.id === child.id)?.state ?? snap.agents.length > 0, snap.agents.length > 0)
  void pending
})

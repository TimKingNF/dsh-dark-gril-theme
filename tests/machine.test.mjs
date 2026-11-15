import assert from 'node:assert/strict'
import test from 'node:test'

import { ACTING_MIN_MS, STATES, createMachine } from '../lib/machine.js'

/** 造一串 chunk。 */
function chunks(n, type = 'text-delta') {
  const out = []
  for (let i = 0; i < n; i += 1) out.push({ type, index: 0, text: 'x' })
  return out
}

test('初始态是 idle，且 seq 从 0 起', () => {
  const m = createMachine()
  assert.equal(m.state, 'idle')
  assert.deepEqual(m.snapshot(), { state: 'idle', seq: 0, time: 0 })
})

test('态词表只有 4 个，speaking 已退休', () => {
  assert.deepEqual([...STATES], ['idle', 'thinking', 'acting', 'approval'])
  assert.ok(!STATES.includes('speaking'))
})

test('正文 chunk 与推理 chunk 一样都算 thinking', () => {
  const m = createMachine()
  m.setRunning(true, 0)
  assert.equal(m.state, 'thinking')
  for (const chunk of chunks(1, 'reasoning-delta')) m.feedChunk(chunk, 10)
  assert.equal(m.state, 'thinking')
  for (const chunk of chunks(1, 'text-delta')) m.feedChunk(chunk, 20)
  assert.equal(m.state, 'thinking')
})

test('正文流再长也不会切出第二个态', () => {
  const m = createMachine()
  m.setRunning(true, 0)
  const seen = new Set()
  for (let i = 0; i < 40; i += 1) {
    m.feedChunk({ type: 'text-delta', index: 0, text: 'x' }, 100 + i * 50)
    seen.add(m.state)
  }
  assert.deepEqual([...seen], ['thinking'])
})

test('工具不到 3s 不登记 acting，到点才切', () => {
  const m = createMachine()
  m.setRunning(true, 0)
  m.toolStart(0)
  assert.equal(m.state, 'thinking', '刚起头不算 acting')
  assert.equal(m.tick(ACTING_MIN_MS - 1), false)
  assert.equal(m.state, 'thinking')
  assert.equal(m.tick(ACTING_MIN_MS), true)
  assert.equal(m.state, 'acting')
})

test('工具结束回落到 running 决定的 thinking', () => {
  const m = createMachine()
  m.setRunning(true, 0)
  m.toolStart(0)
  m.tick(ACTING_MIN_MS)
  assert.equal(m.state, 'acting')
  m.toolEnd(ACTING_MIN_MS + 1)
  assert.equal(m.state, 'thinking')
  m.setRunning(false, ACTING_MIN_MS + 2)
  assert.equal(m.state, 'idle')
})

test('approval 压过一切，决定后回到原来的判定', () => {
  const m = createMachine()
  m.setRunning(true, 0)
  m.toolStart(0)
  m.tick(ACTING_MIN_MS)
  assert.equal(m.state, 'acting')

  m.setApproval(true, ACTING_MIN_MS + 10)
  assert.equal(m.state, 'approval')
  // 审批期间来什么都压不过
  for (const chunk of chunks(20)) m.feedChunk(chunk, 100)
  assert.equal(m.state, 'approval')

  m.setApproval(false, ACTING_MIN_MS + 20)
  assert.equal(m.state, 'acting')
})

test('流断掉之后回 thinking，回合没结束就不落 idle', () => {
  const m = createMachine()
  m.setRunning(true, 0)
  m.streamStart(1)
  for (const chunk of chunks(20)) m.feedChunk(chunk, 2)
  assert.equal(m.state, 'thinking')
  m.streamEnd(50)
  assert.equal(m.state, 'thinking', '回合还没完，回 thinking')
  m.setRunning(false, 60)
  assert.equal(m.state, 'idle')
})

test('tool-call-delta 不改变判定', () => {
  const m = createMachine()
  m.setRunning(true, 0)
  m.feedChunk({ type: 'tool-call-delta', index: 1, id: 'c1', argumentsDelta: '{' }, 30)
  assert.equal(m.state, 'thinking')
})

test('seq 只在态变化时递增', () => {
  const m = createMachine()
  m.setRunning(true, 0)
  const after = m.snapshot().seq
  assert.equal(m.tick(100), false)
  assert.equal(m.snapshot().seq, after)
  m.setApproval(true, 200)
  assert.equal(m.snapshot().seq, after + 1)
  assert.equal(m.snapshot().time, 200)
})

test('isBusy 只在还有自变因素时成立', () => {
  const m = createMachine()
  assert.equal(m.isBusy(), false)
  m.setRunning(true, 0)
  assert.equal(m.isBusy(), true)
  m.setRunning(false, 1)
  assert.equal(m.isBusy(), false)
  m.toolStart(2)
  assert.equal(m.isBusy(), true)
  m.toolEnd(3)
  assert.equal(m.isBusy(), false)
  m.streamStart(4)
  assert.equal(m.isBusy(), true)
  m.streamEnd(5)
  assert.equal(m.isBusy(), false)
})

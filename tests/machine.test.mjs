import assert from 'node:assert/strict'
import test from 'node:test'

import { ACTING_MIN_MS, DONE_HOLD_MS, STATES, createMachine } from '../lib/machine.js'

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

test('态词表 5 个：speaking 退休，done 回来', () => {
  assert.deepEqual([...STATES], ['idle', 'thinking', 'acting', 'approval', 'done'])
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

test('工具结束回 thinking，回合结束后进 done，过窗口落 idle', () => {
  const m = createMachine()
  m.setRunning(true, 0)
  m.toolStart(0)
  m.tick(ACTING_MIN_MS)
  assert.equal(m.state, 'acting')
  m.toolEnd(ACTING_MIN_MS + 1)
  assert.equal(m.state, 'thinking')
  m.setRunning(false, ACTING_MIN_MS + 2)
  assert.equal(m.state, 'done', '回合刚结束是确定态，不是随机 idle 段')
  assert.equal(m.tick(ACTING_MIN_MS + 2 + DONE_HOLD_MS - 1), false)
  assert.equal(m.tick(ACTING_MIN_MS + 2 + DONE_HOLD_MS), true)
  assert.equal(m.state, 'idle')
})

test('done 窗口里回合重新开始，窗口立即作废', () => {
  const m = createMachine()
  m.setRunning(true, 0)
  m.setRunning(false, 100)
  assert.equal(m.state, 'done')
  m.setRunning(true, 200)
  assert.equal(m.state, 'thinking')
  m.setRunning(false, 300)
  assert.equal(m.state, 'done', '第二次结束时重新开窗口')
})

test('从没跑过就收到 running=false，不进 done', () => {
  const m = createMachine()
  m.setRunning(false, 0)
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
  for (const chunk of chunks(20)) m.feedChunk(chunk, 100)
  assert.equal(m.state, 'approval')

  m.setApproval(false, ACTING_MIN_MS + 20)
  assert.equal(m.state, 'acting')
})

test('提问与审批同属 approval：等回答期间压过 acting 与 done', () => {
  const m = createMachine()
  m.setRunning(true, 0)
  m.toolStart(0)
  m.tick(ACTING_MIN_MS)
  m.setQuestion(true, ACTING_MIN_MS + 5)
  assert.equal(m.state, 'approval')
  m.setQuestion(false, ACTING_MIN_MS + 6)
  assert.equal(m.state, 'acting')

  m.toolEnd(ACTING_MIN_MS + 7)
  m.setRunning(false, ACTING_MIN_MS + 8)
  assert.equal(m.state, 'done')
  m.setQuestion(true, ACTING_MIN_MS + 9)
  assert.equal(m.state, 'approval')
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
  assert.equal(m.state, 'done')
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

test('isBusy 只在还有自变因素时成立（done 窗口也算）', () => {
  const m = createMachine()
  assert.equal(m.isBusy(), false)
  m.setRunning(true, 0)
  assert.equal(m.isBusy(), true)
  m.setRunning(false, 1)
  assert.equal(m.isBusy(), true, 'done 窗口要靠节拍才会到点')
  m.tick(1 + DONE_HOLD_MS)
  assert.equal(m.isBusy(), false)
  m.setQuestion(true, 10)
  assert.equal(m.isBusy(), true)
  m.setQuestion(false, 11)
  assert.equal(m.isBusy(), false)
})

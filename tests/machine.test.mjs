import assert from 'node:assert/strict'
import test from 'node:test'

import { ACTING_MIN_MS, STREAK_CHUNKS, STREAK_MS, createMachine } from '../lib/machine.js'

/** 攒够一个流需要的 chunk 序列。 */
function textChunks(n) {
  const out = []
  for (let i = 0; i < n; i += 1) out.push({ type: 'text-delta', index: 0, text: 'x' })
  return out
}

test('初始态是 idle，且 seq 从 0 起', () => {
  const m = createMachine()
  assert.equal(m.state, 'idle')
  assert.deepEqual(m.snapshot(), { state: 'idle', seq: 0, time: 0 })
})

test('单个 reasoning chunk 先算 thinking，攒够阈值仍是 thinking', () => {
  const m = createMachine()
  m.setRunning(true, 0)
  assert.equal(m.state, 'thinking')
  m.feedChunk({ type: 'reasoning-delta', index: 0, text: 'a' }, 10)
  assert.equal(m.state, 'thinking')
  m.feedChunk({ type: 'reasoning-delta', index: 0, text: 'b' }, 20)
  assert.equal(m.state, 'thinking')
})

test('text-delta 攒够 chunk 数就切 speaking', () => {
  const m = createMachine()
  m.setRunning(true, 0)
  for (const chunk of textChunks(STREAK_CHUNKS - 1)) m.feedChunk(chunk, 1)
  assert.notEqual(m.state, 'speaking', '差一个 chunk 不该算成串')
  m.feedChunk({ type: 'text-delta', index: 0, text: 'x' }, 2)
  assert.equal(m.state, 'speaking')
})

test('text-delta 数量不够但时间够，也切 speaking', () => {
  const m = createMachine()
  m.setRunning(true, 0)
  m.feedChunk({ type: 'text-delta', index: 0, text: 'a' }, 0)
  assert.notEqual(m.state, 'speaking')
  m.feedChunk({ type: 'text-delta', index: 0, text: 'b' }, STREAK_MS)
  assert.equal(m.state, 'speaking')
})

test('推理与正文互斥：换成正文流后不再是 reasoning 主导', () => {
  const m = createMachine()
  m.setRunning(true, 0)
  for (let i = 0; i < STREAK_CHUNKS; i += 1) m.feedChunk({ type: 'reasoning-delta', index: 0 }, i)
  assert.equal(m.state, 'thinking')
  for (let i = 0; i < STREAK_CHUNKS; i += 1) m.feedChunk({ type: 'text-delta', index: 0 }, 100 + i)
  assert.equal(m.state, 'speaking')
  // 回到推理流，正文计数必须被清掉
  for (let i = 0; i < STREAK_CHUNKS; i += 1) m.feedChunk({ type: 'reasoning-delta', index: 0 }, 200 + i)
  assert.equal(m.state, 'thinking')
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
  for (let i = 0; i < STREAK_CHUNKS; i += 1) m.feedChunk({ type: 'text-delta', index: 0 }, 100)
  assert.equal(m.state, 'approval')

  m.setApproval(false, ACTING_MIN_MS + 20)
  assert.equal(m.state, 'acting')
})

test('流断掉之后不再假 speaking', () => {
  const m = createMachine()
  m.setRunning(true, 0)
  for (let i = 0; i < STREAK_CHUNKS; i += 1) m.feedChunk({ type: 'text-delta', index: 0 }, i)
  assert.equal(m.state, 'speaking')
  m.streamEnd(50)
  assert.equal(m.state, 'thinking', '回合还没完，回 thinking')
  m.setRunning(false, 60)
  assert.equal(m.state, 'idle')
})

test('tool-call-delta 清掉正文计数，不让 speaking 粘住', () => {
  const m = createMachine()
  m.setRunning(true, 0)
  for (let i = 0; i < STREAK_CHUNKS; i += 1) m.feedChunk({ type: 'text-delta', index: 0 }, i)
  assert.equal(m.state, 'speaking')
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
})

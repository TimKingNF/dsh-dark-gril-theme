import assert from 'node:assert/strict'
import test from 'node:test'

import { ALL_ASSETS, POOLS, pickNext, poolFor, pruneToAssets } from '../lib/pools.js'

test('22 段素材全部进了桶，没有遗漏也没有孤儿片', () => {
  assert.equal(ALL_ASSETS.length, 22)
  assert.ok(ALL_ASSETS.includes('listening-nod.webm'))
  assert.ok(ALL_ASSETS.includes('speaking-warm.webm'))
  assert.ok(ALL_ASSETS.includes('acting.webm'))
})

test('thinking 收 12 段 speaking，acting 收 listening 三段', () => {
  assert.equal(POOLS.thinking.length, 13)
  assert.ok(POOLS.thinking.includes('thinking.webm'))
  assert.ok(POOLS.thinking.includes('speaking-explain.webm'))
  assert.equal(POOLS.acting.length, 4)
  for (const name of ['acting.webm', 'listening.webm', 'listening-focus.webm', 'listening-nod.webm']) {
    assert.ok(POOLS.acting.includes(name), `acting 桶缺 ${name}`)
  }
  assert.equal('speaking' in POOLS, false)
})

test('listening 三段由 acting 与 approval 共用（归属不互斥）', () => {
  for (const name of ['listening.webm', 'listening-focus.webm', 'listening-nod.webm']) {
    assert.ok(POOLS.acting.includes(name), `acting 桶缺 ${name}`)
    assert.ok(POOLS.approval.includes(name), `approval 桶缺 ${name}`)
  }
  assert.ok(POOLS.approval.includes('approval.webm'))
  assert.equal(POOLS.approval.length, 4)
})

test('done 是独立桶；跑过回合的 idle 与它共用三段，新会话只用单段', () => {
  assert.deepEqual([...POOLS.done], ['done.webm', 'done-soft.webm', 'done-confirm.webm'])
  assert.deepEqual([...POOLS.idle], ['idle.webm', 'done.webm', 'done-soft.webm', 'done-confirm.webm'])
  assert.deepEqual([...POOLS.idleNew], ['idle.webm'])
})

test('idle 桶按「是否新会话」分叉：新会话单段，跑过回合后四段轮播', () => {
  assert.deepEqual([...poolFor('idle', { isNewSession: true })], ['idle.webm'])
  assert.deepEqual([...poolFor('idle', { isNewSession: false })], [...POOLS.idle])
  assert.equal(poolFor('idle', { isNewSession: false }).length, 4)
  assert.deepEqual([...poolFor('done', {})], [...POOLS.done])
})

test('未知态回落到 idle 桶，不抛错', () => {
  assert.deepEqual([...poolFor('nonsense', {})], [...POOLS.idle])
})

test('段数 > 1 的桶：任意上一段都不会被连抽', () => {
  const samples = [0, 0.25, 0.5, 0.75, 0.999]
  for (const [name, pool] of Object.entries(POOLS)) {
    if (pool.length <= 1) continue
    for (let last = 0; last < pool.length; last += 1) {
      for (const r of samples) {
        const picked = pickNext(pool, last, () => r)
        assert.notEqual(picked, last, `${name} 桶连抽了第 ${last} 段`)
        assert.ok(picked >= 0 && picked < pool.length, `${name} 桶越界`)
      }
    }
  }
})

test('不连续重复在真实随机下也成立（抽 200 次）', () => {
  for (const [name, pool] of Object.entries(POOLS)) {
    if (pool.length <= 1) continue
    let last = -1
    for (let i = 0; i < 200; i += 1) {
      const picked = pickNext(pool, last)
      if (last >= 0) assert.notEqual(picked, last, `${name} 桶第 ${i} 次连抽`)
      last = picked
    }
  }
})

test('单段桶只能重播，返回 0；done 三段不会连抽同 Index', () => {
  assert.equal(pickNext(POOLS.idleNew, 0), 0)
  assert.notEqual(pickNext(POOLS.done, 0, () => 0), 0)
})

test('13 段的 thinking 桶任意上一段都有别的可抽', () => {
  for (let last = 0; last < POOLS.thinking.length; last += 1) {
    const picked = pickNext(POOLS.thinking, last, () => 0)
    assert.notEqual(picked, last)
  }
})

test('上一段索引越界或缺失时当作首次抽取', () => {
  const pool = POOLS.done
  for (const last of [-1, undefined, null, 99]) {
    const picked = pickNext(pool, last, () => 0)
    assert.ok(picked >= 0 && picked < pool.length)
  }
})

test('pruneToAssets 摘掉缺失段', () => {
  const have = new Set(['idle.webm', 'thinking.webm'])
  assert.deepEqual(pruneToAssets(POOLS.idle, have), ['idle.webm'])
  assert.deepEqual(pruneToAssets(POOLS.idle, new Set(['done.webm'])), ['done.webm'])
  assert.deepEqual(pruneToAssets(POOLS.thinking, have), ['thinking.webm'])
  assert.deepEqual(pruneToAssets(POOLS.acting, have), [])
  const listeningOnly = new Set(['listening.webm', 'listening-focus.webm', 'listening-nod.webm'])
  assert.deepEqual(pruneToAssets(POOLS.approval, listeningOnly), ['listening.webm', 'listening-focus.webm', 'listening-nod.webm'])
  assert.deepEqual(pruneToAssets(POOLS.done, have), [])
})

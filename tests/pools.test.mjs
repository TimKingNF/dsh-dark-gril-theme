import assert from 'node:assert/strict'
import test from 'node:test'

import { ALL_ASSETS, POOLS, pickNext, poolFor, pruneToAssets } from '../lib/pools.js'

test('22 段素材全部进了桶，没有遗漏也没有重复归属错误', () => {
  assert.equal(ALL_ASSETS.length, 22)
  assert.ok(ALL_ASSETS.includes('listening-nod.webm'))
  assert.ok(ALL_ASSETS.includes('speaking-warm.webm'))
  assert.ok(ALL_ASSETS.includes('acting.webm'))
})

test('idle 桶按「是否新会话」分叉', () => {
  assert.deepEqual([...poolFor('idle', { isNewSession: true })], ['idle.webm'])
  const normal = poolFor('idle', { isNewSession: false })
  assert.equal(normal.length, 4)
  assert.ok(normal.includes('done-confirm.webm'))
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

test('单段桶只能重播，返回 0', () => {
  assert.equal(pickNext(POOLS.thinking, 0), 0)
  assert.equal(pickNext(POOLS.acting, 0), 0)
  assert.equal(pickNext(POOLS.idleNew, 0), 0)
})

test('上一段索引越界或缺失时当作首次抽取', () => {
  const pool = POOLS.idle
  for (const last of [-1, undefined, null, 99]) {
    const picked = pickNext(pool, last, () => 0)
    assert.ok(picked >= 0 && picked < pool.length)
  }
})

test('pruneToAssets 摘掉缺失段', () => {
  const have = new Set(['idle.webm', 'thinking.webm'])
  assert.deepEqual(pruneToAssets(POOLS.idle, have), ['idle.webm'])
  assert.deepEqual(pruneToAssets(POOLS.thinking, have), ['thinking.webm'])
  assert.deepEqual(pruneToAssets(POOLS.acting, have), [])
})

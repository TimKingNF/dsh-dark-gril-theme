/**
 * 素材目录解析与跨源判定的离线测试：这两处决定"用包内素材还是用户素材"
 * 与"谁能改配置"，都属于装给别人用之后才会踩的地方。
 *
 * 跑法：node --test tests/assets-dir.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { ASSET_DIR, isSameOriginRequest, resolveAssetDir } from '../index.js'

const roots = []
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'dgt-assets-'))
  roots.push(dir)
  return dir
}
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

test('DSH_HOME 下没有素材目录时用包内 assets', () => {
  const home = scratch()
  assert.equal(resolveAssetDir(home), ASSET_DIR)
})

test('用户目录里没有视频文件时仍然用包内 assets', () => {
  const home = scratch()
  const dir = join(home, 'dsh-dark-gril-theme', 'assets')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'README.md'), 'not a video')
  assert.equal(resolveAssetDir(home), ASSET_DIR)
})

test('用户目录里有 webm 就整目录接管', () => {
  const home = scratch()
  const dir = join(home, 'dsh-dark-gril-theme', 'assets')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'idle.webm'), 'fake')
  assert.equal(resolveAssetDir(home), dir)
})

test('mp4 同样算视频', () => {
  const home = scratch()
  const dir = join(home, 'dsh-dark-gril-theme', 'assets')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'idle.mp4'), 'fake')
  assert.equal(resolveAssetDir(home), dir)
})

test('没有 Origin 头的本地请求放行', () => {
  assert.equal(isSameOriginRequest({ headers: {} }), true)
  assert.equal(isSameOriginRequest({ headers: { host: '127.0.0.1:3082' } }), true)
})

test('Origin 与 Host 一致才放行', () => {
  const headers = { host: '127.0.0.1:3082', origin: 'http://127.0.0.1:3082' }
  assert.equal(isSameOriginRequest({ headers }), true)
  assert.equal(isSameOriginRequest({ headers: { host: '127.0.0.1:3082', origin: 'http://evil.example' } }), false)
  assert.equal(isSameOriginRequest({ headers: { host: '127.0.0.1:3082', origin: 'not a url' } }), false)
})

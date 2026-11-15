import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CONFIG_FILE_NAME, DEFAULTS, configPath, readConfig, sanitizePatch, writeConfig } from '../lib/config.js'

function home() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dgt-config-'))
  return {
    dir,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('默认值里两个开关都是关', () => {
  assert.equal(DEFAULTS.debug, false)
  assert.equal(DEFAULTS.beautify, false)
  assert.equal(DEFAULTS.enabled, true)
})

test('只收白名单里的合法键', () => {
  const clean = sanitizePatch({
    beautify: true,
    debug: false,
    nope: 1,
    sidebarDim: 0.4,
    convDim: 'x',
    glow: NaN,
    focusX: 140,
    asset: '../etc/passwd',
  })
  assert.deepEqual(clean, { beautify: true, debug: false, sidebarDim: 0.4 })
})

test('非法值不落盘，合法值照写', () => {
  const h = home()
  try {
    writeConfig(h.dir, { beautify: true, convDim: 2 })
    const saved = JSON.parse(readFileSync(configPath(h.dir), 'utf8'))
    assert.equal(saved.beautify, true)
    assert.equal(saved.convDim, DEFAULTS.convDim)
  } finally {
    h.dispose()
  }
})

test('一次只改一个键，其余键保持', () => {
  const h = home()
  try {
    writeConfig(h.dir, { beautify: true })
    writeConfig(h.dir, { debug: true })
    const config = readConfig(h.dir)
    assert.equal(config.beautify, true)
    assert.equal(config.debug, true)
    assert.equal(config.sidebarDim, DEFAULTS.sidebarDim)
  } finally {
    h.dispose()
  }
})

test('一个键都不可用的 patch 不写盘', () => {
  const h = home()
  try {
    const result = writeConfig(h.dir, { unknown: 1 })
    assert.equal(result.rejected, true)
    assert.equal(readdirSync(h.dir).length, 0)
  } finally {
    h.dispose()
  }
})

test('坏 JSON 退化成默认值并报警，不抛错', () => {
  const h = home()
  try {
    writeFileSync(path.join(h.dir, CONFIG_FILE_NAME), '{ broken', 'utf8')
    const warnings = []
    const config = readConfig(h.dir, (message) => warnings.push(message))
    assert.deepEqual(config, { ...DEFAULTS })
    assert.equal(warnings.length, 1)
  } finally {
    h.dispose()
  }
})

test('写入是原子替换，不留 tmp 残片', () => {
  const h = home()
  try {
    writeConfig(h.dir, { beautify: true })
    writeConfig(h.dir, { beautify: false })
    assert.deepEqual(readdirSync(h.dir), [CONFIG_FILE_NAME])
    assert.equal(readConfig(h.dir).beautify, false)
  } finally {
    h.dispose()
  }
})

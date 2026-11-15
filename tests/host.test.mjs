/**
 * 宿主半边的离线测试：不启动 DSH，用一个假的 Cordis ctx 驱动 apply()，
 * 验证三件事——注入行（样式在脚本之前、含视频地址）、Range 语义、素材白名单。
 *
 * 跑法：node --test tests/host.test.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

import { apply, ASSET_DIR, CONFIG_ROUTE, VIDEO_PREFIX, BOOTSTRAP_GLOBAL } from '../index.js'

/** 造一个够用的 ctx：on/inject/effect 三件套。 */
function fakeContext() {
  const events = new EventEmitter()
  const routes = new Map()
  const disposers = []
  const ctx = {
    on: (name, handler) => {
      events.on(name, handler)
      return () => events.off(name, handler)
    },
    // Cordis 的 effect：工厂返回清理函数，插件卸载时调用。
    effect: (factory) => {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    inject: (_names, fn) => {
      const child = {
        effect: (factory) => {
          factory()
        },
        webServer: {
          register: ({ path, handler }) => {
            routes.set(path, handler)
            return () => routes.delete(path)
          },
        },
      }
      fn(child)
    },
  }
  return { ctx, events, routes, disposers }
}

/** 触发一次注入表收集。 */
function collectRows(events) {
  const table = []
  events.emit('webserver/index-inject', table)
  return table
}

/** 极简 res：把写出的内容攒起来，便于断言状态码与头。 */
function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    chunks: [],
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(Buffer.from(String(chunk)))
      this.done = true
    },
    write(chunk) {
      this.chunks.push(Buffer.from(chunk))
    },
  }
}

test('注入行：样式在前、脚本在后，且带视频地址与配置全局名', () => {
  const { ctx, events } = fakeContext()
  apply(ctx)

  const table = collectRows(events)
  assert.equal(table.length, 2)
  assert.equal(table[0].kind, 'style')
  assert.equal(table[1].kind, 'script')
  assert.match(table[0].text, /#svb-stage/u)
  assert.match(table[1].text, /__SVB_INSTALLED__/u)
  assert.ok(table[1].text.includes(BOOTSTRAP_GLOBAL))
  assert.match(table[1].text, /\/dsh-dark-gril-theme\/videos\/idle\.webm/u)
  // 绝不出现 script-src：它在桌面壳上失败会打掉 BOOT_READY
  assert.ok(table.every((row) => row.kind !== 'script-src'))
})

/** 起一个真 http 服务，把插件登记的路由直接接上去——这样 Range 流是真流。 */
async function withServer(routes, run) {
  const server = createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://127.0.0.1').pathname)
    if (!handler) {
      res.statusCode = 404
      res.end()
      return
    }
    handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    await run(origin)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

/** 发一个可带 Range 的请求，把状态、头、正文长度一起收回来。 */
function request(origin, path, { method = 'GET', range } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${origin}${path}`, { method, headers: range ? { range } : {} }, (res) => {
      let length = 0
      res.on('data', (chunk) => {
        length += chunk.length
      })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, length }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('路由：整份 200、Range 206、越界 416、HEAD 无正文、未登记路径 404', async () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)

  await withServer(routes, async (origin) => {
    const assetPath = `${VIDEO_PREFIX}idle.webm`
    const size = statSync(resolve(ASSET_DIR, 'idle.webm')).size

    const whole = await request(origin, assetPath)
    assert.equal(whole.status, 200)
    assert.equal(whole.headers['accept-ranges'], 'bytes')
    assert.equal(whole.headers['content-type'], 'video/webm')
    assert.equal(whole.length, size)

    const partial = await request(origin, assetPath, { range: 'bytes=0-1023' })
    assert.equal(partial.status, 206)
    assert.equal(partial.headers['content-length'], '1024')
    assert.equal(partial.length, 1024)
    assert.match(partial.headers['content-range'], /^bytes 0-1023\/\d+$/u)

    const suffix = await request(origin, assetPath, { range: 'bytes=-100' })
    assert.equal(suffix.status, 206)
    assert.equal(suffix.length, 100)

    const beyond = await request(origin, assetPath, { range: 'bytes=999999999-' })
    assert.equal(beyond.status, 416)

    const head = await request(origin, assetPath, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.length, 0)

    const missing = await request(origin, `${VIDEO_PREFIX}nope.webm`)
    assert.equal(missing.status, 404, '白名单外的文件没有路由')
  })
})

test('配置路由返回 JSON，且默认值可读', () => {
  const { ctx, routes } = fakeContext()
  apply(ctx)
  const handler = routes.get(CONFIG_ROUTE)
  assert.equal(typeof handler, 'function')
  const res = fakeResponse()
  handler({ method: 'GET', headers: {} }, res)
  assert.equal(res.statusCode, 200)
  const parsed = JSON.parse(Buffer.concat(res.chunks).toString('utf8'))
  assert.equal(parsed.asset, 'idle.webm')
  assert.equal(parsed.enabled, true)
})

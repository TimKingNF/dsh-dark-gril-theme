/**
 * 阶段一的联调服务器：把 runtime/ 与 assets/ 以允许跨域的方式发出去，
 * 便于在真实 GUI 页面里注入同一份 CSS/JS 做视觉验收（不装插件、不动 profile）。
 *
 * 用法：node tools/dev-server.mjs [port]
 */
import { createReadStream, readdirSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { POOLS } from '../lib/pools.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = Number(process.argv[2] ?? 3099)

const TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.json': 'application/json; charset=utf-8',
}

const BASE = `http://127.0.0.1:${PORT}/`

/** 在库素材（assets/ 里真实存在的段）；缺段会被客户端从桶里摘掉。 */
function availableAssets() {
  try {
    return readdirSync(path.join(ROOT, 'assets')).filter((name) => name.endsWith('.webm'))
  } catch {
    return []
  }
}

/** 与插件注入的 clientConfig 同形；stateUrl/stateJsonUrl 留空 = 只走手动 setState。 */
function buildConfig() {
  return {
    enabled: true,
    // 联调默认开调试浮窗：定位"状态变了但画面没切"时全靠它。
    debug: true,
    videoPrefix: `${BASE}assets/`,
    pools: POOLS,
    available: availableAssets(),
    stateUrl: '',
    stateJsonUrl: '',
  }
}

const INJECT = `(async () => {
  const base = ${JSON.stringify(BASE)}
  if (globalThis.__DGT_API__) globalThis.__DGT_API__.disable()
  const [css, cfg, js] = await Promise.all([
    fetch(base + 'runtime/bg.css').then((r) => r.text()),
    fetch(base + 'config.json').then((r) => r.json()),
    fetch(base + 'runtime/bg.js').then((r) => r.text()),
  ])
  const style = document.createElement('style')
  style.id = 'dgt-dev-style'
  style.textContent = css
  document.head.appendChild(style)
  globalThis.__DGT__ = cfg
  new Function(js)()
  console.log('[dgt] 已注入，可用 __DGT_API__.setState(态名) 逐态验收')
})()`

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/u, '')

  // 两条虚拟路由：/config.json 把真桶与在库素材合起来发出去，/inject.js
  // 负责把 css/js 一起塞进页面。这样联调只需要在控制台贴一行，不用手写 22 段配置。
  if (relative === 'config.json') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(buildConfig()))
    return
  }
  if (relative === 'inject.js') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
    res.end(INJECT)
    return
  }

  const target = path.resolve(ROOT, relative)
  if (!target.startsWith(ROOT + path.sep)) {
    res.statusCode = 403
    res.end('forbidden')
    return
  }
  let stat
  try {
    stat = statSync(target)
  } catch {
    res.statusCode = 404
    res.end('not found')
    return
  }
  const size = stat.size
  const type = TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream'
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Type', type)

  const range = req.headers.range
  const match = typeof range === 'string' ? /^bytes=(\d*)-(\d*)$/u.exec(range.trim()) : null
  if (match) {
    const start = match[1] === '' ? 0 : Number(match[1])
    const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
    if (start > end || start >= size) {
      res.statusCode = 416
      res.setHeader('Content-Range', `bytes */${size}`)
      res.end()
      return
    }
    res.statusCode = 206
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
    res.setHeader('Content-Length', String(end - start + 1))
    createReadStream(target, { start, end }).pipe(res)
    return
  }

  res.statusCode = 200
  res.setHeader('Content-Length', String(size))
  createReadStream(target).pipe(res)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`dev server: http://127.0.0.1:${PORT}/`)
})

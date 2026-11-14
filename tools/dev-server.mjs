/**
 * 阶段一的联调服务器：把 runtime/ 与 assets/ 以允许跨域的方式发出去，
 * 便于在真实 GUI 页面里注入同一份 CSS/JS 做视觉验收（不装插件、不动 profile）。
 *
 * 用法：node tools/dev-server.mjs [port]
 */
import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = Number(process.argv[2] ?? 3099)

const TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.json': 'application/json; charset=utf-8',
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/u, '')
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

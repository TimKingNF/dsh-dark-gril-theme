/**
 * HTTP 边界的纯函数：Range 解析、Content-Type、包内路径逃逸防护。
 *
 * 刻意不 import 任何 DSH 包，也不 import 任何第三方包 —— 这些逻辑可以脱离宿主单测，
 * 而且插件求值期不会因为依赖解析失败而把 fiber 打成 FAILED。
 */
import path from 'node:path'
import { realpathSync } from 'node:fs'

/**
 * 解析 `Range` 头。
 *
 * `<video>` 会先发 `bytes=0-` 探路，seek 时发具体区间。返回 `null` 表示按整份返回，
 * 返回 `'unsatisfiable'` 表示要回 416。
 *
 * @param {string | undefined | null} header
 * @param {number} size
 * @returns {{ start: number, end: number } | 'unsatisfiable' | null}
 */
export function parseRange(header, size) {
  if (typeof header !== 'string' || header.trim() === '') return null
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim())
  if (match === null) return null
  const rawStart = match[1] ?? ''
  const rawEnd = match[2] ?? ''
  if (rawStart === '' && rawEnd === '') return null

  let start
  let end
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (!Number.isFinite(size) || size <= 0) return 'unsatisfiable'
  if (start > end || start >= size) return 'unsatisfiable'
  return { start, end: Math.min(end, size - 1) }
}

const CONTENT_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
}

/**
 * 按扩展名给出 Content-Type，未知类型回落 octet-stream。
 * @param {string} fileName
 * @returns {string}
 */
export function contentTypeFor(fileName) {
  return CONTENT_TYPES[path.extname(String(fileName)).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * 把相对路径解析到 root 之内，并拒绝任何逃逸。
 *
 * 素材名可以来自配置文件；一个会读文件的插件不能因为配置里写了 `../../.credentials.yaml`
 * 就把宿主的凭据当视频发出去。
 *
 * @param {string} root
 * @param {string} relative
 * @returns {string | null} 绝对路径；逃逸或不存在时 `null`
 */
export function resolveInside(root, relative) {
  const base = realpathSync(root)
  const target = path.resolve(base, relative)
  if (target !== base && !target.startsWith(base + path.sep)) return null
  return target
}

/**
 * 把一段 JSON 嵌进页面脚本时用的序列化（防止 `</script>` 提前闭合）。
 * @param {unknown} value
 * @returns {string}
 */
export function toInlineJson(value) {
  return JSON.stringify(value ?? null)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}
